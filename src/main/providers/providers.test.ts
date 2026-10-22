import { afterEach, describe, expect, it, vi } from 'vitest'
import { joinUrl, parseHeaderLines } from './asr'
import { adaptChatBody, chatPath, chatRequestBody, complete, unwrapModelText } from './llm'
import { allPresets } from '@shared/providerPresets'

describe('joinUrl', () => {
  it('joins without doubling slashes', () => {
    expect(joinUrl('https://api.openai.com/v1', 'audio/transcriptions')).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    )
    expect(joinUrl('https://api.openai.com/v1/', '/audio/transcriptions')).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    )
  })

  it('keeps a bare host working', () => {
    expect(joinUrl('http://127.0.0.1:8787/v1/', 'models')).toBe('http://127.0.0.1:8787/v1/models')
  })
})

describe('vendor chat contracts', () => {
  it('keeps official MiniMax legacy profiles on the supported chat endpoint while respecting custom gateways', () => {
    expect(chatPath({ baseUrl: 'https://api.minimax.cn/v1', requestPath: 'text/chatcompletion_v2' })).toBe('chat/completions')
    expect(chatPath({ baseUrl: 'http://localhost/v1', requestPath: 'text/chatcompletion_v2' })).toBe('text/chatcompletion_v2')
  })

  it('uses each official vendor’s supported reasoning fields', () => {
    expect(adaptChatBody({ baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-3-5' }, { thinking: { type: 'disabled' } }, 'off')).toEqual({ reasoning_effort: 'none' })
    expect(adaptChatBody({ baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash' }, { thinking: { type: 'disabled' } }, 'off')).toEqual({ reasoning_effort: 'low' })
    const claude = chatRequestBody({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', temperature: 0.2, effort: 'high' }, { messages: [] })
    expect(claude).not.toHaveProperty('temperature')
    expect(claude).not.toHaveProperty('reasoning_effort')
  })
  it.each(allPresets().filter(preset => preset.kind === 'llm'))('$name uses its declared endpoint, credentials and chat response', async preset => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'verified' } }] }), { headers: { 'content-type': 'application/json' } }))
    try {
      await expect(complete({ ...preset, apiKey: 'test-only-key', model: preset.model || 'test-model', temperature: 0.2, effort: '' }, { messages: [{ role: 'user', content: 'test' }] })).resolves.toBe('verified')
      expect(fetchMock.mock.calls[0][0]).toBe(joinUrl(preset.baseUrl, preset.requestPath || 'chat/completions'))
      const init = fetchMock.mock.calls[0][1]!
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-only-key' })
      expect(JSON.parse(String(init.body)).messages).toEqual([{ role: 'user', content: 'test' }])
    } finally { fetchMock.mockRestore() }
  })

  it('uses the OpenAI reasoning token field and omits unsupported sampling/thinking fields', () => {
    const body = chatRequestBody({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', temperature: 0.2, effort: 'high' }, { messages: [], maxTokens: 2048 })
    expect(body).toMatchObject({ max_completion_tokens: 2048, reasoning_effort: 'high' })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('thinking')
  })

  it('maps Cohere roles and supported effort values in all chat paths', () => {
    const body = adaptChatBody({ baseUrl: 'https://api.cohere.ai/compatibility/v1', model: 'command-a' }, { messages: [{ role: 'system', content: 'instruction' }], thinking: { type: 'disabled' } }, 'off')
    expect(body.messages).toEqual([{ role: 'developer', content: 'instruction' }])
    expect(body.reasoning_effort).toBe('none')
    expect(body).not.toHaveProperty('thinking')
    expect(adaptChatBody({ baseUrl: 'https://api.cohere.ai', model: 'command-a' }, {}, 'medium').reasoning_effort).toBe('high')
  })

  it('uses Gemini reasoning controls without pretending every model can disable reasoning', () => {
    const cfg = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' }
    expect(adaptChatBody(cfg, {}, 'off')).toEqual({ reasoning_effort: 'minimal' })
    expect(adaptChatBody({ ...cfg, model: 'gemini-2.5-flash' }, {}, 'off')).toEqual({ reasoning_effort: 'none' })
    expect(adaptChatBody({ baseUrl: 'https://my-gateway.example/v1', model: 'custom' }, {}, 'off')).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('parseHeaderLines', () => {
  it('parses one key per line and trims both sides', () => {
    expect(parseHeaderLines('  X-Org: acme \nX-Debug:1')).toEqual({
      'X-Org': 'acme',
      'X-Debug': '1'
    })
  })

  it('keeps colons inside the value', () => {
    expect(parseHeaderLines('Authorization: Bearer abc:def')).toEqual({
      Authorization: 'Bearer abc:def'
    })
  })

  it('ignores blank lines and lines without a key', () => {
    expect(parseHeaderLines('\n\n:oops\nfine: yes\n')).toEqual({ fine: 'yes' })
  })

  it('returns an empty object for undefined', () => {
    expect(parseHeaderLines(undefined)).toEqual({})
  })
})

describe('unwrapModelText', () => {
  it('strips a full pair of straight quotes', () => {
    expect(unwrapModelText('"你好世界"')).toBe('你好世界')
  })

  it('strips curly quotes and CJK brackets', () => {
    expect(unwrapModelText('“你好世界”')).toBe('你好世界')
    expect(unwrapModelText('「你好世界」')).toBe('你好世界')
  })

  it('leaves unbalanced quotes alone', () => {
    expect(unwrapModelText('他说“你好')).toBe('他说“你好')
  })

  it('trims surrounding whitespace', () => {
    expect(unwrapModelText('  你好  ')).toBe('你好')
  })

  it('does not corrupt single characters', () => {
    expect(unwrapModelText('"')).toBe('"')
    expect(unwrapModelText('好')).toBe('好')
  })
})

describe('complete request body', () => {
  const base = {
    baseUrl: 'http://127.0.0.1:8787/v1',
    apiKey: 'sk-test',
    model: 'cn:deepseek-v4.1-flash',
    temperature: 0.2,
    effort: ''
  }
  const messages = [{ role: 'user' as const, content: 'polish this' }]

  /** Run one completion against a stub and hand back what actually went on the wire. */
  async function capture(
    req: { messages: typeof messages; maxTokens?: number; effort?: string },
    overrides: Partial<typeof base> = {}
  ): Promise<{ text: string; body: Record<string, unknown>; headers: Record<string, string>; url: string }> {
    let body: Record<string, unknown> = {}
    let headers: Record<string, string> = {}
    let url = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
        url = input
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        headers = init?.headers as Record<string, string>
        return new Response(JSON.stringify({ choices: [{ message: { content: '  hello  ' } }] }), {
          status: 200
        })
      })
    )
    const text = await complete({ ...base, ...overrides }, req)
    return { text, body, headers, url }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps off to thinking:{type:"disabled"} and never sends reasoning_effort', async () => {
    const { body } = await capture({ messages, effort: 'off' })

    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body.max_tokens).toBe(4096)
  })

  it('maps any other effort to reasoning_effort and never sends thinking', async () => {
    const { body } = await capture({ messages, effort: 'high' })

    expect(body.reasoning_effort).toBe('high')
    expect(body).not.toHaveProperty('thinking')
  })

  it('sends neither field when the effort is empty or missing', async () => {
    const empty = await capture({ messages, effort: '' })
    expect(empty.body).not.toHaveProperty('thinking')
    expect(empty.body).not.toHaveProperty('reasoning_effort')

    const missing = await capture({ messages })
    expect(missing.body).not.toHaveProperty('thinking')
    expect(missing.body).not.toHaveProperty('reasoning_effort')
  })

  it('falls back to the configured effort and keeps the payload shape intact', async () => {
    const { text, body, headers, url } = await capture({ messages }, { effort: 'max' })

    expect(body.reasoning_effort).toBe('max')
    expect(body.model).toBe('cn:deepseek-v4.1-flash')
    expect(body.messages).toEqual(messages)
    expect(body.temperature).toBe(0.2)
    expect(body.stream).toBe(false)
    expect(text).toBe('hello')
    expect(url).toBe('http://127.0.0.1:8787/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['user-agent']).toMatch(/^typeless-rebuild\//)
  })

  it('clamps a tiny max_tokens to the floor', async () => {
    const { body } = await capture({ messages, maxTokens: 120 })
    expect(body.max_tokens).toBe(1024)

    const larger = await capture({ messages, maxTokens: 8192 })
    expect(larger.body.max_tokens).toBe(8192)
  })
})
