import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODELS_CACHE_TTL_MS,
  flattenExtraHeaders,
  isFresh,
  listModels,
  modelsCachePath,
  modelsUrl,
  normalizeModel,
  normalizeModels,
  requestUserAgent,
  setModelsCacheDirectory
} from './models'

/** Gateway entry shaped like the real `GET /v1/models` payload. */
const RAW_MODEL = {
  id: 'cn:deepseek-v4.1-flash',
  object: 'model',
  name: 'DeepSeek V4.1 Flash',
  description: '[x0.11 credit] DeepSeek 旗舰模型…',
  context_length: 1000000,
  max_output_tokens: 393216,
  supports_reasoning: true,
  only_reasoning: false,
  can_disable_thinking: true,
  reasoning_supported_efforts: ['low', 'high', 'max'],
  reasoning_default_effort: 'high',
  credits: 'x0.11',
  vendor: 'deepseek'
}

let dir = ''

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeless-models-'))
  setModelsCacheDirectory(dir)
})

afterEach(() => {
  setModelsCacheDirectory(null)
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('modelsUrl', () => {
  it('appends /models without doubling the trailing slash', () => {
    expect(modelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models')
    expect(modelsUrl('http://127.0.0.1:8787/v1/')).toBe('http://127.0.0.1:8787/v1/models')
    expect(modelsUrl('http://127.0.0.1:8787/v1///')).toBe('http://127.0.0.1:8787/v1/models')
  })
})

describe('flattenExtraHeaders', () => {
  it('reuses the Name: value line format of the other providers', () => {
    expect(flattenExtraHeaders(' X-Org: acme \nX-Debug:1')).toEqual({
      'X-Org': 'acme',
      'X-Debug': '1'
    })
    expect(flattenExtraHeaders(undefined)).toEqual({})
  })
})

describe('isFresh', () => {
  const now = 1_700_000_000_000

  it('accepts a timestamp younger than the TTL', () => {
    expect(isFresh(now - 1, now)).toBe(true)
    expect(isFresh(now - (MODELS_CACHE_TTL_MS - 1), now)).toBe(true)
  })

  it('rejects an expired, future or missing timestamp', () => {
    expect(isFresh(now - MODELS_CACHE_TTL_MS, now)).toBe(false)
    expect(isFresh(now + 1000, now)).toBe(false)
    expect(isFresh(0, now)).toBe(false)
    expect(isFresh(Number.NaN, now)).toBe(false)
  })
})

describe('normalizeModels', () => {
  it('maps the gateway snake_case fields and drops unknown ones', () => {
    expect(normalizeModels({ data: [RAW_MODEL] })).toEqual([
      {
        id: 'cn:deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        description: '[x0.11 credit] DeepSeek 旗舰模型…',
        contextLength: 1000000,
        maxOutputTokens: 393216,
        supportsReasoning: true,
        onlyReasoning: false,
        canDisableThinking: true,
        reasoningSupportedEfforts: ['low', 'high', 'max'],
        reasoningDefaultEffort: 'high'
      }
    ])
  })

  it('falls back to the id when the name is missing', () => {
    expect(normalizeModels([{ id: 'whisper-1' }])).toEqual([{ id: 'whisper-1', name: 'whisper-1' }])
  })

  it('skips id-less entries and duplicate ids', () => {
    expect(normalizeModels([{ object: 'model' }, { id: 'a' }, { id: 'a', name: 'A' }, null])).toEqual([
      { id: 'a', name: 'a' }
    ])
  })

  it('accepts a bare array, a models key and camelCase fields', () => {
    expect(normalizeModels([{ id: 'b' }])).toHaveLength(1)
    expect(
      normalizeModels({ models: [{ id: 'c', reasoningSupportedEfforts: ['low'], canDisableThinking: true }] })
    ).toEqual([{ id: 'c', name: 'c', reasoningSupportedEfforts: ['low'], canDisableThinking: true }])
    expect(normalizeModels({ object: 'list' })).toEqual([])
  })

  it('rejects a non-object entry', () => {
    expect(normalizeModel('nope')).toBeNull()
    expect(normalizeModel({ name: 'nameless' })).toBeNull()
  })
})

describe('requestUserAgent', () => {
  it('identifies the rebuild', () => {
    expect(requestUserAgent()).toMatch(/^typeless-rebuild\/[0-9A-Za-z.-]+$/)
  })
})

describe('listModels', () => {
  it.each([
    { apiKey: 'account-b', extraHeaders: 'X-Org: first' },
    { apiKey: 'account-a', extraHeaders: 'X-Org: second' }
  ])('does not offer another account or organization models after a failed refresh: %j', async other => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 'private-model-a' }] })))
    await listModels({ baseUrl: 'http://gw/v1', apiKey: 'account-a', extraHeaders: 'X-Org: first' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    const result = await listModels({ baseUrl: 'http://gw/v1', ...other, refresh: true })

    expect(result.models).toEqual([])
    expect(result.cached).toBe(false)
    expect(result.error).toContain('401')
  })

  it('requests /models with auth, UA and extra headers, then caches the result', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => jsonResponse({ data: [RAW_MODEL] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listModels({
      baseUrl: 'http://127.0.0.1:8787/v1/',
      apiKey: 'sk-test',
      extraHeaders: 'X-Org: acme',
      refresh: true
    })

    expect(result.cached).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.models.map((m) => m.id)).toEqual(['cn:deepseek-v4.1-flash'])
    expect(result.fetchedAt).toBeGreaterThan(0)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8787/v1/models')
    expect(init?.method).toBe('GET')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['X-Org']).toBe('acme')
    expect(headers['user-agent']).toMatch(/^typeless-rebuild\//)

    const cacheFile = modelsCachePath()
    expect(cacheFile).not.toBeNull()
    const cached = JSON.parse(readFileSync(cacheFile as string, 'utf8')) as {
      baseUrl: string
      fetchedAt: number
      models: Array<{ id: string }>
    }
    expect(cached.baseUrl).toBe('http://127.0.0.1:8787/v1')
    expect(cached.fetchedAt).toBe(result.fetchedAt)
    expect(cached.models.map((m) => m.id)).toEqual(['cn:deepseek-v4.1-flash'])
    expect(readFileSync(cacheFile as string, 'utf8')).not.toContain('sk-test')
    expect(readFileSync(cacheFile as string, 'utf8')).not.toContain('acme')
  })

  it('replays a fresh cache without touching the network', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => jsonResponse({ data: [RAW_MODEL] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const first = await listModels({ baseUrl: 'http://gw/v1', apiKey: '' })
    expect(first.cached).toBe(false)
    fetchMock.mockClear()

    const second = await listModels({ baseUrl: 'http://gw/v1', apiKey: '' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(second.cached).toBe(true)
    expect(second.fetchedAt).toBe(first.fetchedAt)
    expect(second.models).toEqual(first.models)
    expect(second.error).toBeUndefined()
  })

  it('degrades to the cached list when a refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => jsonResponse({ data: [RAW_MODEL] }))
    )
    const first = await listModels({ baseUrl: 'http://gw/v1', apiKey: '' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new Error('getaddrinfo ENOTFOUND gw')
      })
    )
    const offline = await listModels({ baseUrl: 'http://gw/v1', apiKey: '', refresh: true })

    expect(offline.cached).toBe(true)
    expect(offline.fetchedAt).toBe(first.fetchedAt)
    expect(offline.models).toEqual(first.models)
    expect(offline.error).toContain('ENOTFOUND')
  })

  it('never throws without a cache and reports the HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => new Response('nope', { status: 502 }))
    )

    const result = await listModels({ baseUrl: 'http://gw/v1', apiKey: '' })

    expect(result.models).toEqual([])
    expect(result.fetchedAt).toBe(0)
    expect(result.cached).toBe(false)
    expect(result.error).toContain('HTTP 502')
  })

  it('does not reuse a cache written for another baseUrl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => jsonResponse({ data: [RAW_MODEL] }))
    )
    await listModels({ baseUrl: 'http://one/v1', apiKey: '' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new Error('offline')
      })
    )
    const other = await listModels({ baseUrl: 'http://two/v1', apiKey: '' })

    expect(other.cached).toBe(false)
    expect(other.models).toEqual([])
    expect(other.error).toBe('offline')
  })

  it('reports an empty base URL instead of requesting', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> => jsonResponse({ data: [] })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listModels({ baseUrl: '   ', apiKey: '' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      models: [],
      fetchedAt: 0,
      cached: false,
      error: 'LLM base URL is empty'
    })
  })
})

describe('streaming adapters', () => {
  it('answers from the adapter table instead of asking a socket vendor for /models', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await listModels({
      baseUrl: 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      apiKey: 'test-only',
      asrAdapter: 'volcengine-streaming'
    })
    expect(result.models.map((model) => model.id)).toEqual(['bigmodel'])
    expect(result.error).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains that an engine-based vendor has no model id to fetch', async () => {
    const result = await listModels({
      baseUrl: 'https://asr.cloud.tencent.com/asr/v2/1300000000',
      apiKey: 'test-only',
      asrAdapter: 'tencent-realtime'
    })
    expect(result.models).toEqual([])
    expect(result.error).toContain('引擎')
  })
})
