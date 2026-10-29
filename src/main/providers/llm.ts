import { traceTaskStage } from '../task-diagnostics'
import type { PolishSettings } from '@shared/types'
import { ProviderError, joinUrl, parseHeaderLines } from './asr'
import { requestUserAgent } from './models'
import { mt } from '@shared/mainI18n'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Local, validated image data; converted at the HTTP boundary only. */
  images?: string[]
}

export interface ChatRequest {
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /**
   * UI-facing reasoning effort, translated to the official vendor's supported
   * parameters. Unknown gateways keep the existing thinking/reasoning contract.
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
 * Start with the gateway contract, then apply the same vendor translations
 * used by Ask tools and streaming. The output budget is at least MIN_MAX_TOKENS;
 * OpenAI reasoning models use max_completion_tokens instead of max_tokens.
 */
export function chatRequestBody(
  cfg: Pick<PolishSettings, 'model' | 'temperature' | 'effort'> & { baseUrl?: string },
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

  return adaptChatBody(cfg, body, effort)
}

/** Wire differences shared by polish, Ask tools and Ask streaming. Unknown gateways keep their contract. */
export function adaptChatBody(
  cfg: { baseUrl?: string; model: string },
  body: Record<string, unknown>,
  effort = ''
): Record<string, unknown> {
  if (Array.isArray(body.messages)) body.messages = body.messages.map(message => {
    if (!Array.isArray(message.images) || !message.images.length) return message
    const { images, ...plain } = message
    return { ...plain, content: [{ type: 'text', text: message.content }, ...images.map((url: string) => ({ type: 'image_url', image_url: { url } }))] }
  })
  let host = ''
  try {
    host = new URL(cfg.baseUrl ?? '').hostname.toLowerCase()
  } catch {
    // A custom relative URL is validated by its caller.
  }
  if (host === 'api.cohere.ai' || host === 'api.cohere.com') {
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map(message =>
        message.role === 'system' ? { ...message, role: 'developer' } : message
      )
    }
    delete body.thinking
    if (effort) body.reasoning_effort = effort === 'off' || effort === 'none' ? 'none' : 'high'
  } else if (host === 'api.openai.com') {
    delete body.thinking
    const reasoning = /^(?:gpt-[56](?:[.\-]|$)|o[134](?:-|$))/.test(cfg.model)
    if (reasoning) {
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      if (effort === 'off') {
        if (/^gpt-5\.[1-9]/.test(cfg.model)) body.reasoning_effort = 'none'
        else body.reasoning_effort = /^gpt-5(?:-|$)/.test(cfg.model) ? 'minimal' : 'low'
      } else if (effort) body.reasoning_effort = effort
      if (body.reasoning_effort !== 'none') delete body.temperature
    } else delete body.reasoning_effort
  } else if (host === 'generativelanguage.googleapis.com') {
    delete body.thinking
    if (effort === 'off' || effort === 'none') {
      body.reasoning_effort = /^gemini-2\.5-(?!pro)/.test(cfg.model) ? 'none' : 'minimal'
    } else if (effort) {
      body.reasoning_effort = ['xhigh', 'max', 'ultra'].includes(effort) ? 'high' : effort
    }
  } else if (host === 'api.mistral.ai') {
    delete body.thinking
    if (effort) body.reasoning_effort = effort === 'off' ? 'none' : ['max', 'ultra'].includes(effort) ? 'xhigh' : effort
  } else if (host === 'api.anthropic.com') {
    delete body.reasoning_effort // The compatibility endpoint ignores this field.
    if (/^claude-(?:opus|sonnet|haiku)-(?:[5-9](?:-|$)|4-[7-9])/.test(cfg.model)) delete body.temperature
    if (effort === 'off') body.thinking = { type: 'disabled' }
  } else if (['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com'].includes(host)) {
    delete body.thinking
    if (effort) body.reasoning_effort = ['off', 'none', 'minimal'].includes(effort) ? 'low' : effort === 'ultra' ? 'max' : effort
  } else {
    if (effort === 'off') {
      body.thinking = { type: 'disabled' }
      delete body.reasoning_effort
    } else if (effort) body.reasoning_effort = effort
  }
  return body
}

/**
 * Where the chat completion lives. Nearly every vendor serves the standard
 * `/chat/completions`; a self-hosted gateway may override the path.
 */
export function chatPath(cfg: Pick<PolishSettings, 'requestPath' | 'baseUrl'>): string {
  const custom = (cfg.requestPath ?? '').trim().replace(/^\/+/, '')
  // Old built-in MiniMax profiles used its legacy endpoint with modern models.
  if (custom === 'text/chatcompletion_v2' && /^https:\/\/api\.(?:minimax\.(?:io|cn)|minimaxi\.com)(?:\/|$)/i.test(cfg.baseUrl)) return 'chat/completions'
  return custom || 'chat/completions'
}

/** Chat completion through any OpenAI-compatible `/chat/completions` endpoint. */
export function complete(...args: Parameters<typeof completeRequest>): Promise<string> {
  return traceTaskStage('llm', () => completeRequest(...args))
}

async function completeRequest(
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
  let parsed: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new ProviderError(mt('LLM 返回的不是 JSON，检查后端地址'), res.status, text.slice(0, 300))
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new ProviderError('LLM response has no content')
  if (Number.isFinite(parsed.usage?.prompt_tokens) && Number.isFinite(parsed.usage?.completion_tokens)) req.onUsage?.({ inputTokens: parsed.usage!.prompt_tokens!, outputTokens: parsed.usage!.completion_tokens! })
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
