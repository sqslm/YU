import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchSettings, Settings } from '@shared/types'

/**
 * The registry is the boundary where a model-chosen name becomes an effect, so
 * these cases cover both halves: the schema the model sees, and the exact
 * outcome (including the refusal paths) the program hands back.
 */
const mocks = vi.hoisted(() => ({
  searchWeb: vi.fn(),
  fetchWeather: vi.fn()
}))

vi.mock('../providers/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/search')>()
  return { ...actual, searchWeb: mocks.searchWeb }
})

vi.mock('../providers/weather', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/weather')>()
  return { ...actual, fetchWeather: mocks.fetchWeather }
})

import {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  getTool,
  runTool,
  searchEngineUrl,
  toolSchemas,
  type ToolContext
} from './registry'

function makeSettings(overrides: Partial<SearchSettings> = {}): Settings {
  return {
    polish: {
      baseUrl: 'http://llm.test/v1',
      apiKey: '',
      model: 'test-model',
      askPrompt: '',
      useBuiltInPrompts: true,
      temperature: 0,
      extraHeaders: ''
    },
    insertMethod: 'clipboard',
    restoreClipboard: true,
    multiline: 'space',
    search: {
      enabled: true,
      provider: 'duckduckgo',
      apiKey: '',
      endpoint: '',
      maxResults: 5,
      decideWithModel: true,
      ...overrides
    }
  } as unknown as Settings
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    settings: makeSettings(),
    question: '郑州今天天气怎么样',
    log: () => {},
    ...overrides
  }
}

const weatherReport = {
  place: '河南省 安阳',
  region: '河南',
  current: {
    temperature: 18.4,
    apparent: 17.1,
    humidity: 62,
    precipitation: 0,
    wind: 9.7,
    code: 3,
    description: '阴'
  },
  daily: [
    { date: '2026-10-19', description: '阴', high: 23.1, low: 12.2, rainChance: 10 },
    { date: '2026-10-20', description: '多云', high: 24, low: 13, rainChance: 20 }
  ],
  sourceUrl: 'https://open-meteo.com/en/docs'
}

beforeEach(() => {
  mocks.searchWeb.mockReset()
  mocks.fetchWeather.mockReset()
  mocks.fetchWeather.mockResolvedValue(null)
  mocks.searchWeb.mockResolvedValue([])
})

describe('tool schema', () => {
  it('keeps legacy Ask tools unchanged and registers explicit assistant tools', () => {
    expect(toolSchemas().map(schema => (schema.function as { name: string }).name)).toEqual([
      'get_weather',
      'web_search',
      'read_webpage',
      'get_datetime',
      'calculate',
      'get_selection',
      'replace_selection',
      'open_search'
    ])
    expect(TOOL_NAMES).toEqual(expect.arrayContaining(['open_application', 'open_folder', 'open_file', 'open_url', 'search_files']))
  })

  it('serialises as OpenAI function definitions', () => {
    const schemas = toolSchemas()
    expect(toolSchemas(TOOL_NAMES)).toHaveLength(TOOL_DEFINITIONS.length)
    expect(schemas).toHaveLength(8)
    for (const schema of schemas) {
      expect(schema.type).toBe('function')
      const fn = schema.function as Record<string, unknown>
      expect(typeof fn.name).toBe('string')
      expect(typeof fn.description).toBe('string')
      expect((fn.parameters as Record<string, unknown>).type).toBe('object')
    }
  })

  it('requires arguments only where the tool cannot infer them', () => {
    expect(getTool('web_search')?.parameters.required).toEqual(['query'])
    expect(getTool('read_webpage')?.parameters.required).toEqual(['url'])
    expect(getTool('get_weather')?.parameters.required).toEqual([])
    expect(getTool('get_selection')?.parameters.required).toEqual([])
  })

  it('rejects unknown tool names instead of running something', async () => {
    const ctx = makeContext()
    const outcome = await runTool('shell', { command: 'whoami' }, ctx)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('未知工具')
  })
})

describe('get_weather', () => {
  it('returns structured weather plus a source', async () => {
    mocks.fetchWeather.mockResolvedValue(weatherReport)
    const statuses: string[] = []
    const outcome = await runTool('get_weather', { location: '安阳' }, makeContext({ onStatus: (s) => statuses.push(s) }))
    expect(outcome.ok).toBe(true)
    // Every tool call now receives a cancellation signal: it is derived from the
    // per-tool ceiling, so a slow provider can be aborted instead of awaited.
    expect(mocks.fetchWeather).toHaveBeenCalledWith('安阳', expect.any(AbortSignal))
    const data = outcome.data as Record<string, unknown>
    expect(data.place).toBe('河南省 安阳')
    expect((data.current as Record<string, unknown>).temperature).toBe(18.4)
    expect((data.today as Record<string, unknown>).low).toBe(12.2)
    expect((data.tomorrow as Record<string, unknown>).high).toBe(24)
    expect(data.sourceUrl).toBe('https://open-meteo.com/en/docs')
    expect(String(data.text)).toContain('18.4')
    expect(outcome.sources?.[0].url).toBe('https://open-meteo.com/en/docs')
    expect(statuses).toEqual(['正在查询天气…'])
  })

  it('falls back to the question for the location', async () => {
    mocks.fetchWeather.mockResolvedValue(weatherReport)
    await runTool('get_weather', {}, makeContext())
    expect(mocks.fetchWeather).toHaveBeenCalledWith('郑州今天天气怎么样', expect.any(AbortSignal))
  })

  it('reports missing live data instead of inventing a forecast', async () => {
    mocks.fetchWeather.mockResolvedValue(null)
    const outcome = await runTool('get_weather', { location: '安阳' }, makeContext())
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('实时天气')
    expect(outcome.sources).toBeUndefined()
    expect(outcome.data.ok).toBe(false)
  })

  it('turns a provider throw into an error outcome', async () => {
    mocks.fetchWeather.mockRejectedValue(new Error('timeout'))
    const outcome = await runTool('get_weather', { location: '安阳' }, makeContext())
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('timeout')
  })
})

describe('web_search', () => {
  it('does not trim an aggregated ordinary query back to the legacy page size', async () => {
    mocks.searchWeb.mockResolvedValue([
      { title: 'Cedar model', url: 'https://cedar.test', snippet: 'one' },
      { title: 'Maple robotics', url: 'https://maple.test', snippet: 'two' },
      { title: 'Willow hardware', url: 'https://willow.test', snippet: 'three' }
    ])
    const outcome = await runTool('web_search', { query: 'compare products' }, makeContext({ question: 'compare products', settings: makeSettings({ maxResults: 1, strategy: 'aggregate' }) }))
    expect(outcome.sources).toHaveLength(3)
  })
  it('merges all roundup topics beyond the saved single-query count, removing repeats and stale news', async () => {
    let call = 0
    const names = ['Maple', 'Cedar', 'Willow', 'Birch', 'Aspen', 'Elm']
    mocks.searchWeb.mockImplementation(async () => {
      const name = names[call++]
      return [
        { title: name, url: `https://${name}.test/report`, snippet: name, publishedAt: new Date().toISOString() },
        { title: 'Shared', url: 'https://shared.test/report', snippet: 'same event', publishedAt: new Date().toISOString() },
        { title: 'Old archive', url: 'https://old.test/archive', snippet: '2020-01-01', publishedAt: '2020-01-01' }
      ]
    })
    const settings = makeSettings({ maxResults: 1 })
    const outcome = await runTool('web_search', { query: 'AI 新闻 今天' }, makeContext({ question: '今天有什么 AI 新闻', settings }))
    expect(outcome.ok).toBe(true)
    expect(mocks.searchWeb).toHaveBeenCalledTimes(6)
    expect(mocks.searchWeb.mock.calls.every(args => args[0].maxResults === 10)).toBe(true)
    expect(settings.search.maxResults).toBe(1)
    expect(outcome.sources).toHaveLength(7)
    expect(outcome.sources?.some(source => source.url.includes('old.test'))).toBe(false)
    expect(outcome.data).toMatchObject({ digest: true, count: 7, failedQueries: 0 })
  })

  it('keeps completed topics when one roundup query fails', async () => {
    mocks.searchWeb.mockRejectedValueOnce(new Error('one topic unavailable'))
      .mockResolvedValue([{ title: 'Independent event', url: 'https://source.test/event', snippet: 'new event' }])
    const outcome = await runTool('web_search', { query: 'AI news today' }, makeContext({ question: 'AI news today' }))
    expect(outcome.ok).toBe(true)
    expect(outcome.data.failedQueries).toBe(1)
    expect(outcome.sources).toHaveLength(1)
  })

  const results = [
    { title: '一', url: 'https://a.test/x', snippet: 's1' },
    { title: '一（重复）', url: 'https://a.test/x/', snippet: 's2' },
    { title: '二', url: 'https://b.test/y', snippet: 's3' }
  ]

  it('cleans the query, dedupes and caps the results', async () => {
    mocks.searchWeb.mockResolvedValue(results)
    const outcome = await runTool(
      'web_search',
      { query: '英伟达 股价 怎么样' },
      makeContext({ rewriteQuery: () => '英伟达 股价', settings: makeSettings({ maxResults: 2 }) })
    )
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 2 }),
      '英伟达 股价',
      expect.any(AbortSignal)
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.sources).toHaveLength(2)
    expect(outcome.sources?.[0].url).toBe('https://a.test/x')
    expect((outcome.data as Record<string, unknown>).count).toBe(2)
  })

  it('retries exactly once with a sanitised query when empty and time-sensitive', async () => {
    mocks.searchWeb
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ title: 't', url: 'https://c.test/z', snippet: 's' }])
    const outcome = await runTool(
      'web_search',
      { query: '郑州天气' },
      makeContext({
        rewriteQuery: (raw) => raw,
        sanitizeQuery: () => '郑州 天气',
        timeSensitive: true
      })
    )
    expect(mocks.searchWeb).toHaveBeenCalledTimes(2)
    expect(mocks.searchWeb.mock.calls[1][1]).toBe('郑州 天气')
    expect(outcome.ok).toBe(true)
    expect((outcome.data as Record<string, unknown>).retried).toBe(true)
  })

  it('does not retry a question that does not rot', async () => {
    mocks.searchWeb.mockResolvedValue([])
    const outcome = await runTool(
      'web_search',
      { query: '快排复杂度' },
      makeContext({ sanitizeQuery: () => '快速排序 复杂度', timeSensitive: false })
    )
    expect(mocks.searchWeb).toHaveBeenCalledTimes(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('没有检索到结果')
  })

  it('reports a provider failure as data', async () => {
    mocks.searchWeb.mockRejectedValue(new Error('HTTP 429'))
    const outcome = await runTool('web_search', { query: 'x' }, makeContext({ rewriteQuery: (r) => r }))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('429')
  })
})

describe('calculate / get_datetime', () => {
  it('evaluates through the registry', async () => {
    const outcome = await runTool('calculate', { expression: '125*36' }, makeContext())
    expect(outcome.ok).toBe(true)
    expect((outcome.data as Record<string, unknown>).value).toBe(4500)
    expect(outcome.summary).toContain('4500')
  })

  it('refuses a non-arithmetic expression', async () => {
    const outcome = await runTool('calculate', { expression: '2+alert(1)' }, makeContext())
    expect(outcome.ok).toBe(false)
  })

  it('returns the calendar for the requested zone', async () => {
    const outcome = await runTool(
      'get_datetime',
      { timezone: 'Asia/Shanghai', offsetDays: 1 },
      makeContext()
    )
    expect(outcome.ok).toBe(true)
    const data = outcome.data as Record<string, unknown>
    expect(data.timezone).toBe('Asia/Shanghai')
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(String(data.weekday)).toMatch(/^星期/)
  })
})

describe('read_webpage', () => {
  it('never fetches a private address', async () => {
    const fetchImpl = vi.fn()
    const outcome = await runTool(
      'read_webpage',
      { url: 'http://192.168.1.1/admin' },
      makeContext({ fetchImpl: fetchImpl as unknown as typeof fetch })
    )
    expect(outcome.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns cleaned text and a source', async () => {
    const outcome = await runTool(
      'read_webpage',
      { url: 'https://example.test/a' },
      makeContext({
        fetchImpl: (async () =>
          ({
            ok: true,
            status: 200,
            url: 'https://example.test/a',
            headers: new Headers({ 'content-type': 'text/html' }),
            text: async () => '<title>T</title><p>正文</p>'
          }) as unknown as Response) as unknown as typeof fetch
      })
    )
    expect(outcome.ok).toBe(true)
    expect((outcome.data as Record<string, unknown>).title).toBe('T')
    expect(outcome.sources?.[0].url).toBe('https://example.test/a')
  })
})

describe('selection tools', () => {
  it('reads the selection through injected deps', async () => {
    const outcome = await runTool(
      'get_selection',
      {},
      makeContext({
        selectionDeps: {
          readClipboard: () => 'old',
          writeClipboard: () => {},
          sendCopy: async () => {},
          wait: async () => {}
        }
      })
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('没有选中文字')
  })

  it('prepares a replacement but never applies it', async () => {
    const outcome = await runTool('replace_selection', { text: '新文本' }, makeContext())
    expect(outcome.ok).toBe(true)
    expect(outcome.action).toEqual({ id: 'replace', label: '替换选中', payload: '新文本' })
    expect(outcome.data.prepared).toBe(true)
  })

  it('refuses an empty replacement', async () => {
    const outcome = await runTool('replace_selection', { text: '   ' }, makeContext())
    expect(outcome.ok).toBe(false)
    expect(outcome.action).toBeUndefined()
  })
})

describe('open_search', () => {
  it('builds only the four allow-listed URLs', () => {
    expect(searchEngineUrl('github', 'react hooks')).toBe(
      'https://github.com/search?q=react%20hooks&type=repositories'
    )
    expect(searchEngineUrl('google', '天气')).toBe(
      `https://www.google.com/search?q=${encodeURIComponent('天气')}`
    )
    expect(searchEngineUrl('youtube', 'lofi')).toContain('youtube.com/results')
    expect(searchEngineUrl('bing', 'news')).toContain('bing.com/search')
    expect(searchEngineUrl('cmd', 'rm -rf /')).toBeNull()
    expect(searchEngineUrl('google', '   ')).toBeNull()
  })

  it('opens the URL through the injected opener', async () => {
    const opened: string[] = []
    const outcome = await runTool(
      'open_search',
      { engine: 'github', query: 'electron' },
      makeContext({ openExternal: async (url) => { opened.push(url) } })
    )
    expect(outcome.ok).toBe(true)
    expect(opened).toEqual(['https://github.com/search?q=electron&type=repositories'])
  })

  it('refuses an unknown engine without opening anything', async () => {
    const opened: string[] = []
    const outcome = await runTool(
      'open_search',
      { engine: 'powershell', query: 'calc' },
      makeContext({ openExternal: async (url) => { opened.push(url) } })
    )
    expect(outcome.ok).toBe(false)
    expect(opened).toEqual([])
  })
})


it('does not read a new foreground selection after the original voice target changed', async () => {
  const sendCopy = vi.fn()
  const result = await runTool('get_selection', {}, { ...makeContext(), selectionGuard: () => { throw Error('Target changed') },
    selectionDeps: { sendCopy } })
  expect(result.ok).toBe(false); expect(result.error).toContain('Target changed'); expect(sendCopy).not.toHaveBeenCalled()
})

it('requires screenshot capability and valid arguments, shares one request, and never captures on cancellation', async () => {
  const analyzeScreenshot = vi.fn().mockResolvedValue('Actual visible content')
  const ctx = { ...makeContext(), analyzeScreenshot, allowedTools: ['analyze_screenshot'], cache: new Map() }
  expect(toolSchemas().map(schema => (schema.function as { name: string }).name)).not.toContain('analyze_screenshot')
  expect((await runTool('analyze_screenshot', { question: 'Explain screenshot' }, { ...ctx, allowedTools: [] })).ok).toBe(false)
  expect((await runTool('analyze_screenshot', { question: 'Explain', path: 'C:\\secret.png' }, ctx)).ok).toBe(false)
  const args = { question: 'Explain screenshot', task: 'analyze' }
  expect((await runTool('analyze_screenshot', args, ctx)).data.text).toBe('Actual visible content')
  await runTool('analyze_screenshot', args, ctx)
  expect(analyzeScreenshot).toHaveBeenCalledExactlyOnceWith('Explain screenshot', false)
  const controller = new AbortController(); controller.abort()
  await runTool('analyze_screenshot', { question: 'New screenshot' }, { ...ctx, cache: new Map(), signal: controller.signal })
  expect(analyzeScreenshot).toHaveBeenCalledOnce()
})
