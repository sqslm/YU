import { joinUrl, parseHeaderLines } from './asr'
import { mt } from '@shared/mainI18n'

interface ProbeInput { baseUrl: string; apiKey: string; extraHeaders?: string }
interface ProbeResult { ok: boolean; status?: number; message: string }

/** Settings connection checks, separate from Electron so the full request can be tested. */
export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
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
