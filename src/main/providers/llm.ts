import type { PolishSettings } from '@shared/types'
import { ProviderError, joinUrl, parseHeaderLines } from './asr'
import { requestUserAgent } from './models'
import { mt } from '@shared/mainI18n'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /**
   * UI-facing reasoning effort. `off` becomes `thinking: { type: 'disabled' }`
   * and nothing else is sent; any other value is sent as `reasoning_effort`;
   * `''`/undefined leaves both fields out.
   */
  effort?: string
  signal?: AbortSignal
}

/** The gateway rejects tiny budgets, and the UI exposes no knob under this. */
const MIN_MAX_TOKENS = 1024
const DEFAULT_MAX_TOKENS = 4096

/**
 * The request body for one chat completion.
 *
 * Effort mapping (the whole point of the `off` option):
 *
 * - `'off'`     -> `thinking: { type: 'disabled' }`, **no** `reasoning_effort`
 * - `'low'|…`   -> `reasoning_effort: <value>`, **no** `thinking`
 * - `''`/absent -> neither field
 *
 * `max_tokens` is always present so a gateway without a default never truncates
 * the polish result, and it is clamped to at least {@link MIN_MAX_TOKENS}.
 */
export function chatRequestBody(
  cfg: Pick<PolishSettings, 'model' | 'temperature' | 'effort'>,
  req: ChatRequest
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: req.messages,
    temperature: req.temperature ?? cfg.temperature,
    max_tokens: Math.max(MIN_MAX_TOKENS, Math.round(req.maxTokens ?? DEFAULT_MAX_TOKENS)),
    stream: false
  }

  const effort = (req.effort ?? cfg.effort ?? '').trim()
  if (effort === 'off') body.thinking = { type: 'disabled' }
  else if (effort) body.reasoning_effort = effort

  return body
}

/**
 * Where the chat completion lives. Nearly every vendor serves the standard
 * `/chat/completions`, but a few ship their own path (MiniMax answers on
 * `/text/chatcompletion_v2`), so a profile may override it.
 */
function chatPath(cfg: Pick<PolishSettings, 'requestPath'>): string {
  const custom = (cfg.requestPath ?? '').trim().replace(/^\/+/, '')
  return custom || 'chat/completions'
}

/** Chat completion through any OpenAI-compatible `/chat/completions` endpoint. */
export async function complete(
  cfg: Pick<
    PolishSettings,
    | 'baseUrl'
    | 'apiKey'
    | 'model'
    | 'extraHeaders'
    | 'temperature'
    | 'effort'
    | 'requestPath'
    | 'authHeader'
  >,
  req: ChatRequest
): Promise<string> {
  if (!cfg.baseUrl) throw new ProviderError('LLM base URL is empty')
  if (!cfg.model) throw new ProviderError('LLM model is empty')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'user-agent': requestUserAgent(),
    ...parseHeaderLines(cfg.extraHeaders)
  }
  if (cfg.apiKey) {
    if (cfg.authHeader === 'x-api-key') headers['x-api-key'] = cfg.apiKey
    else headers.Authorization = `Bearer ${cfg.apiKey}`
  }

  const res = await fetch(joinUrl(cfg.baseUrl, chatPath(cfg)), {
    method: 'POST',
    headers,
    body: JSON.stringify(chatRequestBody(cfg, req)),
    signal: req.signal
  })

  const text = await res.text()
  if (!res.ok) {
    throw new ProviderError(`LLM HTTP ${res.status}`, res.status, text.slice(0, 500))
  }

  // A 200 that is not JSON is what a captive portal or a mis-set base URL returns.
  // `JSON.parse` threw a bare SyntaxError, which no caller could classify and
  // which surfaced as "unexpected token <".
  let parsed: { choices?: Array<{ message?: { content?: string } }> }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new ProviderError(mt('LLM 返回的不是 JSON，检查后端地址'), res.status, text.slice(0, 300))
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new ProviderError('LLM response has no content')
  return content.trim()
}

/** Removes the wrapping quotes some models add around cleaned-up text. */
export function unwrapModelText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const paired =
    (first === '"' && last === '"') ||
    (first === '“' && last === '”') ||
    (first === "'" && last === "'") ||
    (first === '「' && last === '」')
  return paired ? trimmed.slice(1, -1).trim() : trimmed
}
