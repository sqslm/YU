import type { PresetField } from '@shared/types'
import { parseHeaderLines } from '../headers'
import { ProviderError } from '../providerError'
import { mt } from '@shared/mainI18n'

/**
 * The shared shape for vendor-specific transcription.
 *
 * The default path in `../asr.ts` assumes what almost everybody does: POST
 * multipart to `<base>/audio/transcriptions` and read `text` back. A dozen
 * vendors do not, and each of them is different in a way no base-URL edit can
 * paper over:
 *
 * - Deepgram takes raw bytes in the body and the model in the query string.
 * - AssemblyAI and Rev.ai hand back a job id that has to be polled.
 * - Gladia, Speechmatics and Aliyun need the file uploaded somewhere first.
 * - xfyun speaks WebSocket with an HMAC signature.
 * - Baidu needs an OAuth token minted from a *second* key.
 * - Replicate and fal.ai want a data URI and then queue the job.
 *
 * So each vendor gets a module that owns its own request shape, and everything
 * that is *not* request shaping — timeouts, abort, error mapping, header
 * plumbing — stays here so the modules stay short and readable.
 */

/** Everything a vendor module may need besides the audio itself. */
export interface AsrAdapterContext {
  /** Profile base URL, already trimmed of a trailing slash. */
  baseUrl: string
  /** The key the user pasted; may be empty for local endpoints. */
  apiKey: string
  /** Extra header lines from the profile (`Name: value` per line). */
  extraHeaders?: string
  /** Aborted when the take is cancelled or the deadline expires. */
  signal: AbortSignal
  /** Writes into the pipeline log, prefixed by the caller. */
  log: (line: string) => void
  /** Vendor fields from the profile (`deployment`, `region`, `appId`, …). */
  fields: Record<string, string>
}

export interface AsrAdapterInput {
  /** 16 kHz mono PCM16 WAV, RIFF header included. */
  wav: Uint8Array
  /** Duration of that audio, measured from the take. */
  ms: number
  /** Model id from the profile; empty means "whatever the vendor defaults to". */
  model: string
  /** `auto`/empty means let the vendor detect it. */
  language: string
  /** MIME type matching `wav`, e.g. `audio/wav` or `audio/ogg`. */
  mime: string
}

export interface AsrAdapterSpec {
  /** Stable id, also written into `ProviderSettings.asrAdapter`. */
  id: string
  /** Human name for logs. */
  label: string
  /**
   * Hosts this adapter claims when a profile has no `asrAdapter` and no preset
   * match (hand-written profiles, restored backups).
   */
  hosts: string[]
  /** Extra fields the vendor needs; merged into the UI by preset id. */
  fields: PresetField[]
  /** Run one transcription. Throw `ProviderError` with a readable sentence. */
  run: (ctx: AsrAdapterContext, input: AsrAdapterInput) => Promise<string>
}

/** Read a vendor field, trimmed, with a fallback. */
export function field(ctx: AsrAdapterContext, key: string, fallback = ''): string {
  const value = ctx.fields[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Field value or a `ProviderError` naming what is missing. */
export function need(ctx: AsrAdapterContext, key: string, label: string): string {
  const value = field(ctx, key)
  if (!value) throw new ProviderError(
      mt('{{label}} 没有填（设置 → 模型 → 这条配置的「{{key}}」）', { label, key })
    )
  return value
}

/** Headers from the profile's extra lines, parsed once. */
export function extraHeaders(ctx: AsrAdapterContext): Record<string, string> {
  return parseHeaderLines(ctx.extraHeaders)
}

/** Bearer auth, the shape most vendors want once you are past the door. */
export function bearer(ctx: AsrAdapterContext): Record<string, string> {
  return ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
}

/**
 * One HTTP round trip with the profile's signal, a readable timeout, and JSON
 * parsing that survives an HTML error page from a proxy.
 */
export async function request(
  ctx: AsrAdapterContext,
  url: string,
  init: RequestInit,
  timeoutMs = 60_000
): Promise<{ status: number; body: string; json: unknown }> {
  const controller = new AbortController()
  const forward = (): void => controller.abort()
  if (ctx.signal.aborted) controller.abort()
  ctx.signal.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, body: text, json }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ProviderError(controller.signal.aborted
      ? mt('{{label}} 超时或已取消', { label: ctxLabel(url) })
      : mt('{{label}} 请求失败：{{reason}}', { label: ctxLabel(url), reason }))
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', forward)
  }
}

function ctxLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Pull the first non-empty string out of a nested JSON path list. */
export function pickString(source: unknown, ...path: (string | number)[]): string {
  let cursor: unknown = source
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return ''
    cursor = (cursor as Record<string | number, unknown>)[step]
  }
  return typeof cursor === 'string' ? cursor : ''
}

/** Throw the vendor's own error sentence instead of a bare status code. */
export function failUnless(ok: boolean, status: number, body: string, what: string): void {
  if (ok) return
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 240)
  throw new ProviderError(
    mt('{{what}}失败（HTTP {{status}}）{{detail}}', {
      what,
      status,
      detail: detail ? `：${detail}` : ''
    })
  )
}
