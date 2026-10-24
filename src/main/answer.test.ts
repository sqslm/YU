import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult, SearchSettings, Settings } from '@shared/types'

/**
 * The LLM and the search hop are the only two network boundaries in
 * `answerWithSearch`. Both are stubbed so every case below is deterministic and
 * offline; the DuckDuckGo parser is exercised against fixed markup instead.
 */
const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  searchWeb: vi.fn(),
  fetchWeather: vi.fn()
}))

vi.mock('./providers/llm', async importOriginal => ({ ...await importOriginal<typeof import('./providers/llm')>(), complete: mocks.complete }))

vi.mock('./providers/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/search')>()
  return { ...actual, searchWeb: mocks.searchWeb }
})

/**
 * The weather shortcut normally calls Open-Meteo. Stub the fetch by default so
 * the search cases below never depend on a forecast API being reachable; the
 * weather path itself is covered in `providers/weather.test.ts`.
 */
vi.mock('./providers/weather', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/weather')>()
  return { ...actual, fetchWeather: mocks.fetchWeather }
})

import {
  answerWithSearch,
  appendSources,
  isColloquialQuery,
  looksTimeSensitive,
  parseSearchDecision,
  prepareSearchQuery,
  sanitizeSearchQuery
} from './answer'
import { parseDuckDuckGoHtml, resolveDuckDuckGoRedirect } from './providers/search'

const signal = new AbortController().signal

/**
 * The agent's preferred dispatch is native OpenAI function calling, which is a
 * raw `fetch` to `{baseUrl}/chat/completions`. Every case in this file must stay
 * offline, so the transport is pinned to "this gateway cannot do tools" and the
 * agent falls back to the JSON intent — which goes through the mocked
 * `complete()`. Native tool calls have their own coverage in `agent.test.ts`.
 */
vi.stubGlobal(
  'fetch',
  vi.fn(async () =>
    new Response(JSON.stringify({ error: 'tools are not supported' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  )
)

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

interface LlmCall {
  messages: Array<{ role: string; content: string }>
}

/** System prompt of the n-th `complete()` call. */
function systemPromptOf(index: number): string {
  const call = mocks.complete.mock.calls[index] as unknown as [unknown, LlmCall]
  return call[1].messages[0].content
}

/** Query of every `searchWeb()` call, in call order. */
function searchedQueries(): string[] {
  return mocks.searchWeb.mock.calls.map((call) => String(call[1]))
}

describe('parseSearchDecision', () => {
  it('reads a clean JSON answer', () => {
    expect(parseSearchDecision('{"need_search": true, "query": "河南 天气"}')).toEqual({
      needSearch: true,
      query: '河南 天气'
    })
  })

  it('tolerates surrounding prose and code fences', () => {
    const raw = '好的\n```json\n{"need_search": false, "query": ""}\n```\n'
    expect(parseSearchDecision(raw)).toEqual({ needSearch: false, query: '' })
  })

  it('falls back to no search on garbage', () => {
    expect(parseSearchDecision('不需要搜索')).toEqual({ needSearch: false, query: '' })
  })

  it('treats a non-true flag as false', () => {
    expect(parseSearchDecision('{"need_search": "yes", "query": "x"}').needSearch).toBe(false)
  })
})

describe('sanitizeSearchQuery', () => {
  it('drops filler and question words but keeps the entities', () => {
    expect(sanitizeSearchQuery('嗯 那个 帮我 查一下 郑州 明天 天气 怎么样')).toBe('郑州 明天 天气')
  })

  it('leaves an already keyword-shaped query alone', () => {
    expect(sanitizeSearchQuery('郑州 天气')).toBe('郑州 天气')
  })

  it('strips Chinese punctuation and trailing particles', () => {
    expect(sanitizeSearchQuery('明天郑州天气怎么样？')).toBe('明天郑州天气')
    expect(sanitizeSearchQuery('今天郑州气温如何了')).toBe('今天郑州气温')
  })

  it('keeps ASCII filler from eating the inside of a word', () => {
    expect(sanitizeSearchQuery('um the weather in Tokyo now')).toBe('the weather in Tokyo now')
    expect(sanitizeSearchQuery('summit weather')).toBe('summit weather')
  })

  it('never returns something unusable when cleanup would erase everything', () => {
    expect(sanitizeSearchQuery('嗯嗯')).toBe('嗯嗯')
    expect(sanitizeSearchQuery('   ')).toBe('')
  })
})

describe('isColloquialQuery', () => {
  it('flags whole spoken sentences', () => {
    expect(isColloquialQuery('郑州今天天气怎么样')).toBe(true)
    expect(isColloquialQuery('帮我看看明天早上会不会下雨吗')).toBe(true)
    expect(isColloquialQuery('a'.repeat(30))).toBe(true)
  })

  it('passes short keyword queries through', () => {
    expect(isColloquialQuery('郑州 天气 明天')).toBe(false)
    expect(isColloquialQuery('')).toBe(false)
    expect(prepareSearchQuery('郑州 天气 明天')).toBe('郑州 天气 明天')
    expect(prepareSearchQuery('那个郑州明天天气怎么样啊')).toBe('郑州明天天气')
  })
})

describe('looksTimeSensitive', () => {
  it('recognises weather, news and price questions', () => {
    expect(looksTimeSensitive('郑州今天天气怎么样')).toBe(true)
    expect(looksTimeSensitive('英伟达股价')).toBe(true)
    expect(looksTimeSensitive('what is the weather in Tokyo')).toBe(true)
  })

  it('does not fire on language tasks or word-boundary traps', () => {
    expect(looksTimeSensitive('帮我翻译这句话')).toBe(false)
    expect(looksTimeSensitive('this is well known')).toBe(false)
    expect(looksTimeSensitive('')).toBe(false)
  })
})

describe('appendSources', () => {
  const results: SearchResult[] = [
    { title: '苹果发布 M6', url: 'https://example.com/a', snippet: '摘要 A' },
    { title: 'M6 跑分', url: 'https://example.com/b', snippet: '摘要 B' }
  ]

  it('appends a markdown source list', () => {
    const out = appendSources('M6 已经发布。', results)
    expect(out).toContain('## 来源')
    expect(out).toContain('- [苹果发布 M6](https://example.com/a)')
    expect(out).toContain('- [M6 跑分](https://example.com/b)')
  })

  it('prefers the sources the answer actually cited', () => {
    const out = appendSources('据 [2] 报道，跑分提升。见 https://example.com/b', results)
    expect(out).toContain('https://example.com/b')
    expect(out).not.toContain('https://example.com/a')
  })

  it('keeps citation markers in the body untouched and lists them once each', () => {
    const out = appendSources('先说结论 [2]。细节 [1]，再补一句 [1]。', results)
    expect(out).toContain('先说结论 [2]。细节 [1]，再补一句 [1]。')
    expect(out.indexOf('- [苹果发布 M6]')).toBeLessThan(out.indexOf('- [M6 跑分]'))
    expect(out.match(/^- /gm)).toHaveLength(2)
  })

  it('collapses duplicate URLs so the list never repeats an entry', () => {
    const duplicates: SearchResult[] = [
      { title: '同一条', url: 'https://example.com/a', snippet: '' },
      { title: '同一条（尾斜杠）', url: 'https://example.com/a/', snippet: '' },
      { title: '同一条（锚点）', url: 'https://example.com/a#comments', snippet: '' }
    ]
    const out = appendSources('正文。', duplicates)
    expect(out.match(/^- /gm)).toHaveLength(1)
    expect(out).toContain('- [同一条](https://example.com/a)')
  })

  it('keeps all retrieved sources instead of silently truncating roundups to six', () => {
    const many: SearchResult[] = Array.from({ length: 9 }, (_value, index) => ({
      title: `条目 ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      snippet: ''
    }))
    expect(appendSources('正文。', many).match(/^- /gm)).toHaveLength(9)
  })

  it('leaves an existing source section untouched', () => {
    const text = '正文\n\n## 来源\n- [x](https://x.test)'
    expect(appendSources(text, results)).toBe(text)
  })

  it('is a no-op without results', () => {
    expect(appendSources('正文', [])).toBe('正文')
  })
})

describe('answerWithSearch', () => {
  const hit: SearchResult = {
    title: '郑州天气',
    url: 'https://weather.test/zz',
    snippet: '阴，12℃'
  }

  beforeEach(() => {
    mocks.complete.mockReset()
    mocks.searchWeb.mockReset()
    // Default: no live forecast, so the weather shortcut stays out of the way of
    // the search assertions below. Cases that want it opt in per test.
    mocks.fetchWeather.mockReset()
    mocks.fetchWeather.mockResolvedValue(null)
  })

  it('answers plain when the model says no search is needed', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": false, "query": ""}')
    mocks.complete.mockResolvedValueOnce('这是一段翻译。')

    const out = await answerWithSearch(makeSettings(), '把这句翻译成英文', {}, signal)

    expect(mocks.searchWeb).not.toHaveBeenCalled()
    expect(mocks.complete).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ text: '这是一段翻译。', sources: [], searched: false })
  })

  it('skips the decision call entirely when search is disabled', async () => {
    mocks.complete.mockResolvedValueOnce('直接回答。')

    const out = await answerWithSearch(
      makeSettings({ enabled: false }),
      '郑州今天天气',
      {},
      signal
    )

    expect(mocks.complete).toHaveBeenCalledTimes(1)
    expect(mocks.searchWeb).not.toHaveBeenCalled()
    expect(out.searched).toBe(false)
    expect(out.text).toBe('直接回答。')
  })

  it('answers with cited sources when the first search hits', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": "英伟达 股价"}')
    mocks.complete.mockResolvedValueOnce('英伟达现价 180 美元 [1]。')
    mocks.searchWeb.mockResolvedValueOnce([
      { title: '英伟达股价', url: 'https://finance.test/nvda', snippet: '180.20 USD' }
    ])

    const out = await answerWithSearch(makeSettings(), '现在英伟达股价多少', {}, signal)

    expect(searchedQueries()).toEqual(['英伟达 股价'])
    expect(systemPromptOf(1)).toContain('<web_results>')
    expect(out.searched).toBe(true)
    expect(out.query).toBe('英伟达 股价')
    expect(out.sources).toHaveLength(1)
    expect(out.text).toContain('英伟达现价 180 美元 [1]。')
    expect(out.text).toContain('- [英伟达股价](https://finance.test/nvda)')
  })

  it('degrades to a plain answer when the provider throws', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": "郑州 天气"}')
    mocks.complete.mockResolvedValueOnce('郑州今天多云。')
    mocks.searchWeb.mockRejectedValueOnce(new Error('network down'))

    const out = await answerWithSearch(makeSettings(), '郑州今天天气', {}, signal)

    // A provider failure returns immediately: no pointless retry is attempted.
    expect(searchedQueries()).toEqual(['郑州 天气'])
    expect(out).toEqual({ text: '郑州今天多云。', sources: [], searched: false })
  })

  it('retries a time-sensitive question in keyword form and can still hit', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": "郑州天气"}')
    mocks.complete.mockResolvedValueOnce('郑州今天阴，12℃ 左右 [1]。')
    mocks.searchWeb.mockResolvedValueOnce([])
    mocks.searchWeb.mockResolvedValueOnce([hit])

    const out = await answerWithSearch(makeSettings(), '嗯那个郑州今天天气怎么样啊', {}, signal)

    const [first, second] = searchedQueries()
    expect(first).toBe('郑州天气')
    expect(second).not.toBe(first)
    expect(second.startsWith('郑州')).toBe(true)
    expect(out.searched).toBe(true)
    expect(out.query).toBe(second)
    expect(out.text).toContain('## 来源')
  })

  it('keeps a successful empty lookup distinct from a failed search when the retry is empty too', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": "郑州天气"}')
    mocks.complete.mockResolvedValueOnce('没有检索到可用的天气数据，今天郑州以多云为主。')
    mocks.searchWeb.mockResolvedValue([])

    const out = await answerWithSearch(makeSettings(), '嗯那个郑州今天天气怎么样啊', {}, signal)

    expect(mocks.searchWeb).toHaveBeenCalledTimes(2)
    expect(out.searched).toBe(true)
    expect(out.sources).toEqual([])
    expect(out.query).toBeTruthy()
    expect(out.text).toContain('今天郑州以多云为主')
  })

  it('does not retry a question that has no shelf life', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": "quick sort 复杂度"}')
    mocks.complete.mockResolvedValueOnce('快排平均 O(n log n)。')
    mocks.searchWeb.mockResolvedValueOnce([])

    const out = await answerWithSearch(makeSettings(), '快排的复杂度是多少', {}, signal)

    expect(mocks.searchWeb).toHaveBeenCalledTimes(1)
    expect(out.searched).toBe(true)
  })

  it('searches with the cleaned query when the model hands back a spoken sentence', async () => {
    const spoken = '嗯我现在想知道的那个明天郑州的天气情况到底怎么样呢'
    mocks.complete.mockResolvedValueOnce(`{"need_search": true, "query": "${spoken}"}`)
    mocks.complete.mockResolvedValueOnce('郑州明天阴，12℃ [1]。')
    mocks.searchWeb.mockResolvedValueOnce([hit])

    await answerWithSearch(makeSettings(), spoken, {}, signal)

    const [query] = searchedQueries()
    expect(query).not.toBe(spoken)
    expect(query).toContain('郑州')
    expect(query).toContain('天气')
    expect(query).not.toContain('怎么样')
    expect(query).not.toContain('嗯')
  })

  it('searches with the transcript when the decision yields no query', async () => {
    mocks.complete.mockResolvedValueOnce('{"need_search": true, "query": ""}')
    mocks.complete.mockResolvedValueOnce('答案 [1]。')
    mocks.searchWeb.mockResolvedValueOnce([hit])

    const out = await answerWithSearch(makeSettings(), '郑州 天气', {}, signal)

    expect(searchedQueries()).toEqual(['郑州 天气'])
    expect(out.query).toBe('郑州 天气')
  })
})

/**
 * Fixed DuckDuckGo HTML fragments. Attributes are deliberately reordered, the
 * markup is indented, one block puts its snippet link before its title, and the
 * page contains a sponsored block, a `y.js` hop, an inline script that mentions
 * a result class, and the same page twice.
 */
const DDG_HTML = `<html><head>
<style>.result--ad { display: none; }</style>
<script>var tpl = '<a class="result__a" href="https://bogus.test/x">Bogus</a>';</script>
</head>
<body>
<div class="results">
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example.com%2Fbuy&rut=1">赞助商链接</a>
    <div class="result__snippet">买买买</div>
  </div>
  <div rel="sponsored" class="result results_links results_links_deep web-result">
    <a rel="nofollow" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fm6" class="result__a">苹果 发布 M6</a>
    <div class="result__snippet">苹果在 10 月发布 M6 &amp; 新品，售价 &#165;9999 。</div>
  </div>
  <div class="result results_links">
    <a class="result__snippet-link" href="https://example.com/m6-bench">跑分</a>
    <script>var adCss = ".result--ad";</script>
    <a href="https://example.com/m6-bench" class="result__a">M6 跑分 &amp; 评测</a>
    <div class="result__snippet">   跑分提升   18%   <b>单核</b> 领先  </div>
  </div>
  <div class="result results_links">
    <a class="result__a" href="https://example.com/m6#comments">重复链接</a>
    <div class="result__snippet">重复</div>
  </div>
  <div class="result results_links">
    <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.test&click=1">限时优惠</a>
    <div class="result__snippet">广告</div>
  </div>
</div>
</body></html>`

describe('resolveDuckDuckGoRedirect', () => {
  it('unwraps both hop-link spellings and percent-decodes the target', () => {
    expect(
      resolveDuckDuckGoRedirect(
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&rut=abc'
      )
    ).toBe('https://example.com/a?b=1&c=2')
    expect(
      resolveDuckDuckGoRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb')
    ).toBe('https://example.com/b')
    expect(resolveDuckDuckGoRedirect('/l/?uddg=https%3A%2F%2Frel.test%2Fp')).toBe(
      'https://rel.test/p'
    )
  })

  it('handles HTML-escaped ampersands and non-ASCII targets', () => {
    expect(
      resolveDuckDuckGoRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2F%3Fx%3D1&amp;rut=2')
    ).toBe('https://a.test/?x=1')
    expect(
      resolveDuckDuckGoRedirect(
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E5%A4%A9%E6%B0%94'
      )
    ).toBe('https://zh.wikipedia.org/wiki/天气')
  })

  it('passes ordinary URLs through untouched', () => {
    expect(resolveDuckDuckGoRedirect('https://example.com/a?b=1')).toBe(
      'https://example.com/a?b=1'
    )
    expect(resolveDuckDuckGoRedirect('')).toBe('')
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('parses results regardless of attribute and block order', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 5)
    expect(results.map((item) => item.url)).toEqual([
      'https://example.com/m6',
      'https://example.com/m6-bench'
    ])
    expect(results[0].title).toBe('苹果 发布 M6')
    expect(results[1].title).toBe('M6 跑分 & 评测')
  })

  it('attaches the snippet to its own title, stripped of markup and entities', () => {
    const [first, second] = parseDuckDuckGoHtml(DDG_HTML, 5)
    expect(first.snippet).toBe('苹果在 10 月发布 M6 & 新品，售价 ¥9999 。')
    expect(second.snippet).toBe('跑分提升 18% 单核 领先')
  })

  it('drops sponsored blocks, y.js hops and duplicate pages', () => {
    const urls = parseDuckDuckGoHtml(DDG_HTML, 5).map((item) => item.url)
    expect(urls.join(' ')).not.toContain('ads.example.com')
    expect(urls.join(' ')).not.toContain('y.js')
    expect(urls.join(' ')).not.toContain('#comments')
    expect(urls).toHaveLength(2)
  })

  it('applies maxResults after parsing', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1).map((item) => item.url)).toEqual([
      'https://example.com/m6'
    ])
    expect(parseDuckDuckGoHtml(DDG_HTML, 0)).toHaveLength(2)
  })

  it('returns nothing for a page with no results', () => {
    expect(parseDuckDuckGoHtml('<html><body><p>没有结果</p></body></html>', 5)).toEqual([])
  })

  it('falls back to outbound links on the class-less lite markup', () => {
    const lite = `<div class="links_main links_deep">
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.test%2Fone">One result</a>
      <a rel="nofollow" href="https://lite.test/two">Two result</a>
    </div>`
    const results = parseDuckDuckGoHtml(lite, 5)
    expect(results.map((item) => item.url)).toEqual([
      'https://lite.test/one',
      'https://lite.test/two'
    ])
    expect(results[0].title).toBe('One result')
  })
})

describe('answerWithSearch weather shortcut', () => {
  beforeEach(() => {
    mocks.complete.mockReset()
    mocks.searchWeb.mockReset()
    mocks.fetchWeather.mockReset()
  })

  it('answers from the live forecast and cites the provider', async () => {
    mocks.fetchWeather.mockResolvedValue({
      place: '河南省 安阳',
      current: {
        temperature: 18.4,
        apparent: 17.1,
        humidity: 62,
        precipitation: 0,
        wind: 9.7,
        code: 3,
        description: '阴'
      },
      daily: [{ date: '2026-10-19', description: '阴', high: 23.1, low: 12.2, rainChance: 10 }],
      sourceUrl: 'https://open-meteo.com/en/docs'
    })
    mocks.complete.mockResolvedValueOnce('安阳今天阴，12.2 到 23.1 度，降水概率 10%。[1]')

    const out = await answerWithSearch(
      makeSettings({ enabled: true, decideWithModel: false }),
      '今天河南安阳的天气怎么样',
      {},
      signal
    )

    expect(mocks.searchWeb).not.toHaveBeenCalled()
    expect(out.searched).toBe(true)
    expect(out.sources[0].url).toContain('open-meteo')
    expect(out.text).toContain('## 来源')
    const system = mocks.complete.mock.calls[0][1]?.messages?.[0]?.content ?? ''
    expect(system).toContain('实时天气数据')
    expect(system).toContain('18.4')
  })

  it('falls back to search when no place matches', async () => {
    mocks.fetchWeather.mockResolvedValue(null)
    mocks.complete.mockResolvedValueOnce('答案。[1]')
    mocks.searchWeb.mockResolvedValue([{ title: 'T', url: 'https://t.test', snippet: 'S' }])

    const out = await answerWithSearch(
      makeSettings({ enabled: true, decideWithModel: false }),
      '郑州天气',
      {},
      signal
    )

    expect(mocks.searchWeb).toHaveBeenCalled()
    expect(out.sources[0].url).toBe('https://t.test')
  })
})

/**
 * The pipeline and the history entry still only understand
 * `{text, sources, searched, query?}`. The agent knows about tools and card
 * actions, and this block pins the boundary: those never leak into the outcome.
 */
describe('answerWithSearch tool boundary', () => {
  const fetchMock = globalThis.fetch as unknown as {
    mockResolvedValueOnce: (value: Response) => unknown
  }

  function json(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  it('carries sources from a native tool_call without adding new keys', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"郑州 天气"}' }
                }
              ]
            }
          }
        ]
      })
    )
    fetchMock.mockResolvedValueOnce(
      json({ choices: [{ message: { content: '郑州今天多云 [1]。' } }] })
    )
    mocks.searchWeb.mockResolvedValue([{ title: '郑州天气', url: 'https://t.test', snippet: '多云' }])

    const out = await answerWithSearch(makeSettings(), '郑州天气', {}, signal)

    expect(Object.keys(out).sort()).toEqual(['query', 'searched', 'sources', 'text'])
    expect(out.searched).toBe(true)
    expect(out.query).toBe('郑州 天气')
    expect(out.sources).toHaveLength(1)
    expect(out.text).toContain('- [郑州天气](https://t.test)')
  })

  it('stays a plain answer when the model asks for no tool', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ choices: [{ message: { content: '快排平均 O(n log n)。' } }] })
    )

    const out = await answerWithSearch(makeSettings(), '快排的复杂度是多少', {}, signal)

    expect(out).toEqual({ text: '快排平均 O(n log n)。', sources: [], searched: false })
  })
})
