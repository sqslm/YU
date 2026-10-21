import http from 'node:http'
import https from 'node:https'
import type { ProviderSettings } from '@shared/types'
import {
  SAMPLE_RATE,
  decodeWavPcm16,
  encodeWav,
  pcmDurationMs,
  trimSilencePcm,
  wavDurationMs
} from '../audio/wav'
import { type EncodedAudio, asWav, toOggOpus } from '../audio/transcode'
import { resolveAsrAdapter, runAsrAdapter } from './asr/index'

export interface AsrRequest {
  wav: Uint8Array
  /**
   * Opus copy of the same take, captured by the renderer. Preferred over
   * transcoding the WAV because it needs neither ffmpeg nor a subprocess.
   */
  encoded?: { data: Uint8Array; contentType: string } | null
  model?: string
  language?: string
  prompt?: string
  signal?: AbortSignal
  /**
   * Sink for the `[perf] asr` line. Optional so every existing caller keeps
   * compiling; the default writes to stdout, which is where the pipeline's
   * `[pipeline]` lines already land.
   */
  log?: (line: string) => void
  /** Per-call override of TYPELESS_ASR_TIMEOUT_MS (tests use a small value). */
  timeoutMs?: number
  /** Skip the keep-warm round trip for this call (tests, batch tooling). */
  warm?: boolean
}

import { parseHeaderLines } from './headers'
import { ProviderError } from './providerError'
import { mt } from '@shared/mainI18n'

export { parseHeaderLines }
export { ProviderError }


export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// ---------------------------------------------------------------------------
// Client-side budget
//
// Measured on a local llama.cpp + Qwen3-ASR server (see scripts/asr-perf.mjs):
//   encodeWav        45 µs for 4 s of audio
//   TCP connect      0.5-0.9 ms
//   upload           128 KB ≈ 1 ms on loopback
//   HTTP total       3000-8000 ms   <- all of it is the server
// So everything below is about *not making it worse*: reuse the socket, never
// hang, never pay the model load twice, and log enough to prove where time goes.
// ---------------------------------------------------------------------------

/**
 * Total request budget. 25 s is the ceiling the spec promises (ACC-12 step 2):
 * long enough for a cold model load, short enough that a wedged backend surfaces
 * as a classified alert instead of a pill stuck on 转写中
 * (`TYPELESS_ASR_TIMEOUT_MS` still overrides it).
 */
const DEFAULT_TIMEOUT_MS = 25_000
/** Idle sockets survive long enough to cover back-to-back dictations. */
const KEEP_ALIVE_MS = 60_000
/** Keep the local model resident: `--sleep-idle-seconds` unloads it when idle. */
const DEFAULT_WARM_INTERVAL_MS = 240_000
/** How long a warm-up clip is; enough to load weights, cheap to decode. */
const WARM_AUDIO_MS = 300
/** A trim that saves less than this is not worth the extra encode. */
const MIN_TRIM_MS = 200
/** Consecutive idle warm-ups before the keep-warm loop stops itself. */
const MAX_IDLE_WARMS = 3
/** Retry delay when the keep-warm tick lands in the middle of a take. */
const BUSY_RETRY_MS = 5_000

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function timeoutMsFor(req: AsrRequest): number {
  return req.timeoutMs ?? envInt('TYPELESS_ASR_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
}

/** 'off' | 'all' | 'local' (default): keep the model warm only on this machine. */
function warmMode(): 'off' | 'all' | 'local' {
  const raw = (process.env.TYPELESS_ASR_WARMUP ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return 'off'
  if (raw === 'all' || raw === '1' || raw === 'true') return 'all'
  return 'local'
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

const agents = new Map<string, http.Agent>()

function agentFor(target: URL): http.Agent {
  const key = `${target.protocol}//${target.host}`
  let agent = agents.get(key)
  if (!agent) {
    const options: http.AgentOptions = {
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: 4,
      maxFreeSockets: 4,
      scheduling: 'lifo'
    }
    agent = target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options)
    // Keep idle sockets around for the whole dictation gap (undici/Node default
    // is 5 s, which would rebuild the socket between two takes 10 s apart).
    ;(agent as http.Agent & { keepAliveTimeout?: number }).keepAliveTimeout = KEEP_ALIVE_MS
    agents.set(key, agent)
  }
  return agent
}

/** Drops pooled sockets and pending warm-up timers (test seam + settings reload). */
export function resetAsrRuntime(): void {
  for (const agent of agents.values()) agent.destroy()
  agents.clear()
  opusRejected.clear()
  if (keepWarm.timer) clearTimeout(keepWarm.timer)
  keepWarm.timer = null
  keepWarm.ctx = null
  keepWarm.wav = null
  keepWarm.idleWarms = 0
  inFlight = 0
}

// ---------------------------------------------------------------------------
// Keep-warm
//
// Measured: one 0.3 s clip costs ~2 s on this server, and `--parallel 1` means
// a warm-up queued in front of a take is a straight loss. So nothing is sent
// inline: the timer below re-warms only while the app is idle, and every take
// pushes it back. That keeps a loaded model loaded without ever delaying a take.
// ---------------------------------------------------------------------------

interface WarmContext {
  cfg: ProviderSettings
  model: string
  timeoutMs: number
  log: (line: string) => void
}

const keepWarm: {
  ctx: WarmContext | null
  timer: NodeJS.Timeout | null
  wav: Uint8Array | null
  idleWarms: number
} = { ctx: null, timer: null, wav: null, idleWarms: 0 }

/** Takes in flight; a warm-up must never queue in front of one. */
let inFlight = 0

/**
 * A quiet 440 Hz clip used only to force the server to load/keep its model.
 * Deliberately not pure silence: some servers short-circuit a digital-zero
 * buffer, which would keep the model cold while looking warm.
 */
function warmAudio(): Uint8Array {
  if (keepWarm.wav) return keepWarm.wav
  const samples = Math.round((WARM_AUDIO_MS / 1000) * SAMPLE_RATE)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(1200 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
  }
  keepWarm.wav = encodeWav(pcm)
  return keepWarm.wav
}

interface WireResult {
  status: number
  body: string
  ms: number
  ttfbMs: number
  reused: boolean
}

/**
 * One transcription round trip over a pooled socket.
 *
 * `node:http` instead of `fetch` is deliberate: the global `fetch` dispatcher
 * is not configurable from application code, and several local ASR shims close
 * an idle connection right after the response — reusing it then fails with
 * ECONNRESET. Owning the Agent lets us retry exactly once on a fresh socket
 * (see RETRYABLE) and lets the perf log separate "new socket" from "reused".
 */
function postTranscription(
  target: URL,
  headers: Record<string, string>,
  audio: EncodedAudio,
  fields: Array<[string, string]>,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<WireResult> {
  const boundary = `----typeless${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${audio.filename}"\r\nContent-Type: ${audio.contentType}\r\n\r\n`,
    'utf8'
  )
  const parts: Buffer[] = [Buffer.from('\r\n', 'utf8')]
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8')
    )
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  const tail = Buffer.concat(parts)
  // Zero-copy view over the payload bytes: no Buffer.from(...) duplication.
  const fileBody = Buffer.from(audio.data.buffer as ArrayBuffer, audio.data.byteOffset, audio.data.byteLength)
  const contentLength = fileHead.length + fileBody.length + tail.length

  const request = (attempt: number): Promise<WireResult> =>
    new Promise<WireResult>((resolve, reject) => {
      const started = process.hrtime.bigint()
      const isHttps = target.protocol === 'https:'
      const transport = (isHttps ? https.request : http.request) as typeof http.request
      let timedOut = false
      let ttfbMs = -1

      const req = transport(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          agent: agentFor(target),
          headers: {
            ...headers,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': String(contentLength),
            accept: 'application/json'
          }
        },
        (res) => {
          ttfbMs = Number(process.hrtime.bigint() - started) / 1e6
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            if (body.length < 65536) body += chunk
          })
          res.on('end', () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve({
              status: res.statusCode ?? 0,
              body,
              ms: Number(process.hrtime.bigint() - started) / 1e6,
              ttfbMs,
              reused: req.reusedSocket === true
            })
          })
        }
      )

      const timer = setTimeout(() => {
        timedOut = true
        req.destroy(new Error('ASR_TIMEOUT'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      const onAbort = (): void => {
        req.destroy(new Error('ASR_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      req.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (timedOut) {
          reject(new ProviderError(`ASR timed out after ${timeoutMs} ms (set TYPELESS_ASR_TIMEOUT_MS to raise it)`))
          return
        }
        if (err.message === 'ASR_ABORTED' || signal?.aborted) {
          reject(new ProviderError('ASR request cancelled'))
          return
        }
        // A pooled socket the server already closed: one retry on a fresh one.
        const retryable = err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED'
        if (attempt === 0 && retryable) {
          resolve(request(1))
          return
        }
        reject(err)
      })

      req.write(fileHead)
      req.write(fileBody)
      req.end(tail)
    })

  return request(0)
}

/** Trims trailing/leading silence so the upload carries speech only. */
function prepareUpload(wav: Uint8Array): { wav: Uint8Array; audioMs: number; savedMs: number } {
  const originalMs = wavDurationMs(wav) || Math.round((wav.byteLength / 2 / SAMPLE_RATE) * 1000)
  if ((process.env.TYPELESS_ASR_TRIM ?? '1') === '0') return { wav, audioMs: originalMs, savedMs: 0 }

  const decoded = decodeWavPcm16(wav)
  if (!decoded || decoded.sampleRate !== SAMPLE_RATE) return { wav, audioMs: originalMs, savedMs: 0 }

  const trimmed = trimSilencePcm(decoded.pcm)
  if (trimmed.length === decoded.pcm.length) return { wav, audioMs: originalMs, savedMs: 0 }
  const audioMs = pcmDurationMs(trimmed, decoded.sampleRate)
  if (originalMs - audioMs < MIN_TRIM_MS) return { wav, audioMs: originalMs, savedMs: 0 }

  return { wav: encodeWav(trimmed, decoded.sampleRate), audioMs, savedMs: originalMs - audioMs }
}

function defaultLog(line: string): void {
  // electron main has no window here; stdout is where the pipeline logs land.
  if (process.env.TYPELESS_ASR_LOG === 'off') return
  console.log(line)
}

/**
 * Longest non-JSON body still trusted as a transcript. A recogniser answers a
 * sentence or two; anything longer is a page, not speech.
 */
const MAX_PLAIN_TRANSCRIPT_CHARS = 4000

/** `<!doctype html>`, `<html`, `<?xml`, or any tag at the very start. */
function looksLikeMarkup(text: string): boolean {
  return /^<[!?a-z/]/i.test(text.trimStart())
}

/**
 * Pulls the transcript out of a response body. Gateways disagree: some answer
 * `{text}`, some `{transcript}`, some plain text when `response_format` is
 * ignored — so plain text is still accepted.
 *
 * What is **not** a transcript is a 200 carrying an HTML login or error page. That
 * used to be returned verbatim, then polished by the model and typed into the
 * user's document: the whole page, in their editor. It is rejected instead.
 */
function transcriptFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { text?: string; transcript?: string; result?: string }
    return String(parsed.text ?? parsed.transcript ?? parsed.result ?? '').trim()
  } catch {
    const text = body.trim()
    if (looksLikeMarkup(text) || text.length > MAX_PLAIN_TRANSCRIPT_CHARS) {
      throw new ProviderError(
        mt('语音服务返回了网页而不是转写结果，请检查该服务的地址与密钥'),
        200,
        text.slice(0, 300)
      )
    }
    return text
  }
}

/** Base URLs whose server refused an Ogg/Opus upload; later takes skip the encode. */
const opusRejected = new Set<string>()

/** `TYPELESS_ASR_UPLOAD` overrides the stored preference (used by the tests). */
function uploadMode(preference: 'wav' | 'opus' | undefined): 'wav' | 'opus' {
  const forced = (process.env.TYPELESS_ASR_UPLOAD ?? '').trim()
  if (forced === 'wav' || forced === 'opus') return forced
  // Absent means "an older caller that predates the setting": WAV, the safe side.
  return preference ?? 'wav'
}

/**
 * Picks the wire format for one take. The decision is logged because upload size
 * is the one part of ASR latency the client actually controls — but it must never
 * be the reason a take fails, so anything short of a successful encode falls back
 * to the caller's original WAV.
 */
async function encodeForUpload(
  wav: Uint8Array,
  cfg: { upload?: 'wav' | 'opus'; baseUrl: string },
  log: (line: string) => void,
  captured?: { data: Uint8Array; contentType: string } | null
): Promise<EncodedAudio> {
  // An explicit WAV request beats everything: it is the escape hatch for a
  // backend that rejects every compressed container.
  if (uploadMode(cfg.upload) === 'wav') return asWav(wav)
  if (opusRejected.has(cfg.baseUrl)) return asWav(wav)

  // With compression enabled, prefer Chromium's copy over an ffmpeg subprocess.
  // The WAV retry below still protects a backend that refuses webm.
  if (captured && captured.data.byteLength >= 512) {
    const pct =
      wav.byteLength > 0 ? Math.round((1 - captured.data.byteLength / wav.byteLength) * 100) : 0
    log(`[asr] captured opus ${wav.byteLength} -> ${captured.data.byteLength} bytes (-${pct}%)`)
    return {
      data: captured.data,
      contentType: captured.contentType || 'audio/webm',
      filename: captured.contentType.includes('ogg') ? 'audio.ogg' : 'audio.webm'
    }
  }

  if (uploadMode(cfg.upload) !== 'opus') return asWav(wav)

  const outcome = await toOggOpus(wav)
  if (outcome.ok) {
    const saved = Math.max(0, outcome.bytesBefore - outcome.audio.data.byteLength)
    const pct = outcome.bytesBefore > 0 ? Math.round((saved / outcome.bytesBefore) * 100) : 0
    log(`[asr] opus upload ${outcome.bytesBefore} -> ${outcome.audio.data.byteLength} bytes (-${pct}%)`)
    return outcome.audio
  }
  if (outcome.reason !== 'too-small' && outcome.reason !== 'disabled') {
    log(`[asr] opus skipped (${outcome.reason}${outcome.message ? `: ${outcome.message}` : ''})`)
  }
  return asWav(wav)
}

/**
 * Where the key goes.
 *
 * OpenAI-compatible gateways read `Authorization: Bearer …`; a few vendors
 * (Mistral among them) require `x-api-key` instead, and sending the wrong one
 * is a 401 rather than a helpful error.
 */
function applyAuth(headers: Record<string, string>, cfg: ProviderSettings): void {
  if (!cfg.apiKey) return
  if (cfg.authHeader === 'x-api-key') headers['x-api-key'] = cfg.apiKey
  else headers.Authorization = `Bearer ${cfg.apiKey}`
}

/**
 * Endpoint path for transcription.
 *
 * `requestPath` wins when set: gateways that are not the plain OpenAI shape
 * (Azure deployments, self-hosted forks with a prefix) all differ here and
 * nowhere else, so a hard-coded path would make them unreachable.
 */
function transcriptionPath(cfg: ProviderSettings): string {
  const custom = (cfg.requestPath ?? '').trim().replace(/^\/+/, '')
  return custom || 'audio/transcriptions'
}

/** Cheap request used only to load/keep the model; its transcript is discarded. */
async function warmUp(cfg: ProviderSettings, model: string, timeoutMs: number): Promise<number> {
  const target = new URL(joinUrl(cfg.baseUrl, transcriptionPath(cfg)))
  const headers: Record<string, string> = { ...parseHeaderLines(cfg.extraHeaders) }
  applyAuth(headers, cfg)
  const started = process.hrtime.bigint()
  try {
    const result = await postTranscription(target, headers, asWav(warmAudio()), [['model', model], ['response_format', 'json']], timeoutMs, undefined)
    // A 4xx/5xx (unknown model, server still loading) is not a warm server.
    if (result.status < 200 || result.status >= 300) return -1
  } catch {
    // A failed warm-up must never fail the take: the real request still runs.
    return -1
  }
  return Number(process.hrtime.bigint() - started) / 1e6
}

function keepWarmEnabled(target: URL): boolean {
  const mode = warmMode()
  if (mode === 'off') return false
  if (mode === 'all') return true
  return isLocalHost(target.hostname)
}

/**
 * Arms the idle keep-warm. Arming sends nothing, so a take never waits for it.
 *
 * `resetIdle` is set by a real transcription: it restarts the idle budget so a
 * user who keeps dictating keeps the model loaded indefinitely, while a user
 * who walks away stops the pings after {@link MAX_IDLE_WARMS} rounds.
 */
function armKeepWarm(ctx: WarmContext, delayMs?: number, resetIdle = false): void {
  const target = new URL(joinUrl(ctx.cfg.baseUrl, transcriptionPath(ctx.cfg)))
  if (!keepWarmEnabled(target)) return
  if (resetIdle) keepWarm.idleWarms = 0
  if (keepWarm.idleWarms >= MAX_IDLE_WARMS) return
  const interval = delayMs ?? envInt('TYPELESS_ASR_WARM_INTERVAL_MS', DEFAULT_WARM_INTERVAL_MS)
  if (interval <= 0) return
  keepWarm.ctx = ctx
  if (keepWarm.timer) clearTimeout(keepWarm.timer)
  const timer = setTimeout(onKeepWarmTick, interval)
  if (typeof timer.unref === 'function') timer.unref()
  keepWarm.timer = timer
}

function onKeepWarmTick(): void {
  keepWarm.timer = null
  const ctx = keepWarm.ctx
  if (!ctx) return
  // A take is running: `--parallel 1` would make this warm-up queue in front of
  // the user's audio, so try again shortly instead.
  if (inFlight > 0) {
    armKeepWarm(ctx, BUSY_RETRY_MS)
    return
  }
  void runKeepWarm(ctx)
}

async function runKeepWarm(ctx: WarmContext): Promise<void> {
  const ms = await warmUp(ctx.cfg, ctx.model, ctx.timeoutMs)
  if (ms >= 0) {
    keepWarm.idleWarms += 1
    ctx.log(`[perf] asr warm ms=${ms.toFixed(0)} model=${ctx.model}`)
  }
  armKeepWarm(ctx)
}
/**
 * Speech-to-text through any OpenAI-compatible `/audio/transcriptions`
 * endpoint (OpenAI, Groq, SiliconFlow, FunASR gateways, faster-whisper servers,
 * local llama.cpp shims ...). Nothing here is vendor specific except the shape.
 */
export async function transcribe(
  cfg: ProviderSettings,
  req: AsrRequest
): Promise<{ text: string; model: string }> {
  if (!cfg.baseUrl) throw new ProviderError('ASR base URL is empty')
  const model = req.model || cfg.model

  const log = req.log ?? defaultLog

  /*
    Vendors that are not OpenAI-shaped come first. Nothing below applies to them:
    no multipart field list, no opus guess-and-retry (they each name their own
    container), and no keep-warm ping (a job API has nothing to warm).
  */
  const adapter = resolveAsrAdapter(cfg)
  if (adapter) {
    const started = Date.now()
    try {
      const text = await runAsrAdapter(adapter, cfg, req.wav, {
        model,
        language: req.language,
        signal: req.signal,
        log
      })
      log(`[perf] asr ${Date.now() - started}ms`)
      return { text: text.trim(), model: model || adapter.id }
    } catch (error) {
      // The adapter already speaks in sentences; wrapping it again would double
      // the prefix in the card ("转写失败：转写失败：…").
      throw error instanceof ProviderError ? error : new ProviderError(String(error))
    }
  }

  if (!model) throw new ProviderError('ASR model is empty')

  const timeoutMs = timeoutMsFor(req)
  const warmCtx: WarmContext = { cfg, model, timeoutMs, log }
  const keepWarmOn = req.warm !== false

  // Arming below sends nothing, so a take never waits behind a warm-up request
  // (`--parallel 1` servers would otherwise decode the clip twice).
  inFlight += 1
  try {
    // One encode for one request: nothing here re-encodes the caller's bytes.
    const prepared = prepareUpload(req.wav)
    const fields: Array<[string, string]> = [
      ['model', model],
      ['response_format', 'json']
    ]
    // No `temperature`: some OpenAI-ish gateways reject unknown multipart fields
    // outright (StepFun does), and every transcription model's default is already
    // greedy decoding, so sending it buys nothing and costs compatibility.
    if (req.language) fields.push(['language', req.language])
    if (req.prompt) fields.push(['prompt', req.prompt])

    const headers: Record<string, string> = { ...parseHeaderLines(cfg.extraHeaders) }
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-type' || name.toLowerCase() === 'content-length') delete headers[name]
    }
    applyAuth(headers, cfg)

    const target = new URL(joinUrl(cfg.baseUrl, transcriptionPath(cfg)))
    // The wire format is a compatibility decision, not a preference. `wav` is what
    // every OpenAI-compatible gateway decodes; `opus` is opt-in. Even when it is
    // on, a server that rejects the encoded clip (or answers 200 with an empty
    // transcript) gets one retry as WAV and is remembered, so a wrong guess costs
    // bytes, never a take.
    let upload = await encodeForUpload(prepared.wav, cfg, log, req.encoded)
    let result = await postTranscription(target, headers, upload, fields, timeoutMs, req.signal)
    let text = ''
    if (result.status >= 200 && result.status < 300) {
      try {
        text = transcriptFrom(result.body)
      } catch (error) {
        if (upload.contentType === 'audio/wav') throw error
        // A gateway may return an HTML error page for an unsupported container.
        // Retry the original WAV once; its response is validated normally below.
      }
    }

    const rejected = result.status < 200 || result.status >= 300
    if (upload.contentType !== 'audio/wav' && (rejected || !text)) {
      log(
        `[asr] opus rejected (HTTP ${result.status}${text ? '' : ', empty transcript'}),` +
          ' retrying as WAV'
      )
      opusRejected.add(cfg.baseUrl)
      upload = asWav(prepared.wav)
      result = await postTranscription(target, headers, upload, fields, timeoutMs, req.signal)
      text = result.status >= 200 && result.status < 300 ? transcriptFrom(result.body) : ''
    }

    const rtf = prepared.audioMs > 0 ? result.ms / prepared.audioMs : 0
    log(
      `[perf] asr bytes=${upload.data.byteLength} ms=${result.ms.toFixed(0)} rtf=${rtf.toFixed(2)}` +
        ` audio=${prepared.audioMs}ms trim=${prepared.savedMs}ms ttfb=${result.ttfbMs.toFixed(0)}ms` +
        ` conn=${result.reused ? 'reuse' : 'new'} codec=${upload.contentType}`
    )

    if (result.status < 200 || result.status >= 300) {
      throw new ProviderError(`ASR HTTP ${result.status}`, result.status, result.body.slice(0, 500))
    }

    return { text, model }
  } finally {
    inFlight -= 1
    if (keepWarmOn) armKeepWarm(warmCtx, undefined, true)
  }
}
