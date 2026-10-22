import { createHash, createHmac } from 'node:crypto'
import { SAMPLE_RATE, decodeWavPcm16 } from '../../audio/wav'
import { ProviderError } from '../providerError'
import {
  type AsrAdapterContext,
  type AsrAdapterInput,
  type AsrAdapterSpec,
  bearer,
  failUnless,
  field,
  need,
  pickString,
  request
} from './types'
import { mt } from '@shared/mainI18n'

/**
 * The four Chinese cloud recognisers.
 *
 * None of them speaks the OpenAI multipart shape, and each one is blocked by a
 * *different* thing, which is why they used to be labelled 暂不可直连 in the
 * preset table. That label was honest but useless: the block is mechanical, so
 * it belongs in code.
 *
 * - Aliyun (DashScope) fetches the audio itself. The bytes have to be hosted
 *   first, which is a capability the app cannot invent for the user.
 * - Tencent signs every call with TC3-HMAC-SHA256 over the date, the host and a
 *   hash of the body. A stored Bearer token can never be equivalent.
 * - iFlytek is a WebSocket frame protocol behind an HMAC-signed URL — not even
 *   HTTP.
 * - Baidu mints an OAuth token from a *second* key before every call, then
 *   posts base64 JSON.
 *
 * All four still honour `ctx.baseUrl`, because an account on another region (and
 * the tests) must be able to point the same code at another origin without a
 * second code path.
 */

const ALIYUN_BASE = 'https://dashscope.aliyuncs.com'
const TENCENT_BASE = 'https://asr.tencentcloudapi.com'
const XFYUN_BASE = 'wss://iat-api.xfyun.cn/v2'
const BAIDU_BASE = 'https://vop.baidu.com'
/** Baidu's OAuth endpoint lives on a different host than recognition. */
const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'

/** DashScope queues the job; this is how long a take may wait for it. */
const ALIYUN_TASK_BUDGET_MS = 120_000
/** Poll spacing: DashScope advances a few seconds of audio per interval. */
const ALIYUN_POLL_MS = 500

/** IAT accepts one JSON frame per 40 ms of audio; faster input is dropped. */
const XFYUN_FRAME_MS = 40
/** The whole handshake, upload and decode must fit in this. */
const XFYUN_BUDGET_MS = 120_000

/** Profile base URL, or the vendor's own host when the profile left it empty. */
function origin(ctx: AsrAdapterContext, fallback: string): string {
  return (ctx.baseUrl || fallback).replace(/\/+$/, '')
}

/** Base64 without a copy of the buffer (an audio clip is not free to duplicate). */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** A one-line excerpt of an error body, for a message a human can act on. */
function snippet(body: string, limit = 160): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function httpOk(status: number): boolean {
  return status >= 200 && status < 300
}

/** Sleep that gives up when the take is cancelled, so no timer outlives it. */
function pause(ctx: AsrAdapterContext, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      reject(new ProviderError(mt('等待识别结果时被取消')))
    }
    timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// 阿里云百炼 / DashScope
//
// The async recording endpoint only accepts `file_urls`, never bytes. That is a
// deliberate property of the service (it pulls the object into its own bucket
// and decodes it out of band), so the profile has to name somewhere the file can
// be PUT and then be read back by Aliyun — hence `uploadUrl` being required
// rather than optional tuning.
// ---------------------------------------------------------------------------

async function runAliyun(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  // Qwen Flash is synchronous multimodal audio; only Filetrans/Paraformer use the async URL API.
  if (/^qwen3-asr-flash(?!-filetrans)/.test(input.model)) {
    const audio = `data:audio/wav;base64,${base64(input.wav)}`
    if (input.ms > 300_000 || Buffer.byteLength(audio) > 10 * 1024 * 1024) {
      throw new ProviderError(mt('Qwen ASR Flash 最多支持 5 分钟且编码后不超过 10 MB 的录音'))
    }
    const base = origin(ctx, ALIYUN_BASE).replace(/\/(?:api\/v1|compatible-mode\/v1)$/, '')
    const language = input.language && input.language !== 'auto' ? languageHint(input.language) : ''
    const res = await request(ctx, `${base}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { ...bearer(ctx), 'content-type': 'application/json', ...(field(ctx, 'workspace') ? { 'X-DashScope-WorkSpace': field(ctx, 'workspace') } : {}) },
      body: JSON.stringify({ model: input.model, input: { messages: [{ role: 'user', content: [{ audio }] }] }, parameters: { result_format: 'message', asr_options: { enable_itn: false, ...(language ? { language } : {}) } } })
    }, 60_000)
    failUnless(httpOk(res.status), res.status, res.body, 'Qwen ASR Flash')
    return pickString(res.json, 'output', 'choices', 0, 'message', 'content', 0, 'text').trim()
  }
  const uploadUrl = need(ctx, 'uploadUrl', mt('音频直传地址'))
  const base = origin(ctx, ALIYUN_BASE)
  const auth = bearer(ctx)
  if (!auth.Authorization) throw new ProviderError(mt('阿里云百炼没有填 API Key（设置 → 模型 → 这条配置的「API Key」）'))

  // Put the bytes somewhere DashScope can fetch them. The object's content type
  // is what Aliyun inspects before decoding, so it is set explicitly instead of
  // letting the bucket guess `application/octet-stream`.
  const upload = await request(
    ctx,
    uploadUrl,
    { method: 'PUT', headers: { 'content-type': input.mime || 'audio/wav' }, body: input.wav },
    60_000
  )
  failUnless(httpOk(upload.status), upload.status, upload.body, mt('上传音频'))

  const headers: Record<string, string> = {
    ...auth,
    'content-type': 'application/json',
    // Without this DashScope answers synchronously, which refuses anything past
    // a few seconds of audio instead of queueing it.
    'X-DashScope-Async': 'enable'
  }
  const workspace = field(ctx, 'workspace')
  if (workspace) headers['X-DashScope-WorkSpace'] = workspace

  const submit = await request(
    ctx,
    `${base}/api/v1/services/audio/asr/transcription`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model || 'paraformer-v2',
        input: { file_urls: [uploadUrl] },
        parameters: { language_hints: [languageHint(input.language)] }
      })
    },
    45_000
  )
  failUnless(httpOk(submit.status), submit.status, submit.body, mt('提交 DashScope 任务'))
  const taskId = pickString(submit.json, 'output', 'task_id')
  if (!taskId) throw new ProviderError(mt('DashScope 没有返回 task_id：{{snippet}}', { snippet: snippet(submit.body) }))

  const deadline = Date.now() + ALIYUN_TASK_BUDGET_MS
  let transcriptionUrl = ''
  let failure = ''
  let lastStatus = 'PENDING'
  for (;;) {
    if (ctx.signal.aborted) throw new ProviderError(mt('等待识别结果时被取消'))
    const poll = await request(ctx, `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: auth }, 20_000)
    failUnless(httpOk(poll.status), poll.status, poll.body, mt('查询 DashScope 任务'))
    lastStatus = pickString(poll.json, 'output', 'task_status') || 'PENDING'
    if (lastStatus === 'SUCCEEDED') {
      // The task can succeed while one file failed; the per-file verdict is the
      // one that carries a readable reason.
      const subtask = pickString(poll.json, 'output', 'results', 0, 'subtask_status')
      if (subtask === 'FAILED') {
        failure = pickString(poll.json, 'output', 'results', 0, 'message') || mt('子任务失败')
        break
      }
      transcriptionUrl = pickString(poll.json, 'output', 'results', 0, 'transcription_url')
      break
    }
    if (lastStatus === 'FAILED' || lastStatus === 'CANCELED' || lastStatus === 'UNKNOWN') {
      failure = pickString(poll.json, 'output', 'message') || lastStatus
      break
    }
    if (Date.now() >= deadline) {
      throw new ProviderError(
        mt('DashScope 任务 {{task}} 超时（最后状态 {{status}}）', { task: taskId, status: lastStatus })
      )
    }
    await pause(ctx, ALIYUN_POLL_MS)
  }
  if (failure) throw new ProviderError(mt('DashScope 识别失败：{{failure}}', { failure }))
  if (!transcriptionUrl) throw new ProviderError(mt('DashScope 任务成功但没有 transcription_url'))

  // The result document is a pre-signed object URL: it carries its own auth, so
  // the Bearer header is neither needed nor wanted there.
  const document = await request(ctx, transcriptionUrl, {}, 20_000)
  failUnless(httpOk(document.status), document.status, document.body, mt('下载识别结果'))
  const text = pickString(document.json, 'transcripts', 0, 'text').trim()
  if (!text) throw new ProviderError(mt('DashScope 识别结果里没有文字（transcripts[0].text 为空）'))
  return text
}

/** `language_hints` takes a bare language code; `auto` is not a code. */
function languageHint(language: string): string {
  const value = (language || '').trim().toLowerCase()
  if (!value || value === 'auto') return 'zh'
  return value.split('-')[0]
}

// ---------------------------------------------------------------------------
// 腾讯云 — 一句话识别
//
// Tencent signs every request. The date is part of the HMAC key chain, so the
// credential rotates daily and the body hash is inside the signed string: there
// is no static header that could replace this, which is why the exact algorithm
// lives here rather than behind a generic auth mode.
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest()
}

export interface Tc3Options {
  secretId: string
  secretKey: string
  /** Host header value, i.e. the host that will receive the request. */
  host: string
  /** The exact bytes that go on the wire: the hash covers them. */
  payload: string
  /** Unix seconds; the caller owns the clock so a retry can reuse it. */
  timestamp: number
}

/**
 * Builds the TC3-HMAC-SHA256 `Authorization` header.
 *
 * Four chained HMACs (secretKey -> date -> service -> `tc3_request`) over a
 * canonical request that pins method, path, content-type, host and the payload
 * hash. Exported because it is the one part of this adapter worth testing
 * against an independently written implementation.
 */
export function tc3Authorization(options: Tc3Options): string {
  const { secretId, secretKey, host, payload, timestamp } = options
  const algorithm = 'TC3-HMAC-SHA256'
  const service = 'asr'
  const contentType = 'application/json; charset=utf-8'
  // The date must be the UTC date of `timestamp`, not the local one, or the
  // derived keys differ from the server's by a whole day.
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:${contentType}`,
    `host:${host}`,
    '',
    signedHeaders,
    sha256Hex(payload)
  ].join('\n')
  const scope = `${date}/${service}/tc3_request`
  const stringToSign = [algorithm, String(timestamp), scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), service), 'tc3_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return `${algorithm} Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

async function runTencent(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  const secretId = need(ctx, 'secretId', mt('腾讯云 SecretId'))
  const secretKey = need(ctx, 'secretKey', mt('腾讯云 SecretKey'))
  const region = field(ctx, 'region', 'ap-shanghai')
  const token = field(ctx, 'token')
  const base = origin(ctx, TENCENT_BASE)

  const target = new URL(base)
  if (!target.pathname.endsWith('/')) target.pathname = `${target.pathname}/`

  const payload = JSON.stringify({
    // 16k_zh is the Mandarin model for 16 kHz audio, which is all this client
    // records; the file is already mono PCM16 WAV.
    EngSerViceType: '16k_zh',
    // 1 means "the bytes are in Data". 2 would make Tencent fetch a URL itself.
    SourceType: 1,
    VoiceFormat: 'wav',
    Data: base64(input.wav),
    ProjectId: 0
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    Authorization: tc3Authorization({ secretId, secretKey, host: target.host, payload, timestamp }),
    // Tencent routes on the action header, so there is no per-endpoint path.
    'X-TC-Action': 'SentenceRecognition',
    'X-TC-Version': '2019-06-14',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': region
  }
  if (token) headers['X-TC-Token'] = token

  const result = await request(ctx, target.toString(), { method: 'POST', headers, body: payload }, 60_000)
  failUnless(httpOk(result.status), result.status, result.body, mt('腾讯云识别'))
  const message = pickString(result.json, 'Response', 'Error', 'Message')
  if (message) throw new ProviderError(mt('腾讯云识别失败：{{message}}', { message }))
  const text = pickString(result.json, 'Response', 'Result').trim()
  if (!text) throw new ProviderError(mt('腾讯云没有返回文字：{{snippet}}', { snippet: snippet(result.body) }))
  return text
}

// ---------------------------------------------------------------------------
// 科大讯飞 — 语音听写 (IAT)
//
// A WebSocket, not an HTTP call. The auth is an HMAC over `host`, `date` and the
// request line, carried as base64 in the query string, because the browser-side
// origin of this API never had headers to put a token in.
// ---------------------------------------------------------------------------

/**
 * One IAT frame. `status` 0 opens the session (it must carry `common` and
 * `business`), 1 continues it, 2 closes it.
 */
export interface XfyunFrame {
  status: 0 | 1 | 2
  audio: Uint8Array
}

/**
 * Splits PCM16 into the 40 ms frames IAT expects.
 *
 * IAT drops frames that arrive faster than real time and rejects the session if
 * the first frame has no `common`, so the split matters: a clip shorter than one
 * frame still needs a first frame *and* a terminator.
 */
export function xfyunFrames(pcm: Uint8Array): XfyunFrame[] {
  // 40 ms of the recorder's 16 kHz PCM16 is exactly 1280 bytes.
  const size = (SAMPLE_RATE * 2 * XFYUN_FRAME_MS) / 1000
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < pcm.byteLength; offset += size) {
    chunks.push(pcm.subarray(offset, Math.min(offset + size, pcm.byteLength)))
  }
  if (chunks.length === 0) return [{ status: 2, audio: new Uint8Array(0) }]
  // The opener must carry `common`, so it can never double as the terminator:
  // audio that fits in one frame goes out as an opener plus an empty close.
  if (chunks.length === 1) {
    return [
      { status: 0, audio: chunks[0] },
      { status: 2, audio: new Uint8Array(0) }
    ]
  }
  return chunks.map((audio, index): XfyunFrame => ({
    status: index === 0 ? 0 : index === chunks.length - 1 ? 2 : 1,
    audio
  }))
}

/**
 * Joins the `ws[].cw[].w` pieces in `sn` order.
 *
 * Sparse entries are skipped rather than turned into text: a lost frame would
 * otherwise concatenate the neighbours silently.
 */
export function xfyunJoin(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('')
    .trim()
}

/**
 * The `authorization` query value: base64 of the four-field credential.
 *
 * The signature is HMAC-SHA256 over `host`, `date` and `GET /v2/iat HTTP/1.1` —
 * the request line is part of the signed material, so the path cannot move
 * without recomputing this.
 */
export function xfyunAuth(apiKey: string, apiSecret: string, host: string, dateStr: string): string {
  const origin = `host: ${host}\ndate: ${dateStr}\nGET /v2/iat HTTP/1.1`
  const signature = createHmac('sha256', apiSecret).update(origin, 'utf8').digest('base64')
  const credential =
    `api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`
  return Buffer.from(credential, 'utf8').toString('base64')
}

/** The signed `wss://…/v2/iat?...` URL for one session. */
function xfyunUrl(ctx: AsrAdapterContext, apiKey: string, apiSecret: string): string {
  const target = new URL(origin(ctx, XFYUN_BASE))
  // A profile may carry an http(s) base URL (the preset does), so the scheme is
  // derived rather than assumed.
  target.protocol = target.protocol === 'https:' || target.protocol === 'wss:' ? 'wss:' : 'ws:'
  let path = target.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/iat')) path = path.endsWith('/v2') ? `${path}/iat` : `${path}/v2/iat`
  const host = target.host
  const date = new Date().toUTCString()
  target.pathname = path
  target.search = new URLSearchParams({ authorization: xfyunAuth(apiKey, apiSecret, host, date), date, host }).toString()
  return target.toString()
}

/** The wire body of one frame: vendor metadata on the opener, audio everywhere. */
function xfyunBody(frame: XfyunFrame, appId: string): unknown {
  const data = {
    status: frame.status,
    format: `audio/L16;rate=${SAMPLE_RATE}`,
    encoding: 'raw',
    audio: base64(frame.audio)
  }
  if (frame.status !== 0) return { data }
  return {
    common: { app_id: appId },
    business: {
      language: 'zh_cn',
      domain: 'iat',
      accent: 'mandarin',
      // 10 s of silence ends the dictation; the client already stopped sending.
      vad_eos: 10_000
    },
    data
  }
}

/** Raw PCM16 out of the wav, because IAT does not decode containers. */
function pcmBytes(wav: Uint8Array): Uint8Array {
  const decoded = decodeWavPcm16(wav)
  if (!decoded) throw new ProviderError(mt('这段音频不是 16 kHz / PCM16 的 WAV，讯飞听写只收原始 PCM'))
  const { pcm } = decoded
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

/** Collects the `ws[].cw[].w` text of one result frame. */
function xfyunPieces(payload: unknown): string {
  const ws = (payload as { data?: { result?: { ws?: Array<{ cw?: Array<{ w?: string }> }> } } })?.data?.result?.ws
  if (!Array.isArray(ws)) return ''
  return ws.map((item) => (item.cw ?? []).map((cw) => cw.w ?? '').join('')).join('')
}

async function runXfyun(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  const appId = need(ctx, 'appId', mt('讯飞 AppID'))
  const apiKey = need(ctx, 'apiKey', mt('讯飞 APIKey'))
  const apiSecret = need(ctx, 'apiSecret', mt('讯飞 APISecret'))
  const frames = xfyunFrames(pcmBytes(input.wav))
  const socket = new WebSocket(xfyunUrl(ctx, apiKey, apiSecret))

  const parts: string[] = []
  let failure: Error | null = null
  let complete = (): void => {}

  const onMessage = (event: { data: unknown }): void => {
    const raw = typeof event.data === 'string' ? event.data : ''
    if (!raw) return
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const error = payload as { code?: number; message?: string; desc?: string; data?: { status?: number } }
    if (typeof error.code === 'number' && error.code !== 0) {
      const detail = error.message || error.desc || `code ${error.code}`
      failure = new ProviderError(mt('讯飞听写失败（{{code}}）：{{detail}}', { code: error.code, detail }))
      complete()
      return
    }
    const sn = Number((payload as { data?: { result?: { sn?: number } } }).data?.result?.sn ?? 0)
    const piece = xfyunPieces(payload)
    if (piece) {
      // `sn` is 1-based; a lost frame would otherwise shift every later piece.
      const index = sn > 0 ? sn - 1 : parts.length
      parts[index] = (parts[index] ?? '') + piece
    }
    if (error.data?.status === 2) complete()
  }

  const finished = new Promise<void>((resolve) => {
    complete = resolve
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', () => {
      failure ??= new ProviderError(mt('讯飞听写连接出错（检查 AppID / APIKey / 网络）'))
      complete()
    })
    socket.addEventListener('close', () => {
      // A close before any result is a failure; after results it is the normal end.
      if (!failure && !parts.some(Boolean)) {
        failure = new ProviderError(mt('讯飞在返回识别结果前关闭了连接'))
      }
      complete()
    })
  })

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener(
      'error',
      () => reject(new ProviderError(mt('讯飞听写连接失败（检查 AppID / APIKey / 网络）'))),
      { once: true }
    )
  })

  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError(mt('讯飞听写已取消')))
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  const deadline = Date.now() + XFYUN_BUDGET_MS
  const watchdog = setTimeout(() => {
    failure ??= new ProviderError(mt('讯飞听写超时（120 s 内没有拿到结果）'))
    complete()
  }, XFYUN_BUDGET_MS)

  void (async () => {
    try {
      await opened
      for (const [index, frame] of frames.entries()) {
        if (Date.now() > deadline) throw new ProviderError(mt('讯飞听写超时（120 s 内没有发完音频）'))
        socket.send(JSON.stringify(xfyunBody(frame, appId)))
        // IAT measures frames against wall-clock: a burst is dropped, so the
        // gaps are part of the protocol, not politeness.
        if (index < frames.length - 1) await pause(ctx, XFYUN_FRAME_MS)
      }
    } catch (error) {
      failure ??= error instanceof Error ? error : new ProviderError(String(error))
      complete()
    }
  })()

  try {
    await Promise.race([finished, aborted])
  } finally {
    clearTimeout(watchdog)
    ctx.signal.removeEventListener('abort', onAbort)
    try {
      socket.close()
    } catch {
      // Already closed or never opened; nothing to release.
    }
  }

  if (failure) throw failure
  const text = xfyunJoin(parts)
  if (!text) throw new ProviderError(mt('讯飞没有返回文字'))
  return text
}

// ---------------------------------------------------------------------------
// 百度 — 短语音识别
//
// Two calls, always: the API key cannot authenticate recognition by itself, it
// only mints a short-lived `access_token` together with the secret key. And the
// audio travels as base64 inside JSON rather than as an upload, so `len` has to
// be stated explicitly — Baidu will not measure the buffer for you.
// ---------------------------------------------------------------------------

async function runBaidu(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  const apiKey = need(ctx, 'apiKey', mt('百度 API Key'))
  const secretKey = need(ctx, 'secretKey', mt('百度 Secret Key'))
  const base = origin(ctx, BAIDU_BASE)
  // A custom base URL (a gateway, or a stand-in in the tests) serves both hosts
  // under one origin; the official vop host keeps its separate OAuth host.
  const tokenUrl = /vop\.baidu\.com/.test(base) ? BAIDU_TOKEN_URL : `${base}/oauth/2.0/token`

  const tokenResponse = await request(
    ctx,
    tokenUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // A form body, not query parameters. URLs are what ends up in logs, in
      // proxy access logs and in error strings, and the secret key has no business
      // in any of them; Baidu accepts either form.
      body:
        'grant_type=client_credentials' +
        `&client_id=${encodeURIComponent(apiKey)}` +
        `&client_secret=${encodeURIComponent(secretKey)}`
    },
    20_000
  )
  failUnless(httpOk(tokenResponse.status), tokenResponse.status, tokenResponse.body, mt('换取百度 access_token'))
  const token = pickString(tokenResponse.json, 'access_token')
  if (!token) {
    const reason = pickString(tokenResponse.json, 'error_description') || pickString(tokenResponse.json, 'error')
    throw new ProviderError(
      mt('百度没有换到 access_token：{{reason}}', { reason: reason || snippet(tokenResponse.body) })
    )
  }

  const recognizeUrl = base.endsWith('/server_api') ? base : `${base}/server_api`
  const result = await request(
    ctx,
    recognizeUrl,
    {
      method: 'POST',
      // Baidu reads `token` from the body, not the header, so the Authorization
      // header would be ignored.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'wav',
        rate: SAMPLE_RATE,
        channel: 1,
        cuid: 'typeless',
        token,
        speech: base64(input.wav),
        len: input.wav.byteLength
      })
    },
    60_000
  )
  failUnless(httpOk(result.status), result.status, result.body, mt('百度识别'))
  const errNo = Number((result.json as { err_no?: number } | null)?.err_no ?? -1)
  if (errNo !== 0) {
    const message = pickString(result.json, 'err_msg') || snippet(result.body)
    throw new ProviderError(mt('百度识别失败（err_no {{no}}）：{{message}}', { no: errNo, message }))
  }
  const text = pickString(result.json, 'result', 0).trim()
  if (!text) throw new ProviderError(mt('百度没有返回文字：{{snippet}}', { snippet: snippet(result.body) }))
  return text
}

// ---------------------------------------------------------------------------

export const CN_SPECS: AsrAdapterSpec[] = [
  {
    id: 'aliyun',
    label: mt('阿里云百炼（录音文件识别）'),
    hosts: ['dashscope.aliyuncs.com'],
    fields: [
      {
        key: 'uploadUrl',
        label: mt('音频直传地址'),
        hint: mt('仅 Paraformer / Filetrans 异步模型需要；Qwen ASR Flash 直接上传录音，无需填写'),
        placeholder: 'https://…'
      },
      {
        key: 'workspace',
        label: mt('业务空间 ID'),
        hint: mt('可选；填了会作为 X-DashScope-WorkSpace 发出，留空用默认空间')
      }
    ],
    run: runAliyun
  },
  {
    id: 'tencent',
    label: mt('腾讯云（一句话识别）'),
    hosts: ['asr.tencentcloudapi.com'],
    fields: [
      { key: 'secretId', label: 'SecretId', required: true },
      { key: 'secretKey', label: 'SecretKey', required: true },
      { key: 'region', label: mt('地域'), hint: mt('默认 ap-shanghai'), value: 'ap-shanghai' },
      { key: 'token', label: mt('临时 Token'), hint: mt('可选；只有用临时密钥时才需要') }
    ],
    run: runTencent
  },
  {
    id: 'xfyun',
    label: mt('科大讯飞（语音听写）'),
    hosts: ['iat-api.xfyun.cn'],
    fields: [
      { key: 'appId', label: 'AppID', required: true },
      { key: 'apiKey', label: 'APIKey', required: true },
      { key: 'apiSecret', label: 'APISecret', required: true }
    ],
    run: runXfyun
  },
  {
    id: 'baidu',
    label: mt('百度（短语音识别）'),
    hosts: ['vop.baidu.com', 'aip.baidubce.com'],
    fields: [
      { key: 'apiKey', label: 'API Key', required: true },
      { key: 'secretKey', label: 'Secret Key', required: true }
    ],
    run: runBaidu
  }
]
