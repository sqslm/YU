import { joinUrl, parseHeaderLines } from './asr'
import { REALTIME_SPECS } from './asr/realtime'
import { mt } from '@shared/mainI18n'

interface ProbeInput { baseUrl: string; apiKey: string; extraHeaders?: string; asrAdapter?: string }

/** Adapters that speak WebSocket, where an HTTP probe says nothing useful. */
const STREAMING = new Set(REALTIME_SPECS.map((spec) => spec.id))
interface ProbeResult { ok: boolean; status?: number; message: string }

/** Settings connection checks, separate from Electron so the full request can be tested. */
export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  // A recording session is not an HTTP endpoint: `<base>/models` answers 404 for
  // a perfectly good WebSocket connection, and a red "HTTP 404" reads as "your
  // key is wrong". Say what this button can and cannot check instead.
  if (input.asrAdapter && STREAMING.has(input.asrAdapter)) {
    return { ok: true, message: mt('这条连接用 WebSocket 流式识别，HTTP 探测不适用；地址与密钥会在录音时真正验证。') }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const headers: Record<string, string> = { ...parseHeaderLines(input.extraHeaders) }
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
    const res = await fetch(joinUrl(input.baseUrl, 'models'), { headers, signal: controller.signal })
    const body = (await res.text()).slice(0, 200)
    return { ok: res.ok, status: res.status, message: `HTTP ${res.status} · ${body}` }
  } catch (error) {
    return { ok: false, message: controller.signal.aborted ? mt('连接测试超时，请检查地址或网络后重试。') : error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeMultimodalConnection(input: ProbeInput & { model: string }): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...parseHeaderLines(input.extraHeaders) }
    if (input.apiKey) headers['x-goog-api-key'] = input.apiKey
    const base = input.baseUrl.replace(/\/+$/, '')
    const res = await fetch(`${base}/models/${encodeURIComponent(input.model)}:generateContent`, {
      method: 'POST', headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } }),
      signal: controller.signal
    })
    const body = (await res.text()).slice(0, 200)
    return { ok: res.ok, status: res.status, message: `HTTP ${res.status} · ${body}` }
  } catch (error) {
    return { ok: false, message: controller.signal.aborted ? mt('连接测试超时，请检查地址或网络后重试。') : error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
