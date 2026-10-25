import { traceTaskStage } from '../task-diagnostics'
import type { MultimodalSettings } from '@shared/types'
import { ProviderError, joinUrl, parseHeaderLines } from './asr'
import { mt } from '@shared/mainI18n'

/**
 * Gemini generateContent with inline audio.
 *
 * One request carries the recording plus the mode prompt, so the model does
 * transcription *and* the mode-specific rewrite in a single hop. That removes
 * the ASR round trip entirely — usually the slowest part of the classic route.
 */
export interface AudioRequest {
  wav: Uint8Array
  prompt: string
  temperature?: number
  signal?: AbortSignal
}

export function generateFromAudio(...args: Parameters<typeof audioRequest>): Promise<string> {
  return traceTaskStage('llm', () => audioRequest(...args))
}

async function audioRequest(
  cfg: MultimodalSettings,
  req: AudioRequest
): Promise<string> {
  return generateInlineMedia(cfg, req, req.wav, 'audio/wav', mt('请按系统指令处理这段音频。'))
}

/** Uses the same configured Gemini-compatible provider; images stay inline for this request. */
export function generateFromImage(...args: Parameters<typeof imageRequest>): Promise<string> {
  return traceTaskStage('llm', () => imageRequest(...args))
}

async function imageRequest(cfg: MultimodalSettings, req: { png: Uint8Array; prompt: string; signal?: AbortSignal }): Promise<string> {
  return generateInlineMedia(cfg, req, req.png, 'image/png', req.prompt)
}

async function generateInlineMedia(cfg: MultimodalSettings, req: { prompt: string; temperature?: number; signal?: AbortSignal }, data: Uint8Array, mime: string, userText: string): Promise<string> {
  if (!cfg.baseUrl) throw new ProviderError(mt('多模态 base URL 为空'))
  if (!cfg.model) throw new ProviderError(mt('多模态模型为空'))
  if (!cfg.apiKey && new URL(cfg.baseUrl).hostname === 'generativelanguage.googleapis.com') throw new ProviderError(mt('多模态 API Key 为空'))

  const base = cfg.baseUrl.replace(/\/+$/, '')
  const url = `${base}/models/${encodeURIComponent(cfg.model.replace(/^models\//, ''))}:generateContent`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseHeaderLines(cfg.extraHeaders)
  }
  // Google accepts either header; the key stays out of the query string so it
  // never shows up in proxy logs.
  if (cfg.apiKey) headers['x-goog-api-key'] = cfg.apiKey

  const body = {
    systemInstruction: { parts: [{ text: req.prompt }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: mime,
              data: Buffer.from(data).toString('base64')
            }
          },
          { text: userText }
        ]
      }
    ],
    generationConfig: {
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: 4096
    }
  }

  const jsonBody = JSON.stringify(body)
  if (Buffer.byteLength(jsonBody) > 20 * 1024 * 1024) throw new ProviderError(mt('多模态音频请求超过 20 MB，请缩短录音'))
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: jsonBody,
    signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ProviderError(
      mt('多模态 HTTP {{status}}', { status: res.status }),
      res.status,
      text.slice(0, 500)
    )
  }

  let parsed: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } ; finishReason?: string }>
    promptFeedback?: { blockReason?: string }
  }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProviderError(mt('多模态响应不是 JSON'), res.status, text.slice(0, 300))
  }

  const blocked = parsed.promptFeedback?.blockReason
  if (blocked) throw new ProviderError(mt('多模态请求被拒绝：{{reason}}', { reason: blocked }))

  const content = (parsed.candidates?.[0]?.content?.parts ?? [])
    .filter(part => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
    .trim()
  if (!content) {
    const reason = parsed.candidates?.[0]?.finishReason ?? 'empty'
    throw new ProviderError(mt('多模态没有返回文本（{{reason}}）', { reason }))
  }
  return content
}

/** Kept for symmetry with the OpenAI providers. */
export { joinUrl }
