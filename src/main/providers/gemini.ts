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

export async function generateFromAudio(
  cfg: MultimodalSettings,
  req: AudioRequest
): Promise<string> {
  if (!cfg.baseUrl) throw new ProviderError(mt('多模态 base URL 为空'))
  if (!cfg.model) throw new ProviderError(mt('多模态模型为空'))
  if (!cfg.apiKey) throw new ProviderError(mt('多模态 API Key 为空'))

  const base = cfg.baseUrl.replace(/\/+$/, '')
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseHeaderLines(cfg.extraHeaders)
  }
  // Google accepts either header; the key stays out of the query string so it
  // never shows up in proxy logs.
  headers['x-goog-api-key'] = cfg.apiKey

  const body = {
    systemInstruction: { parts: [{ text: req.prompt }] },
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: 'audio/wav',
              data: Buffer.from(req.wav).toString('base64')
            }
          },
          { text: mt('请按系统指令处理这段音频。') }
        ]
      }
    ],
    generationConfig: {
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: 4096
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal
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
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } ; finishReason?: string }>
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
