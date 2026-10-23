import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult, SearchSettings } from '@shared/types'
import {
  MAX_SEARCH_QUERIES,
  MAX_DIGEST_QUERIES,
  isNewsDigest,
  filterTodayNews,
  assessRecency,
  classifyQuestion,
  dedupeSyndicated,
  extractDate,
  filterByRecency,
  hoursForFreshness,
  pageCompleteness,
  parseBaiduHtml,
  pickDeepReadTargets,
  planSearch,
  rankSources,
  registrableDomain,
  scoreSource,
  searchBaidu,
  searchBing,
  searchBrave,
  searchDeepSeek,
  searchDuckDuckGo,
  searchExa,
  searchGoogleCse,
  searchJina,
  searchPerplexity,
  searchPlanned,
  searchSearxng,
  searchSerper,
  searchTavily,
  searchZhipuWeb,
  toChineseQuery,
  toEnglishQuery
} from './search'

const NOW = new Date('2026-10-19T09:00:00.000Z')

function cfg(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    enabled: true,
    provider: 'brave',
    apiKey: 'test-key',
    endpoint: '',
    maxResults: 5,
    decideWithModel: true,
    ...overrides
  } as SearchSettings
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const fetchMock = vi.fn()
let calls: Array<{ url: string; body: string }> = []

beforeEach(() => {
  calls = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return jsonResponse({ web: { results: [] }, results: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyQuestion', () => {
  it('routes language tasks away from the web', () => {
    expect(classifyQuestion('帮我把这句话翻译成英文')).toBe('language')
    expect(classifyQuestion('润色一下这段话')).toBe('language')
  })

  it('separates realtime lookups from news', () => {
    expect(classifyQuestion('郑州今天天气怎么样')).toBe('realtime')
    expect(classifyQuestion('英伟达现在股价多少')).toBe('realtime')
    expect(classifyQuestion('今天的人工智能新闻有哪些')).toBe('news')
  })

  it('recognises technical, research and comparison questions', () => {
    expect(classifyQuestion('RTX 5070 的显存规格是多少')).toBe('technical')
    expect(classifyQuestion('这项临床研究的证据可信吗')).toBe('research')
    expect(classifyQuestion('5070 和 4070 对比哪个好')).toBe('comparison')
  })

  it('falls back to stable knowledge', () => {
    expect(classifyQuestion('为什么天空是蓝色的')).toBe('stable')
  })
})

describe('toEnglishQuery', () => {
  it('builds an English variant for a Chinese news question', () => {
    const english = toEnglishQuery('今天的人工智能新闻')
    expect(english).toContain('artificial intelligence')
    expect(english).toContain('news')
    // Time words land last: search engines weight the leading terms.
    expect(english.trim().endsWith('today')).toBe(true)
  })

  it('keeps product identifiers and maps the rest', () => {
    expect(toEnglishQuery('DeepSeek 最新模型')).toContain('DeepSeek')
    expect(toEnglishQuery('RTX 5070 显存')).toContain('VRAM')
  })

  it('returns nothing for input that is already Latin script', () => {
    expect(toEnglishQuery('latest artificial intelligence announcements')).toBe('')
  })

  it('builds the Chinese variant when the router used English keywords', () => {
    expect(toChineseQuery('今天的人工智能新闻有哪些')).toBe('今天 人工智能新闻')
    expect(toChineseQuery('latest AI news')).toBe('')
  })
})

describe('planSearch', () => {
  it('uses the local calendar day for known event dates instead of a rolling 48-hour window', () => {
    const items = ['2026-10-21', '2026-10-22', '2026-10-23', ''].map((date, i) => ({ title: `Event ${i}`, url: `https://example.test/${i}`, snippet: date }))
    expect(filterTodayNews(items, new Date(2026, 9, 22, 9)).map(item => item.snippet)).toEqual(['2026-10-22', ''])
  })
  it('keeps a Chinese news question bilingual and time-bounded', () => {
    const plan = planSearch('今天的人工智能新闻', '人工智能 新闻')
    expect(plan.kind).toBe('news')
    expect(plan.freshness).toBe('day')
    expect(plan.queries.length).toBe(MAX_DIGEST_QUERIES)
    expect(plan.queries[0].text).toBe('人工智能 新闻')
    expect(plan.queries[0].kind).toBe('news')
    expect(plan.queries[1].lang).toBe('en')
    expect(plan.queries[1].text).toContain('artificial intelligence')
  })

  it('does not rewrite or expand a realtime query', () => {
    const plan = planSearch('郑州今天天气怎么样', '郑州 天气')
    expect(plan.kind).toBe('realtime')
    expect(plan.queries).toEqual([{ text: '郑州 天气' }])
    expect(plan.deepRead).toBe(0)
  })

  it('never exceeds the query budget', () => {
    const plan = planSearch('今天的人工智能新闻', '人工智能 新闻', { maxQueries: 9 })
    expect(plan.queries.length).toBeLessThanOrEqual(MAX_DIGEST_QUERIES)
    expect(planSearch('这次模型发布会有何新消息', '模型 发布会', { maxQueries: 9 }).queries.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES)
  })

  it('gives news questions a deep-read budget and stable ones none', () => {
    expect(planSearch('今天的 AI 新闻', 'AI 新闻').deepRead).toBeGreaterThan(0)
    expect(planSearch('为什么天空是蓝色', '天空 蓝色').deepRead).toBe(0)
  })

  it('covers roundup topics without turning headline translation into research', () => {
    expect(isNewsDigest('总结今天的 AI 新闻')).toBe(true)
    expect(isNewsDigest('翻译“今天有什么 AI 新闻”这句话')).toBe(false)
    const plan = planSearch('今天有什么 AI 新闻', 'AI 新闻 今天')
    expect(plan.digest).toBe(true)
    expect(plan.queries.map(query => query.text).join(' ')).toMatch(/模型发布.*产品与应用.*开源与研究.*产业与政策/)
    expect(plan.queries.every(query => query.freshness === 'day' && query.kind === 'news')).toBe(true)
    expect(new Set(plan.queries.map(query => query.text)).size).toBe(plan.queries.length)
  })
})

describe('search adapters honour language and time hints', () => {
  it('sends search_lang, country and freshness to Brave', async () => {
    await searchBrave(cfg(), { text: 'AI news', lang: 'en', country: 'us', freshness: 'day' })
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('search_lang')).toBe('en')
    expect(url.searchParams.get('country')).toBe('US')
    expect(url.searchParams.get('freshness')).toBe('pd')
    expect(url.searchParams.get('count')).toBe('5')
  })

  it('switches Brave to the news endpoint for news queries', async () => {
    await searchBrave(cfg(), { text: 'AI news', kind: 'news' })
    expect(calls[0].url).toContain('/res/v1/news/search')
  })

  it('maps freshness onto Tavily time_range and the news topic', async () => {
    await searchTavily(cfg({ provider: 'tavily' }), { text: 'AI news', freshness: 'week', kind: 'news' })
    const body = JSON.parse(calls[0].body)
    expect(body.time_range).toBe('week')
    expect(body.topic).toBe('news')
    expect(body.query).toBe('AI news')
    expect(body.api_key).toBeUndefined()
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
    expect(body.include_published_date).toBe(true)
  })

  it('passes a region to DuckDuckGo without pinning one by default', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      calls.push({ url: String(input), body: '' })
      return new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } })
    })
    await searchDuckDuckGo({ text: 'AI news', country: 'us' }, 5)
    await searchDuckDuckGo('AI news', 5)
    expect(new URL(calls[0].url).searchParams.get('kl')).toBe('us-en')
    expect(new URL(calls[1].url).searchParams.get('kl')).toBe('wt-wt')
  })

  it('forwards language and time_range to SearXNG', async () => {
    await searchSearxng(
      cfg({ provider: 'searxng', endpoint: 'https://searx.test' }),
      { text: 'AI news', lang: 'en', freshness: 'month' }
    )
    const url = new URL(calls[0].url)
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.get('time_range')).toBe('month')
  })
})

describe('searchPlanned', () => {
  it('runs the plan sequentially and keeps one result set per query', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      calls.push({ url: String(input), body: '' })
      const q = new URL(String(input)).searchParams.get('q') ?? ''
      return jsonResponse({
        results: [{ title: `hit ${q}`, url: `https://ex.test/${encodeURIComponent(q)}`, content: 'x' }]
      })
    })
    const rounds = await searchPlanned(cfg({ provider: 'searxng', endpoint: 'https://searx.test' }), [
      { text: '甲' },
      { text: '乙' }
    ])
    expect(rounds.map((round) => round.query.text)).toEqual(['甲', '乙'])
    expect(rounds.every((round) => round.results.length === 1)).toBe(true)
    expect(calls.length).toBe(2)
  })

  it('records a provider failure per round instead of throwing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'nope' }, 429))
    const rounds = await searchPlanned(cfg({ provider: 'searxng', endpoint: 'https://searx.test' }), [
      { text: '甲' }
    ])
    expect(rounds[0].results).toEqual([])
    expect(rounds[0].error).toContain('429')
  })

  it('never issues more calls than the budget allows', async () => {
    const rounds = await searchPlanned(cfg({ provider: 'searxng', endpoint: 'https://searx.test' }), [
      { text: 'a' },
      { text: 'b' },
      { text: 'c' },
      { text: 'd' }
    ])
    expect(rounds.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES)
    expect(calls.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES)
  })
})

describe('dates and recency', () => {
  it('reads explicit dates only', () => {
    expect(extractDate('发布于 2026-10-19')).toBe('2026-10-19')
    expect(extractDate('2026 年 3 月 7 日')).toBe('2026-03-07')
    expect(extractDate('Published Oct 19, 2026')).toBe('2026-10-19')
    // A bare M/D is ambiguous between locales: better no date than a wrong one.
    expect(extractDate('更新于 10/19')).toBeUndefined()
  })

  it('separates the event date from the publication date', () => {
    const info = assessRecency(
      {
        title: 'A 2023 survey',
        url: 'https://ex.test/a',
        snippet: '数据来自 2023-05-01 的调查',
        publishedAt: '2026-10-19T00:00:00.000Z'
      },
      NOW
    )
    expect(info.eventDate).toBe('2023-05-01')
    expect(info.basis).toBe('event')
    // An old article refreshed today is old news and must be aged by its event.
    expect(info.ageHours).toBeGreaterThan(24 * 365)
  })

  it('drops provably old items but keeps undated ones', () => {
    const kept = filterByRecency(
      [
        { title: 'new', url: 'https://a.test/1', snippet: '2026-10-19 发布' },
        { title: 'old', url: 'https://a.test/2', snippet: '2023-05-01 发布' },
        { title: 'undated', url: 'https://a.test/3', snippet: 'no date here' }
      ],
      { now: NOW, maxAgeHours: 48 }
    )
    expect(kept.map((item) => item.title)).toEqual(['new', 'undated'])
  })

  it('maps freshness labels to windows', () => {
    expect(hoursForFreshness('day')).toBe(48)
    expect(hoursForFreshness('week')).toBe(192)
    expect(hoursForFreshness(undefined)).toBeUndefined()
  })
})

describe('scoreSource and rankSources', () => {
  it('keeps case-sensitive paths and query values distinct in adapters and ranking', async () => {
    const results = [
      { title: 'Upper path article', url: 'https://Example.com/News/AI?q=One', content: 'Upper page' },
      { title: 'Lower path document', url: 'https://example.com/news/ai?q=One', content: 'Lower page' },
      { title: 'Different query page', url: 'https://example.com/News/AI?q=one', content: 'Different query' },
      { title: 'Query slash value', url: 'https://example.com/News/AI?q=One/', content: 'Query value includes a slash' },
      { title: 'Same page anchor', url: 'https://EXAMPLE.com/News/AI?q=One#section', content: 'Duplicate' }
    ]
    fetchMock.mockResolvedValue(jsonResponse({ results }))
    const hits = await searchTavily(cfg({ provider: 'tavily', maxResults: 10 }), 'case-sensitive URLs')
    expect(hits).toHaveLength(4)
    expect(rankSources(results.map(row => ({ title: row.title, url: row.url, snippet: row.content })))).toHaveLength(4)
  })
  const official: SearchResult = {
    title: 'Introducing GPT-5.2',
    url: 'https://openai.com/index/gpt-5-2/',
    snippet: 'OpenAI introduces GPT-5.2, published 2026-10-19.'
  }
  const aggregator: SearchResult = {
    title: 'AI news roundup',
    url: 'https://news.google.com/rss/articles/abc',
    snippet: 'Aggregated headlines from many outlets.'
  }
  const reprint: SearchResult = {
    title: 'Introducing GPT-5.2',
    url: 'https://www.example-reprint.com/gpt-5-2',
    snippet: '转载自 OpenAI 新闻稿，正文相同。'
  }

  it('scores a first-party page above an aggregator', () => {
    expect(scoreSource(official, 'OpenAI 最新模型', NOW)).toBeGreaterThan(
      scoreSource(aggregator, 'OpenAI 最新模型', NOW)
    )
  })

  it('puts the original report first and keeps the aggregator as a lead only', () => {
    const ranked = rankSources([aggregator, reprint, official], 'OpenAI 最新模型', { now: NOW })
    expect(ranked[0].url).toBe(official.url)
  })

  it('collapses a syndicated copy of the same headline', () => {
    const deduped = dedupeSyndicated([official, reprint, aggregator])
    expect(deduped.length).toBe(2)
    // The surviving copy is the original, not the portal reprint.
    expect(deduped[0].url).toBe(official.url)
    expect(deduped.some((item) => item.url === reprint.url)).toBe(false)
  })

  it('prefers a repository release note for a technical question', () => {
    const docs: SearchResult = {
      title: 'v7.2.0 release notes',
      url: 'https://github.com/vitejs/vite/releases/tag/v7.2.0',
      snippet: 'Release notes for 7.2.0, published 2026-10-15.'
    }
    const blog: SearchResult = {
      title: 'Vite 7.2 is out',
      url: 'https://www.example-blog.com/vite-7-2',
      snippet: 'A blog post summarising the release.'
    }
    expect(rankSources([blog, docs], 'Vite 最新版本', { now: NOW })[0].url).toBe(docs.url)
  })

  it('ranks a peer-reviewed source above a tabloid rewrite', () => {
    const paper: SearchResult = {
      title: 'Effect of X on Y: a randomised controlled trial',
      url: 'https://pubmed.ncbi.nlm.nih.gov/40000001/',
      snippet: 'Randomised controlled trial, n=42, published 2026-09-30.'
    }
    const tabloid: SearchResult = {
      title: 'New study claims X changes everything',
      url: 'https://www.example-tabloid.com/health/x',
      snippet: 'A rewrite of the press release.'
    }
    expect(rankSources([tabloid, paper], '这项研究可信吗', { now: NOW })[0].url).toBe(paper.url)
  })

  it('drops stale items during ranking when a window is given', () => {
    const ranked = rankSources(
      [
        { title: 'old', url: 'https://ex.test/2023/05/01/a', snippet: '2023-05-01 报道' },
        { title: 'new', url: 'https://ex.test/2026/10/18/b', snippet: '2026-10-18 报道' }
      ],
      'AI 新闻',
      { now: NOW, maxAgeHours: 48 }
    )
    expect(ranked.map((item) => item.title)).toEqual(['new'])
  })

  it('honours the limit after ranking', () => {
    expect(rankSources([official, aggregator, reprint], 'AI', { now: NOW, limit: 1 }).length).toBe(1)
  })

  it('derives the registrable domain so mirrors count once', () => {
    expect(registrableDomain('https://news.ycombinator.com/item')).toBe('ycombinator.com')
    expect(registrableDomain('https://www.reuters.com/technology/x')).toBe('reuters.com')
    expect(registrableDomain('https://www.bbc.co.uk/news/tech-1')).toBe('bbc.co.uk')
  })
})

describe('deep read selection and page quality', () => {
  const results: SearchResult[] = [
    { title: 'one', url: 'https://openai.com/index/a', snippet: 'a' },
    { title: 'two', url: 'https://openai.com/index/b', snippet: 'b' },
    { title: 'three', url: 'https://www.reuters.com/technology/c', snippet: 'c' },
    { title: 'agg', url: 'https://news.google.com/rss/x', snippet: 'd' }
  ]

  it('reads originals only, one page per publisher', () => {
    const targets = pickDeepReadTargets(results, 3)
    expect(targets.map((item) => item.url)).toEqual([
      'https://openai.com/index/a',
      'https://www.reuters.com/technology/c'
    ])
  })

  it('scores a long, dated, first-party page as more complete', () => {
    const full = pageCompleteness(
      { url: 'https://openai.com/index/a', text: `发布于 2026-10-19。${'正文'.repeat(400)}` },
      'OpenAI 最新模型'
    )
    const stub = pageCompleteness(
      { url: 'https://example.com/x', text: 'Just a moment.' },
      'OpenAI 最新模型'
    )
    expect(full.score).toBeGreaterThan(stub.score)
    expect(full.hasDate).toBe(true)
    expect(full.firstParty).toBe(true)
  })
})

interface Captured {
  method: string
  /** Path plus query string, as it arrived. */
  target: string
  headers: IncomingHttpHeaders
  body: string
}

interface Reply {
  status?: number
  body: string
  contentType?: string
}

let server: Server | null = null
let origin = ''
let captured: Captured[] = []
let reply: Reply = { body: '{}' }

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

/**
 * These adapters are HTTP clients, so the honest test is a real socket: a
 * stubbed `fetch` would let a wrong method, a missing header or a mis-shaped
 * body pass unnoticed, which is exactly what "adapter exists but never worked"
 * looked like before.
 */
describe('api-backed search adapters', () => {
  beforeAll(async () => {
    const created = createServer((req, res) => {
      void readRequest(req).then((body) => {
        captured.push({ method: req.method ?? '', target: req.url ?? '', headers: req.headers, body })
        res.writeHead(reply.status ?? 200, {
          'content-type': reply.contentType ?? 'application/json'
        })
        res.end(reply.body)
      })
    })
    server = created
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', () => resolve()))
    origin = `http://127.0.0.1:${(created.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    const created = server
    server = null
    if (created) await new Promise<void>((resolve) => created.close(() => resolve()))
  })

  beforeEach(() => {
    // The suite-wide stub above would swallow the request before it reached the
    // socket, so this block restores the real `fetch` for its own tests only.
    vi.unstubAllGlobals()
    captured = []
    reply = { body: '{}' }
  })

  function sent(index = 0): Captured {
    return captured[index]
  }

  function sentUrl(index = 0): URL {
    return new URL(sent(index).target, origin)
  }

  describe('deepseek', () => {
    const key = { provider: 'deepseek', apiKey: 'sk-test' } as const

    it('posts the documented body with a bearer token', async () => {
      reply = { body: JSON.stringify({ results: [] }) }
      await searchDeepSeek(cfg({ ...key, endpoint: origin, maxResults: 5 }), { text: 'OpenAI 新模型' })
      const request = sent()
      expect(request.method).toBe('POST')
      // The settings field holds the base URL, so the path has to be completed here.
      expect(request.target).toBe('/v1/tools/search')
      expect(request.headers.authorization).toBe('Bearer sk-test')
      expect(request.headers['content-type']).toBe('application/json')
      expect(JSON.parse(request.body)).toEqual({
        query: 'OpenAI 新模型',
        count: 5,
        need_content: true
      })
    })

    it('skips paid page text for a take that only wants a few hits', async () => {
      reply = { body: JSON.stringify({ results: [] }) }
      await searchDeepSeek(cfg({ ...key, endpoint: origin, maxResults: 2 }), { text: 'OpenAI 新模型' })
      const body = JSON.parse(sent().body)
      expect(body.count).toBe(2)
      expect(body.need_content).toBe(false)
    })

    it('uses an endpoint that already names the route instead of doubling it', async () => {
      await searchDeepSeek(cfg({ ...key, endpoint: `${origin}/v1/tools/search` }), { text: 'q' })
      expect(sent().target).toBe('/v1/tools/search')
    })

    it('falls back from content to summary to snippet', async () => {
      reply = {
        body: JSON.stringify({
          results: [
            { title: 'A', url: 'https://a.example/1', content: '整页正文', summary: '摘要', snippet: '片断' },
            { title: 'B', url: 'https://b.example/2', content: '', summary: '只有摘要', snippet: '片断' },
            { title: 'C', url: 'https://c.example/3', snippet: '只有片断' }
          ]
        })
      }
      const hits = await searchDeepSeek(cfg({ ...key, endpoint: origin }), { text: 'q' })
      expect(hits.map((hit) => hit.snippet)).toEqual(['整页正文', '只有摘要', '只有片断'])
      expect(hits[0].url).toBe('https://a.example/1')
    })

    it('treats an empty result array as "nothing found", not as a failure', async () => {
      reply = { body: JSON.stringify({ results: [] }) }
      await expect(searchDeepSeek(cfg({ ...key, endpoint: origin }), { text: 'q' })).resolves.toEqual(
        []
      )
    })

    it('names the balance problem when the account is out of credit', async () => {
      reply = {
        status: 402,
        body: JSON.stringify({
          error: { message: 'Insufficient Balance', type: 'insufficient_quota', code: '402' }
        })
      }
      const error = await searchDeepSeek(cfg({ ...key, endpoint: origin }), { text: 'q' }).catch(
        (err: Error) => err
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('402')
      expect((error as Error).message).toContain('余额不足')
      expect((error as Error).message).toContain('Insufficient Balance')
    })

    it('names the rate limit when the QPS cap is hit', async () => {
      reply = { status: 429, body: JSON.stringify({ error: { message: 'Rate limit' } }) }
      await expect(searchDeepSeek(cfg({ ...key, endpoint: origin }), { text: 'q' })).rejects.toThrow(
        /超过 QPS 限制/
      )
    })

    it('refuses to call without a key', async () => {
      await expect(
        searchDeepSeek(cfg({ provider: 'deepseek', apiKey: '' }), { text: 'q' })
      ).rejects.toThrow(/API Key/)
      expect(captured).toHaveLength(0)
    })
  })

  describe('exa', () => {
    it('asks for page text with the x-api-key header', async () => {
      reply = {
        body: JSON.stringify({
          results: [
            {
              title: 'Launch note',
              url: 'https://openai.com/index/a',
              text: '整页正文',
              publishedDate: '2026-10-01T00:00:00.000Z'
            }
          ]
        })
      }
      const hits = await searchExa(
        cfg({ provider: 'exa', apiKey: 'exa-key', endpoint: `${origin}/search` }),
        { text: 'OpenAI 新模型' }
      )
      const request = sent()
      expect(request.method).toBe('POST')
      expect(request.target).toBe('/search')
      // Exa reads its own header name; a bearer token here is silently ignored.
      expect(request.headers['x-api-key']).toBe('exa-key')
      expect(JSON.parse(request.body)).toEqual({
        query: 'OpenAI 新模型',
        numResults: 5,
        contents: { text: { maxCharacters: 2000 } }
      })
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toBe('整页正文')
      expect(hits[0].publishedAt).toBe('2026-10-01T00:00:00.000Z')
    })

    it('survives a vendor error without inventing hits', async () => {
      reply = { status: 500, body: JSON.stringify({ error: { message: 'internal' } }) }
      await expect(
        searchExa(cfg({ provider: 'exa', apiKey: 'exa-key', endpoint: `${origin}/search` }), {
          text: 'q'
        })
      ).rejects.toThrow(/Exa HTTP 500/)
    })
  })

  describe('serper', () => {
    it('reads organic results and uses the X-API-KEY header', async () => {
      reply = {
        body: JSON.stringify({
          organic: [{ title: 'Serper hit', link: 'https://s.example/1', snippet: '片断' }]
        })
      }
      const hits = await searchSerper(
        cfg({ provider: 'serper', apiKey: 'serper-key', endpoint: `${origin}/search` }),
        { text: 'q' }
      )
      const request = sent()
      expect(request.target).toBe('/search')
      expect(request.headers['x-api-key']).toBe('serper-key')
      expect(request.headers.authorization).toBeUndefined()
      expect(JSON.parse(request.body)).toEqual({ q: 'q', num: 5 })
      expect(hits[0]).toMatchObject({ title: 'Serper hit', url: 'https://s.example/1' })
    })
  })

  describe('bing', () => {
    it('queries webPages with the subscription key', async () => {
      reply = {
        body: JSON.stringify({
          webPages: { value: [{ name: 'Bing hit', url: 'https://b.example/1', snippet: '片断' }] }
        })
      }
      const hits = await searchBing(
        cfg({ provider: 'bing', apiKey: 'bing-key', endpoint: `${origin}/v7.0/search` }),
        { text: 'OpenAI 新模型' }
      )
      const request = sent()
      expect(request.method).toBe('GET')
      expect(request.body).toBe('')
      expect(request.headers['ocp-apim-subscription-key']).toBe('bing-key')
      const url = sentUrl()
      expect(url.pathname).toBe('/v7.0/search')
      expect(url.searchParams.get('q')).toBe('OpenAI 新模型')
      expect(url.searchParams.get('count')).toBe('5')
      expect(hits[0]).toMatchObject({ title: 'Bing hit', url: 'https://b.example/1' })
    })

    it('reports a rejected key instead of returning an empty list', async () => {
      reply = { status: 401, body: JSON.stringify({ error: { message: 'Access denied' } }) }
      await expect(
        searchBing(cfg({ provider: 'bing', apiKey: 'bad', endpoint: `${origin}/v7.0/search` }), {
          text: 'q'
        })
      ).rejects.toThrow(/Bing HTTP 401/)
    })
  })

  describe('google-cse', () => {
    it('carries the cx from the address field into the query', async () => {
      reply = {
        body: JSON.stringify({
          items: [{ title: 'CSE hit', link: 'https://g.example/1', snippet: '片断' }]
        })
      }
      const endpoint = `${origin}/customsearch/v1?cx=0123456789:abc`
      const hits = await searchGoogleCse(
        cfg({ provider: 'google-cse', apiKey: 'g-key', endpoint }),
        { text: 'q' }
      )
      const url = sentUrl()
      expect(url.pathname).toBe('/customsearch/v1')
      // Key and cx must both ride in the query string; the API has no header form.
      expect(url.searchParams.get('key')).toBe('g-key')
      expect(url.searchParams.get('cx')).toBe('0123456789:abc')
      expect(url.searchParams.get('q')).toBe('q')
      expect(url.searchParams.get('num')).toBe('5')
      expect(hits[0]).toMatchObject({ title: 'CSE hit', url: 'https://g.example/1' })
    })

    it('says which field is missing when only the key was filled in', async () => {
      await expect(
        searchGoogleCse(cfg({ provider: 'google-cse', apiKey: 'g-key', endpoint: '' }), { text: 'q' })
      ).rejects.toThrow(/cx/)
      expect(captured).toHaveLength(0)
    })
  })

  describe('jina', () => {
    it('reads the JSON shape and sends the optional key', async () => {
      reply = {
        body: JSON.stringify({
          data: [{ title: 'Jina hit', url: 'https://j.example/1', content: '抽好的正文' }]
        })
      }
      const hits = await searchJina(cfg({ provider: 'jina', apiKey: 'j-key', endpoint: origin }), {
        text: 'q'
      })
      expect(sentUrl().searchParams.get('q')).toBe('q')
      expect(sent().headers.authorization).toBe('Bearer j-key')
      expect(hits[0]).toMatchObject({ title: 'Jina hit', snippet: '抽好的正文' })
    })

    it('falls back to markdown links when the reader answers as text', async () => {
      reply = { body: '[Jina 标题](https://j.example/2)\n', contentType: 'text/plain' }
      const hits = await searchJina(cfg({ provider: 'jina', apiKey: '', endpoint: origin }), {
        text: 'q'
      })
      // Keyless is the documented default for this host, so no header may be sent.
      expect(sent().headers.authorization).toBeUndefined()
      expect(hits).toEqual([{ title: 'Jina 标题', url: 'https://j.example/2', snippet: '' }])
    })
  })

  describe('perplexity', () => {
    it('asks sonar and keeps the citations as hits', async () => {
      reply = {
        body: JSON.stringify({
          choices: [{ message: { content: '综合答案' } }],
          search_results: [{ title: 'P hit', url: 'https://p.example/1', snippet: '' }]
        })
      }
      const hits = await searchPerplexity(
        cfg({ provider: 'perplexity', apiKey: 'pplx', endpoint: origin }),
        { text: 'OpenAI 新模型' }
      )
      const body = JSON.parse(sent().body)
      expect(body.model).toBe('sonar')
      expect(body.messages).toEqual([{ role: 'user', content: 'OpenAI 新模型' }])
      expect(sent().headers.authorization).toBe('Bearer pplx')
      // The synthesis is the only text in the payload; it belongs on the top link.
      expect(hits[0]).toMatchObject({ url: 'https://p.example/1', snippet: '综合答案' })
    })

    it('accepts the bare citations list older payloads return', async () => {
      reply = {
        body: JSON.stringify({
          choices: [{ message: { content: '答案' } }],
          citations: ['https://p.example/2']
        })
      }
      const hits = await searchPerplexity(cfg({ provider: 'perplexity', apiKey: 'pplx', endpoint: origin }), {
        text: 'q'
      })
      expect(hits).toEqual([{ title: 'https://p.example/2', url: 'https://p.example/2', snippet: '答案' }])
    })

    it('keeps the answer as one hit when there is no link structure at all', async () => {
      reply = { body: JSON.stringify({ choices: [{ message: { content: '只有答案' } }] }) }
      const hits = await searchPerplexity(cfg({ provider: 'perplexity', apiKey: 'pplx', endpoint: origin }), {
        text: 'OpenAI 新模型'
      })
      expect(hits).toHaveLength(1)
      expect(hits[0].snippet).toBe('只有答案')
      expect(hits[0].url).toContain('perplexity.ai/search?q=')
    })
  })

  describe('zhipu-web', () => {
    it('posts search_query with a bearer token and reads search_result', async () => {
      reply = {
        body: JSON.stringify({
          search_result: [{ title: 'Z hit', link: 'https://z.example/1', content: '正文' }]
        })
      }
      const hits = await searchZhipuWeb(
        cfg({
          provider: 'zhipu-web',
          apiKey: 'z-key',
          endpoint: `${origin}/api/paas/v4/web_search`
        }),
        { text: 'OpenAI 新模型' }
      )
      expect(sent().target).toBe('/api/paas/v4/web_search')
      expect(sent().headers.authorization).toBe('Bearer z-key')
      expect(JSON.parse(sent().body)).toEqual({
        search_query: 'OpenAI 新模型',
        search_engine: 'search_std'
      })
      expect(hits[0]).toMatchObject({ title: 'Z hit', url: 'https://z.example/1', snippet: '正文' })
    })
  })

  describe('baidu', () => {
    const page = `<html><body>
      <div class="result c-container" mu="https://example.com/a">
        <h3 class="t"><a href="https://www.baidu.com/link?url=x">标题甲</a></h3>
        <div class="c-abstract">摘要甲</div>
      </div>
      <div class="result c-container" mu="https://example.com/ad" ec_ad="1">
        <h3><a href="/link?url=y">广告位</a></h3>
      </div>
      <div class="result c-container" mu="https://example.com/b">
        <h3 class="t"><a href="/link?url=z">标题乙</a></h3>
        <span class="c-span-last">摘要乙</span>
      </div>
    </body></html>`

    it('parses the result page and drops the ad slot', async () => {
      reply = { body: page, contentType: 'text/html; charset=utf-8' }
      const hits = await searchBaidu(cfg({ provider: 'baidu', apiKey: '', endpoint: `${origin}/s` }), {
        text: 'OpenAI 新模型'
      })
      const url = sentUrl()
      expect(url.pathname).toBe('/s')
      expect(url.searchParams.get('wd')).toBe('OpenAI 新模型')
      // The published page is the source of truth here: `mu` already holds the
      // real target, so no redirect has to be resolved per hit.
      expect(hits).toEqual([
        { title: '标题甲', url: 'https://example.com/a', snippet: '摘要甲' },
        { title: '标题乙', url: 'https://example.com/b', snippet: '摘要乙' }
      ])
    })

    it('reports a captcha page instead of pretending there were no results', async () => {
      reply = { body: '<html><body>请输入验证码</body></html>', contentType: 'text/html' }
      await expect(
        searchBaidu(cfg({ provider: 'baidu', apiKey: '', endpoint: `${origin}/s` }), { text: 'q' })
      ).rejects.toThrow(/人机验证/)
    })

    it('returns an empty list for a page with no organic results', () => {
      expect(parseBaiduHtml('<html><body><p>没有找到相关结果</p></body></html>', 5)).toEqual([])
    })
  })
})
