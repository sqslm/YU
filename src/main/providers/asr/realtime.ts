import { createHmac, randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { SAMPLE_RATE, decodeWavPcm16 } from '../../audio/wav'
import { ProviderError } from '../providerError'
import { type AsrAdapterContext, type AsrAdapterInput, type AsrAdapterSpec, field, need } from './types'
import { mt } from '@shared/mainI18n'

/**
 * The vendors that only speak WebSocket.
 *
 * Everything else in this folder is an HTTP round trip: build a body, send it,
 * read the answer. These three are sessions — a handshake, then the audio as a
 * series of frames (binary for some, JSON-framed for others), then a terminator,
 * then a stream of partial results that have to be assembled into one sentence.
 *
 * The shared part lives here: the socket wrapper (open, abort, watchdog), the
 * PCM splitter with its pacing, and the small text-normalising helpers. Each
 * vendor module below then owns just its own frames.
 *
 * Why pacing at all: 100 ms of audio is 3 200 bytes, and a 30 s take would
 * otherwise be dumped in a single tick. Aliyun tolerates a burst (verified: a
 * 9.4 s clip sent in ~1.4 s comes back complete and correctly punctuated), but
 * the other vendors rate-limit per frame and drop whatever arrives too early,
 * so the pump sends at a bounded multiple of real time and lets the socket push
 * back instead of guessing per vendor.
 */

/** 100 ms of 16 kHz mono PCM16 — the frame size every one of these vendors documents. */
const FRAME_MS = 100
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000

/** Nothing here may run longer than this, handshake included. */
export const REALTIME_BUDGET_MS = 120_000

/** How many times faster than real time the pump is allowed to send. */
const SEND_SPEED = 4

/** A socket plus the promise that says whether it came up. */
interface Socket {
  ws: WebSocket
  opened: Promise<void>
}

/**
 * Opens a WebSocket and resolves once the handshake is done.
 *
 * `headers` is a Node/undici extension (the browser WebSocket API cannot send
 * them); Electron's main process is the undici client, where it works — every
 * vendor below authenticates this way and nothing else is on offer.
 */
function openSocket(url: string, headers: Record<string, string>, what: string): Socket {
  let ws: WebSocket
  try {
    ws = new WebSocket(url, { headers } as never)
  } catch (error) {
    throw new ProviderError(mt('{{what}} 连接失败：{{reason}}', { what, reason: reasonOf(error) }))
  }
  // `arraybuffer` rather than the default blob: no async reader per frame.
  ws.binaryType = 'arraybuffer'
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener(
      'error',
      () => reject(new ProviderError(mt('{{what}} 连接失败（检查密钥 / 网络 / 该地域是否开通）', { what }))),
      { once: true }
    )
  })
  return { ws, opened }
}

/** Text of a text frame; empty for anything binary. */
function wsText(data: unknown): string {
  return typeof data === 'string' ? data : ''
}

/** Bytes of a binary frame, whatever container the client handed over. */
function wsBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return new Uint8Array(0)
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** Raw PCM16 payload of the take, as a view (the WAV header is dropped). */
function pcmBytes(wav: Uint8Array): Uint8Array {
  const decoded = decodeWavPcm16(wav)
  if (!decoded) throw new ProviderError(mt('这段音频不是 16 kHz / PCM16 的 WAV，流式识别只收原始 PCM'))
  const { pcm } = decoded
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

/** Sleep that aborts with the take, so no timer outlives the request. */
function pause(ctx: AsrAdapterContext, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      reject(new ProviderError(mt('发送音频时被取消')))
    }
    timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Pushes the take through `send` in 100 ms frames.
 *
 * The pacing is a *ceiling*, not a rate: a short take goes out almost at once
 * and a long one is metered at {@link SEND_SPEED}× real time, so the wait is
 * bounded by the audio (30 s of speech → ≤ 7.5 s of sending) instead of by how
 * slowly the network drains.
 */
async function pumpFrames(
  ctx: AsrAdapterContext,
  send: (frame: Uint8Array) => void,
  pcm: Uint8Array,
  speed = SEND_SPEED
): Promise<void> {
  const started = Date.now()
  let sentMs = 0
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    const frame = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))
    send(frame)
    sentMs += FRAME_MS
    const ahead = sentMs / speed - (Date.now() - started)
    if (ahead > 0) await pause(ctx, Math.min(Math.ceil(ahead), 250))
  }
}

/** A vendor's answer to "how bad was it", flattened into one readable sentence. */
function venderError(what: string, code: unknown, message: unknown): ProviderError {
  const parts = [code, message].filter((part) => part !== undefined && part !== null && String(part).trim() !== '')
  const detail = parts.length > 0 ? `（${parts.join(' ')}）` : ''
  return new ProviderError(mt('{{what}}识别失败{{detail}}', { what, detail }))
}

// ---------------------------------------------------------------------------
// 阿里云百炼 / DashScope 实时语音识别 (paraformer-realtime-v2)
//
// The only DashScope shape that accepts bytes directly: a duplex WebSocket with
// `run-task` → binary PCM frames → `finish-task`, and cumulative `sentence`
// payloads on the way back. The file-transcription path in `cn.ts` is the same
// account but a completely different interface, which is why the profile has to
// pick the model rather than the URL.
// ---------------------------------------------------------------------------

const DASHSCOPE_REALTIME = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'

/**
 * DashScope's inference URL for a profile.
 *
 * A profile may carry the https origin, the bare `/api-ws/v1` prefix, or the
 * full inference path (a dedicated deployment hands out its own host), so the
 * scheme and the missing tail are filled in rather than assumed.
 */
function dashscopeUrl(ctx: AsrAdapterContext): string {
  const raw = (ctx.baseUrl || DASHSCOPE_REALTIME).replace(/\/+$/, '')
  const target = new URL(raw)
  target.protocol = target.protocol === 'wss:' || target.protocol === 'https:' ? 'wss:' : 'ws:'
  let path = target.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/inference')) {
    path = path.endsWith('/api-ws/v1') ? `${path}/inference` : '/api-ws/v1/inference'
  }
  target.pathname = path
  return target.toString()
}

/** `language_hints` values DashScope accepts; anything else is left to auto. */
function dashscopeLanguage(language: string): string[] {
  if (!language || language === 'auto') return []
  const base = language.toLowerCase().split(/[-_]/)[0]
  return ['zh', 'en', 'ja', 'ko', 'yue', 'de', 'fr', 'ru'].includes(base) ? [base] : []
}

interface DashscopeSentence {
  text?: unknown
  sentence_end?: unknown
}

async function runDashscopeRealtime(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  const model = input.model || 'paraformer-realtime-v2'
  const pcm = pcmBytes(input.wav)
  const taskId = randomUUID()
  const { ws, opened } = openSocket(dashscopeUrl(ctx), { Authorization: `bearer ${ctx.apiKey}` }, mt('阿里云实时识别'))

  const done: string[] = []
  let current = ''
  let failure: Error | null = null
  let settle = (): void => {}

  const finished = new Promise<void>((resolve) => {
    settle = resolve
    ws.addEventListener('message', (event) => {
      const raw = wsText((event as { data: unknown }).data)
      if (!raw) return
      let message: {
        header?: { event?: string; error_code?: string; error_message?: string }
        payload?: { output?: { sentence?: DashscopeSentence } }
      }
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      const kind = message.header?.event
      if (kind === 'task-failed') {
        failure ??= venderError(mt('阿里云'), message.header?.error_code, message.header?.error_message)
        settle()
        return
      }
      if (kind === 'result-generated') {
        const sentence = message.payload?.output?.sentence
        if (!sentence || typeof sentence.text !== 'string') return
        // Partial frames repeat the sentence from its start; only a closed one
        // is appended, otherwise a take would be echoed once per 100 ms.
        if (sentence.sentence_end === true) {
          if (sentence.text) done.push(sentence.text)
          current = ''
        } else {
          current = sentence.text
        }
        return
      }
      if (kind === 'task-finished') settle()
    })
    ws.addEventListener('error', () => {
      failure ??= new ProviderError(mt('阿里云实时识别连接出错（检查密钥 / 网络）'))
      settle()
    })
    ws.addEventListener('close', () => {
      failure ??= new ProviderError(mt('阿里云在返回识别结果前关闭了连接'))
      settle()
    })
  })

  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError(mt('阿里云实时识别已取消')))
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  const watchdog = setTimeout(() => {
    failure ??= new ProviderError(mt('阿里云实时识别超时（120 s 内没有拿到结果）'))
    settle()
  }, REALTIME_BUDGET_MS)

  void (async () => {
    try {
      await opened
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model,
            parameters: {
              format: 'pcm',
              sample_rate: SAMPLE_RATE,
              disfluency_removal_enabled: false,
              ...(dashscopeLanguage(input.language).length > 0
                ? { language_hints: dashscopeLanguage(input.language) }
                : {})
            },
            input: {}
          }
        })
      )
      // The server refuses audio before `task-started`, so the pump waits for it
      // via the message handler below rather than sending optimistically.
      await new Promise<void>((resolve, reject) => {
        const onMessage = (event: { data: unknown }): void => {
          const raw = wsText(event.data)
          if (!raw) return
          try {
            if (JSON.parse(raw).header?.event === 'task-started') {
              ws.removeEventListener('message', onMessage)
              resolve()
            }
          } catch {
            /* a non-JSON frame cannot be the start signal */
          }
        }
        ws.addEventListener('message', onMessage)
        ws.addEventListener('error', () => reject(new ProviderError(mt('阿里云实时识别连接失败'))), { once: true })
        ctx.signal.addEventListener('abort', () => reject(new ProviderError(mt('阿里云实时识别已取消'))), { once: true })
      })
      await pumpFrames(ctx, (frame) => ws.send(frame), pcm)
      ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }))
    } catch (error) {
      failure ??= error instanceof Error ? error : new ProviderError(reasonOf(error))
      settle()
    }
  })()

  try {
    await Promise.race([finished, aborted])
  } finally {
    clearTimeout(watchdog)
    ctx.signal.removeEventListener('abort', onAbort)
    try {
      ws.close()
    } catch {
      /* already closed */
    }
  }
  if (failure) throw failure
  const text = [...done, current].filter((part) => part.trim() !== '').join('').trim()
  if (!text) throw new ProviderError(mt('阿里云实时识别没有返回文字（录音里可能没有人声）'))
  return text
}

export const DASHSCOPE_REALTIME_SPEC: AsrAdapterSpec = {
  id: 'dashscope-realtime',
  label: '阿里云百炼实时识别',
  hosts: ['dashscope.aliyuncs.com', 'maas.aliyuncs.com'],
  schemes: ['ws', 'wss'],
  models: ['paraformer-realtime-v2', 'paraformer-realtime-v1'],
  fields: [
    {
      key: 'workspace',
      get label() {
        return mt('业务空间')
      },
      get hint() {
        return mt('留空用默认业务空间')
      }
    }
  ],
  run: runDashscopeRealtime
}

// ---------------------------------------------------------------------------
// 腾讯云实时语音识别 (16k_zh, 标准版)
//
// Signed query string instead of a header, and a much barer frame protocol than
// the other vendors: the audio goes out as *binary* frames of raw PCM — no JSON
// envelope, no base64, no chunk numbering — and the only control frame is a
// single `{"type":"end"}` once the take is spent. Results come back as JSON
// slices that have to be stitched: `slice_type` 0 opens a sentence, 1 refines
// it, 2 closes it, and `final: 1` says the whole stream is done.
// ---------------------------------------------------------------------------

const TENCENT_REALTIME = 'wss://asr.cloud.tencent.com/asr/v2'

/** Tencent meters the upload: no more than 3 s of audio per second of wall clock. */
const TENCENT_SEND_SPEED = 2

interface TencentCredentials {
  appId: string
  secretId: string
  secretKey: string
  engine: string
}

/**
 * The signed `wss://…/asr/v2/<appid>?…` URL for one connection.
 *
 * Tencent's rule is easy to get wrong in both directions: the signing string
 * uses the *raw* values (a `+` or `=` must not be escaped there), while the URL
 * carries the encoded ones, and `signature` is appended last and never signed.
 */
function tencentRealtimeUrl(base: string, credentials: TencentCredentials): string {
  const target = new URL(base.trim() || TENCENT_REALTIME)
  target.protocol = target.protocol === 'ws:' ? 'ws:' : 'wss:'
  let path = target.pathname.replace(/\/+$/, '')
  if (!/\/asr\/v\d+$/.test(path)) path = path.endsWith('/asr') ? `${path}/v2` : '/asr/v2'
  path = `${path}/${encodeURIComponent(credentials.appId)}`

  const timestamp = Math.floor(Date.now() / 1000)
  const pairs: [string, string][] = [
    ['engine_model_type', credentials.engine],
    ['expired', String(timestamp + 86_400)],
    ['needvad', '1'],
    ['nonce', String(Math.floor(Math.random() * 1e9) + 1)],
    ['secretid', credentials.secretId],
    ['timestamp', String(timestamp)],
    // 1 = raw PCM. The default is 4 (speex), which rejects our frames with 4007.
    ['voice_format', '1'],
    // Must be unique per connection, or the server rejects the duplicate.
    ['voice_id', randomUUID().replace(/-/g, '')]
  ]
  pairs.sort((a, b) => a[0].localeCompare(b[0]))

  const signing = `${target.host}${path}?${pairs.map(([key, value]) => `${key}=${value}`).join('&')}`
  const signature = createHmac('sha1', credentials.secretKey).update(signing).digest('base64')
  target.pathname = path
  target.search = `${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}&signature=${encodeURIComponent(signature)}`
  return target.toString()
}

interface TencentSlice {
  code?: number
  message?: string
  final?: number
  result?: { slice_type?: number; voice_text_str?: string }
}

/** What each documented failure code actually means to the person reading it. */
const TENCENT_HINTS: Record<number, string> = {
  4000: '音频发送太快（1 秒内最多发 3 秒音频）',
  4001: '参数错误（检查引擎名）',
  4002: '鉴权失败（SecretId / SecretKey / AppID 是否属于同一账号）',
  4003: '这个 AppID 没有开通实时语音识别',
  4004: '资源包已用尽',
  4005: '账号欠费',
  4006: '并发超限',
  4007: '音频解码失败（只发 16 kHz PCM）',
  4008: '连接超时（音频包之间空太久）',
  4009: '连接被服务端断开',
  6001: '境外 IP 无法访问，需要回国内网络'
}

function tencentFailure(code: number, message: unknown): ProviderError {
  const detail = [String(code), typeof message === 'string' ? message : ''].filter((part) => part.trim() !== '').join(' ')
  const hint = TENCENT_HINTS[code]
  return new ProviderError(
    hint
      ? mt('腾讯云实时识别失败（{{detail}}）：{{hint}}', { detail, hint })
      : mt('腾讯云实时识别失败（{{detail}}）', { detail })
  )
}

async function runTencentRealtime(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  const credentials: TencentCredentials = {
    appId: need(ctx, 'appId', mt('腾讯云 AppID')),
    secretId: need(ctx, 'secretId', mt('腾讯云 SecretId')),
    secretKey: need(ctx, 'secretKey', mt('腾讯云 SecretKey')),
    engine: field(ctx, 'engine', '16k_zh')
  }
  const pcm = pcmBytes(input.wav)
  const { ws, opened } = openSocket(tencentRealtimeUrl(ctx.baseUrl, credentials), {}, mt('腾讯云实时识别'))

  let committed = ''
  let sentence = ''
  let failure: Error | null = null
  let settle = (): void => {}
  let ack: () => void = () => {}
  let ackFail: (error: Error) => void = () => {}
  const accepted = new Promise<void>((resolve, reject) => {
    ack = resolve
    ackFail = reject
  })

  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })

  ws.addEventListener('message', (event) => {
    const raw = wsText((event as { data: unknown }).data)
    if (!raw) return
    let frame: TencentSlice
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    const code = typeof frame.code === 'number' ? frame.code : 0
    if (code !== 0) {
      failure ??= tencentFailure(code, frame.message)
      ackFail(failure)
      settle()
      return
    }
    // The very first frame is the handshake ack; audio before it is dropped.
    ack()
    const text = typeof frame.result?.voice_text_str === 'string' ? frame.result.voice_text_str : ''
    if (text) {
      // 0/1 are the sentence still being revised — they replace rather than
      // append, otherwise every refinement would echo the words again.
      if (frame.result?.slice_type === 2) {
        committed += text
        sentence = ''
      } else {
        sentence = text
      }
    }
    if (frame.final === 1) {
      if (sentence && !committed.endsWith(sentence)) committed += sentence
      settle()
    }
  })
  ws.addEventListener('error', () => {
    failure ??= new ProviderError(mt('腾讯云实时识别连接出错（检查密钥 / 网络）'))
    ackFail(failure)
    settle()
  })
  ws.addEventListener('close', () => {
    failure ??= new ProviderError(mt('腾讯云在返回识别结果前关闭了连接'))
    ackFail(failure)
    settle()
  })

  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError(mt('腾讯云实时识别已取消')))
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  const watchdog = setTimeout(() => {
    failure ??= new ProviderError(mt('腾讯云实时识别超时（120 s 内没有拿到结果）'))
    settle()
  }, REALTIME_BUDGET_MS)

  void (async () => {
    try {
      await opened
      await accepted
      await pumpFrames(ctx, (frame) => ws.send(frame), pcm, TENCENT_SEND_SPEED)
      ws.send(JSON.stringify({ type: 'end' }))
    } catch (error) {
      failure ??= error instanceof Error ? error : new ProviderError(reasonOf(error))
      settle()
    }
  })()

  try {
    await Promise.race([finished, aborted])
  } finally {
    clearTimeout(watchdog)
    ctx.signal.removeEventListener('abort', onAbort)
    try {
      ws.close(1000)
    } catch {
      /* already closed */
    }
  }
  if (failure) throw failure
  const text = committed.trim()
  if (!text) throw new ProviderError(mt('腾讯云实时识别没有返回文字（录音里可能没有人声）'))
  return text
}

export const TENCENT_REALTIME_SPEC: AsrAdapterSpec = {
  id: 'tencent-realtime',
  label: '腾讯云实时语音识别',
  hosts: ['asr.cloud.tencent.com'],
  schemes: ['ws', 'wss'],
  fields: [
    {
      key: 'appId',
      get label() {
        return mt('AppID')
      },
      required: true,
      get hint() {
        return mt('控制台「语音识别 → 概览」里的 125xxxxxx')
      }
    },
    {
      key: 'secretId',
      get label() {
        return mt('SecretId')
      },
      required: true,
      get hint() {
        return mt('访问管理 CAM → API 密钥管理')
      }
    },
    {
      key: 'secretKey',
      get label() {
        return mt('SecretKey')
      },
      required: true
    },
    {
      key: 'engine',
      get label() {
        return mt('引擎')
      },
      get hint() {
        return mt('默认 16k_zh；英文 16k_en，粤语 16k_yue，大模型档 16k_zh_en_2.0')
      },
      placeholder: '16k_zh'
    }
  ],
  run: runTencentRealtime
}

// ---------------------------------------------------------------------------
// 火山引擎豆包流式语音识别 (bigmodel / 2.0)
//
// The only vendor here with a binary *envelope*: every frame is a 4-byte header
// (version, message type + flags, serialisation + compression), a big-endian
// payload length, and a gzip'ed payload. The audio rides in those payloads as
// raw PCM — never base64, never inside the JSON — and the last packet has to be
// flagged by the client, so the take cannot simply be followed by a close.
// ---------------------------------------------------------------------------

const VOLCENGINE_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'

/** Message types from the SAUC protocol; the high nibble of the second byte. */
const VOLC_FULL_REQUEST = 0x1
const VOLC_AUDIO_REQUEST = 0x2
const VOLC_ERROR_RESPONSE = 0xf

/** Flags: last packet of the stream. */
const VOLC_LAST = 0x2

/** 200 ms of 16 kHz mono PCM16 — what the SAUC docs recommend per packet. */
const VOLC_PACKET_MS = 200
const VOLC_PACKET_BYTES = (SAMPLE_RATE * 2 * VOLC_PACKET_MS) / 1000

/** 2.0 小时版 is what a new account gets free quota on; 1.0 is the legacy id. */
const VOLC_DEFAULT_RESOURCE = 'volc.seedasr.sauc.duration'

const VOLCENGINE_HINTS: Record<number, string> = {
  45000001: '请求参数错误（检查 resource id 与 model_name）',
  45000002: '没有收到音频（录音可能是空的）',
  45000081: '等包超时（音频发送间隔过长）',
  45000151: '音频格式不对（只发 16 kHz PCM16）',
  55000031: '服务端过载，稍后重试',
  45000010: 'API Key 无效或未开通该能力',
  45000030: '该账号没有可用额度（检查是否已开通服务/免费额度是否用完）'
}

function volcengineUrl(baseUrl: string): string {
  const raw = (baseUrl || VOLCENGINE_ENDPOINT).trim().replace(/\/+$/, '')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return VOLCENGINE_ENDPOINT
  }
  target.protocol = target.protocol === 'ws:' ? 'ws:' : 'wss:'
  const path = target.pathname.replace(/\/+$/, '')
  if (!path.includes('/sauc/')) target.pathname = '/api/v3/sauc/bigmodel_async'
  return target.toString()
}

/**
 * One client frame: header + big-endian length + payload.
 *
 * `serialisation` is 0b0001 for a JSON body and 0 for raw audio; compression is
 * always gzip, which is what the protocol's `comp` nibble is set to.
 */
function volcengineFrame(type: number, flags: number, serialisation: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + payload.length)
  frame[0] = 0x11 // version 1, header size 1 × 4 bytes
  frame[1] = ((type & 0x0f) << 4) | (flags & 0x0f)
  frame[2] = ((serialisation & 0x0f) << 4) | 0x01 // compression = gzip
  frame[3] = 0x00
  new DataView(frame.buffer).setUint32(4, payload.length, false)
  frame.set(payload, 8)
  return frame
}

interface VolcengineReply {
  type: number
  flags: number
  /** JSON body, or an empty string for a binary payload we do not understand. */
  body: string
  error: { code: number; message: string } | null
}

/**
 * A server frame.
 *
 * The server prepends a 4-byte sequence number whenever flag bit 0 is set — the
 * only structural difference from the client frames, and the reason a naive
 * "header then length" reader sees garbage on every result.
 */
function parseVolcengineFrame(raw: Uint8Array): VolcengineReply | null {
  if (raw.length < 8) return null
  const headerSize = (raw[0] & 0x0f) * 4
  const type = raw[1] >> 4
  const flags = raw[1] & 0x0f
  const compression = raw[2] & 0x0f
  const serialisation = raw[2] >> 4
  let offset = headerSize > 0 ? headerSize : 4
  if ((flags & 0x01) !== 0) offset += 4
  if (raw.length < offset + 4) return null
  const size = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(offset, false)
  offset += 4
  const payload = raw.subarray(offset, Math.min(offset + size, raw.length))
  let body = ''
  if (payload.length > 0) {
    try {
      const bytes = compression === 0x01 ? gunzipSync(payload) : Buffer.from(payload)
      if (type === VOLC_ERROR_RESPONSE) {
        if (bytes.length >= 8) {
          const code = bytes.readUInt32BE(0)
          const length = bytes.readUInt32BE(4)
          return {
            type,
            flags,
            body: '',
            error: { code, message: bytes.subarray(8, 8 + length).toString('utf8') }
          }
        }
        return { type, flags, body: '', error: { code: 0, message: bytes.toString('utf8') } }
      }
      body = serialisation === 0x01 ? bytes.toString('utf8') : ''
    } catch {
      return null
    }
  }
  return { type, flags, body, error: null }
}

interface VolcenginePayload {
  result?: {
    text?: unknown
    utterances?: { text?: unknown; start_time?: unknown; definite?: unknown }[]
  }
}

/** Text of a result frame: the cumulative `text`, else the settled utterances. */
function volcengineText(body: string): string {
  let parsed: VolcenginePayload
  try {
    parsed = JSON.parse(body) as VolcenginePayload
  } catch {
    return ''
  }
  const whole = parsed.result?.text
  if (typeof whole === 'string' && whole.trim() !== '') return whole
  const utterances = parsed.result?.utterances
  if (!Array.isArray(utterances)) return ''
  const seen = new Set<number>()
  const parts: string[] = []
  for (const item of utterances) {
    if (item?.definite !== true || typeof item.text !== 'string') continue
    const start = typeof item.start_time === 'number' ? item.start_time : -1
    if (start >= 0 && seen.has(start)) continue
    if (start >= 0) seen.add(start)
    parts.push(item.text)
  }
  return parts.join('')
}

function volcengineFailure(error: { code: number; message: string }): ProviderError {
  const detail = [String(error.code), error.message].filter((part) => part.trim() !== '').join(' ')
  const hint = VOLCENGINE_HINTS[error.code]
  return new ProviderError(
    hint
      ? mt('火山引擎识别失败（{{detail}}）：{{hint}}', { detail, hint })
      : mt('火山引擎识别失败（{{detail}}）', { detail })
  )
}

/**
 * Volcengine moved to a single `X-Api-Key` header in the new console; the old
 * console's App ID + Access Token pair still works on the same endpoint. Send
 * the key when the profile has one, and fall back to the pair otherwise.
 */
function volcengineHeaders(ctx: AsrAdapterContext): Record<string, string> {
  const apiKey = ctx.apiKey.trim()
  const appKey = field(ctx, 'appId', '').trim()
  const accessKey = field(ctx, 'accessKey', '').trim()
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': field(ctx, 'resourceId', '') || VOLC_DEFAULT_RESOURCE,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Connect-Id': randomUUID(),
    'X-Api-Sequence': '-1'
  }
  if (apiKey !== '') {
    headers['X-Api-Key'] = apiKey
    return headers
  }
  if (appKey !== '' && accessKey !== '') {
    headers['X-Api-App-Key'] = appKey
    headers['X-Api-Access-Key'] = accessKey
    return headers
  }
  throw new ProviderError(
    mt('火山引擎需要凭证：新版控制台填 API Key，旧版控制台填 App ID + Access Token')
  )
}

async function runVolcengineStreaming(ctx: AsrAdapterContext, input: AsrAdapterInput): Promise<string> {
  // The model field in the UI is the SAUC `model_name`; only `bigmodel` exists today.
  const modelName = (input.model || field(ctx, 'modelName', '')).trim() || 'bigmodel'
  const pcm = pcmBytes(input.wav)

  const { ws, opened } = openSocket(volcengineUrl(ctx.baseUrl), volcengineHeaders(ctx), mt('火山引擎流式识别'))

  let text = ''
  let failure: Error | null = null
  let settle = (): void => {}
  let ack: () => void = () => {}
  let ackFail: (error: Error) => void = () => {}
  const accepted = new Promise<void>((resolve, reject) => {
    ack = resolve
    ackFail = reject
  })
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })

  ws.addEventListener('message', (event) => {
    const reply = parseVolcengineFrame(wsBytes((event as { data: unknown }).data))
    if (!reply) return
    if (reply.error) {
      failure ??= volcengineFailure(reply.error)
      ackFail(failure)
      settle()
      return
    }
    ack()
    if (reply.body) {
      const next = volcengineText(reply.body)
      // `result.text` is the whole sentence so far, so it replaces rather than
      // appends; keeping the longest seen text survives an out-of-order frame.
      if (next.trim() !== '') text = next
    }
    if ((reply.flags & VOLC_LAST) !== 0) settle()
  })
  ws.addEventListener('error', () => {
    failure ??= new ProviderError(mt('火山引擎流式识别连接出错（检查 API Key、App ID/Access Token 与 Resource Id）'))
    ackFail(failure)
    settle()
  })
  ws.addEventListener('close', () => {
    failure ??= new ProviderError(mt('火山引擎在返回识别结果前关闭了连接'))
    ackFail(failure)
    settle()
  })

  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError(mt('火山引擎流式识别已取消')))
    if (ctx.signal.aborted) onAbort()
    else ctx.signal.addEventListener('abort', onAbort, { once: true })
  })

  const watchdog = setTimeout(() => {
    failure ??= new ProviderError(mt('火山引擎流式识别超时（120 s 内没有拿到结果）'))
    settle()
  }, REALTIME_BUDGET_MS)

  void (async () => {
    try {
      await opened
      ws.send(
        volcengineFrame(
          VOLC_FULL_REQUEST,
          0,
          0x1,
          gzipSync(
            Buffer.from(
              JSON.stringify({
                user: { uid: 'typeless' },
                audio: { format: 'pcm', codec: 'raw', rate: SAMPLE_RATE, bits: 16, channel: 1 },
                request: {
                  model_name: modelName,
                  // Two-pass: the second pass re-reads each finished sentence, so
                  // the text that lands on screen is the accurate version.
                  enable_nonstream: true,
                  enable_itn: true,
                  enable_punc: true,
                  show_utterances: true
                }
              })
            )
          )
        )
      )
      await accepted
      const started = Date.now()
      let sentMs = 0
      for (let offset = 0; offset < pcm.length; offset += VOLC_PACKET_BYTES) {
        const last = offset + VOLC_PACKET_BYTES >= pcm.length
        const chunk = pcm.subarray(offset, Math.min(offset + VOLC_PACKET_BYTES, pcm.length))
        ws.send(volcengineFrame(VOLC_AUDIO_REQUEST, last ? VOLC_LAST : 0, 0x0, gzipSync(chunk)))
        sentMs += VOLC_PACKET_MS
        const ahead = sentMs / SEND_SPEED - (Date.now() - started)
        if (ahead > 0) await pause(ctx, Math.min(Math.ceil(ahead), 250))
      }
      // A take shorter than one packet still has to be closed by the client.
      if (pcm.length === 0) ws.send(volcengineFrame(VOLC_AUDIO_REQUEST, VOLC_LAST, 0x0, gzipSync(new Uint8Array(0))))
    } catch (error) {
      failure ??= error instanceof Error ? error : new ProviderError(reasonOf(error))
      settle()
    }
  })()

  try {
    await Promise.race([finished, aborted])
  } finally {
    clearTimeout(watchdog)
    ctx.signal.removeEventListener('abort', onAbort)
    try {
      ws.close(1000)
    } catch {
      /* already closed */
    }
  }
  if (failure) throw failure
  const result = text.trim()
  if (!result) throw new ProviderError(mt('火山引擎流式识别没有返回文字（录音里可能没有人声）'))
  return result
}

export const VOLCENGINE_STREAMING_SPEC: AsrAdapterSpec = {
  id: 'volcengine-streaming',
  label: '火山引擎豆包流式识别',
  hosts: ['openspeech.bytedance.com'],
  schemes: ['ws', 'wss'],
  models: ['bigmodel'],
  fields: [
    {
      key: 'resourceId',
      get label() {
        return mt('Resource Id')
      },
      get hint() {
        return mt('留空即 2.0 小时版；并发版填 volc.seedasr.sauc.concurrent，1.0 老账号填 volc.bigasr.sauc.duration')
      },
      placeholder: VOLC_DEFAULT_RESOURCE
    },
    {
      key: 'appId',
      get label() {
        return mt('App ID（旧版控制台，可选）')
      },
      get hint() {
        return mt('新版控制台只用上面的 API Key，这里留空即可')
      }
    },
    {
      key: 'accessKey',
      get label() {
        return mt('Access Token（旧版控制台，可选）')
      },
      get hint() {
        return mt('与 App ID 成对的那串 Access Token，只有旧版控制台才需要')
      }
    }
  ],
  run: runVolcengineStreaming
}

/** Every WebSocket-only vendor, in fallback-host specificity order. */
export const REALTIME_SPECS: AsrAdapterSpec[] = [
  DASHSCOPE_REALTIME_SPEC,
  TENCENT_REALTIME_SPEC,
  VOLCENGINE_STREAMING_SPEC
]