import type { SearchResult, SearchSettings } from '@shared/types'
import { runWithDeadline } from '../tools/read-webpage'
import { mt } from '@shared/mainI18n'

/**
 * Web search adapters.
 *
 * Every provider is normalised to `SearchResult[]` so the Ask pipeline never has
 * to care where the snippets came from. Failures throw `SearchError`; the caller
 * degrades to an answer without the web instead of failing the take.
 */
export class SearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchError'
  }
}

/**
 * A single provider call must never outlive the take. Eight seconds is longer
 * than any of these endpoints needs and still leaves room for the answer pass.
 */
export const SEARCH_TIMEOUT_MS = 8000

/**
 * Queries the planner may have in flight at once. The plan is at most two
 * queries, so this removes the staging delay without turning into a burst.
 */
const SEARCH_CONCURRENCY = 2

/**
 * Where `[perf]` lines go. The agent installs its own `log` for the duration of
 * a take; with no sink the adapter stays silent, which is what tests want.
 */
let perfSink: ((line: string) => void) | null = null

export function setSearchPerfLogger(sink: ((line: string) => void) | null): void {
  perfSink = sink
}

function logPerf(line: string): void {
  perfSink?.(line)
}

/** Coarse time bound a provider can honour. */
export type Freshness = 'day' | 'week' | 'month' | 'year'

/**
 * One retrieval request.
 *
 * A plain `string` stays valid everywhere (`SearchInput`), because the model's
 * own `web_search` argument is just keywords; hints only exist so the planner
 * can steer language, region and freshness without a second prompt round trip.
 */
export interface SearchQuery {
  text: string
  /** Language of the words themselves, e.g. `zh`, `en`. */
  lang?: string
  /** ISO-3166 alpha-2 region to prefer, e.g. `cn`, `us`. */
  country?: string
  freshness?: Freshness
  /** `news` opts into a provider's news index when it has one. */
  kind?: 'web' | 'news'
}

export type SearchInput = string | SearchQuery

function normalizeQuery(input: SearchInput): SearchQuery {
  const query = typeof input === 'string' ? { text: input } : input
  return { ...query, text: String(query.text ?? '').trim() }
}

/** A query only needs the rich shape when it actually carries a hint. */
export function searchInputOf(query: SearchQuery): SearchInput {
  return query.lang || query.country || query.freshness || query.kind ? query : query.text
}

const DEFAULTS = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  braveNews: 'https://api.search.brave.com/res/v1/news/search',
  tavily: 'https://api.tavily.com/search',
  duckduckgo: 'https://html.duckduckgo.com/html/',
  exa: 'https://api.exa.ai/search',
  serper: 'https://google.serper.dev/search',
  bing: 'https://api.bing.microsoft.com/v7.0/search',
  googleCse: 'https://www.googleapis.com/customsearch/v1',
  jina: 'https://s.jina.ai/',
  perplexity: 'https://api.perplexity.ai/chat/completions',
  zhipuWeb: 'https://open.bigmodel.cn/api/paas/v4/web_search',
  baidu: 'https://www.baidu.com/s',
  deepseek: 'https://api.deepseek.com/v1/tools/search'
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => codePointToString(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => codePointToString(Number(code)))
    // Ampersand last: a double-encoded `&amp;lt;` must not become `<`.
    .replace(/&amp;/gi, '&')
}

function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** Fallback page size when a caller passes a nonsense `maxResults`. */
const DEFAULT_LIMIT = 5

/** Dedupe key: same page even if the trailing slash or the fragment differs. */
function sourceKey(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    // URL normalizes the host; paths and query values can be case-sensitive.
    return parsed.toString()
  } catch { return url.trim().replace(/#.*$/, '').replace(/\/+$/, '') }
}

function limit(results: SearchResult[], max: number): SearchResult[] {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_LIMIT
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const item of results) {
    if (!item.url) continue
    const key = sourceKey(item.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const kept: SearchResult = {
      title: item.title.trim().slice(0, 160) || item.url,
      url: item.url,
      snippet: item.snippet.replace(/\s+/g, ' ').trim().slice(0, 400)
    }
    // Publication time is a ranking signal downstream; dropping it here would
    // throw away the only thing that separates fresh news from a reprint.
    if (item.publishedAt) kept.publishedAt = item.publishedAt
    out.push(kept)
    if (out.length >= cap) break
  }
  // Belt and braces: the caller's cap always wins, even if the list was short.
  return out.slice(0, cap)
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers ?? {}) }
  })
  return res
}

/**
 * Minimal attribute reader. DDG reorders attributes between builds, so nothing
 * here may depend on `class` coming first, or on any particular attribute order.
 */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (!(name in attrs)) attrs[name] = value
  }
  return attrs
}

function classTokens(attrs: Record<string, string>): string[] {
  return (attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

function hasClass(attrs: Record<string, string>, token: string): boolean {
  return classTokens(attrs).includes(token)
}

interface AnchorHit {
  start: number
  end: number
  attrs: Record<string, string>
  inner: string
}

/** Every `<a>` in document order, with attributes already decoded. */
function scanAnchors(html: string): AnchorHit[] {
  const hits: AnchorHit[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: parseAttributes(match[1]),
      inner: match[2]
    })
  }
  return hits
}

/** The snippet may be an `<a>`, a `<div>` or a `<span>` depending on the build. */
function findSnippetElement(blockHtml: string): string {
  const re = /<(a|div|span|p|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(blockHtml))) {
    if (hasClass(parseAttributes(match[2]), 'result__snippet')) return stripHtml(match[3])
  }
  return ''
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function extractUddg(url: string): string {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) return ''
  for (const pair of url.slice(queryStart + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) === 'uddg') return pair.slice(eq + 1)
  }
  return ''
}

const DDG_REDIRECT = /(?:^|\/\/)(?:[\w-]+\.)*duckduckgo\.com\/l\/\?/i
const RELATIVE_REDIRECT = /^\/l\/\?/i

/**
 * Unwraps `/l/?uddg=` hop links (`//duckduckgo.com/l/?uddg=…` and the absolute
 * form) and percent-decodes the real target. Recursion stops as soon as the
 * payload is no longer a DDG redirect, so ordinary URLs pass through intact.
 */
export function resolveDuckDuckGoRedirect(href: string): string {
  return resolveRedirect(decodeEntities(href).trim(), 0)
}

function resolveRedirect(href: string, depth: number): string {
  if (!href) return ''
  const absolute = href.startsWith('//') ? `https:${href}` : href
  if (depth >= 3) return absolute
  if (!DDG_REDIRECT.test(absolute) && !RELATIVE_REDIRECT.test(absolute)) return absolute
  const encoded = extractUddg(absolute)
  if (!encoded) return absolute
  const target = safeDecodeUriComponent(encoded)
  if (!target) return absolute
  return DDG_REDIRECT.test(target) || RELATIVE_REDIRECT.test(target)
    ? resolveRedirect(target, depth + 1)
    : target
}

/** Lower-cased host, or `''` for anything that is not an absolute http(s) URL. */
export function hostOf(url: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url)
  return match ? match[1].toLowerCase() : ''
}

function isUsableUrl(url: string): boolean {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return false
  const host = hostOf(url)
  return host !== '' && host !== 'duckduckgo.com' && !host.endsWith('.duckduckgo.com')
}

/** Ad furniture: DDG marks sponsored blocks with a class and a `y.js` hop. */
const AD_PATTERN = /result--ad|result-sponsored|y\.js|ad_domain|ad_provider/i

/**
 * Blanks out `<script>`/`<style>` bodies while keeping every offset intact.
 * Inline CSS legitimately mentions `.result--ad`, and scripts contain template
 * strings: neither may be mistaken for result markup.
 */
function blurScriptsAndStyles(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) =>
    ' '.repeat(block.length)
  )
}

/**
 * Pure DuckDuckGo HTML-parser. Split out of the fetch so the markup contract can
 * be tested against fixed fragments without touching the network.
 *
 * Block order and attribute order are irrelevant here: results are assembled
 * from `result__a` anchors, each snippet attaches to the preceding title, and
 * ads / duplicate URLs are dropped before the cap is applied.
 *
 * Ad detection looks only at the markup *between two elements* (the wrapper
 * tags in front of the anchor), never at a whole block, so a sponsored result
 * cannot poison the legitimate one that follows it.
 */
export function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = []
  const page = blurScriptsAndStyles(html)
  const anchors = scanAnchors(page)
  const titles = anchors.filter((anchor) => hasClass(anchor.attrs, 'result__a'))

  // For every element, the offset where its leading wrapper markup starts.
  const wrappers = new Map<number, number>()
  let previousEnd = 0
  for (const hit of anchors) {
    wrappers.set(hit.start, previousEnd)
    previousEnd = Math.max(previousEnd, hit.end)
  }

  for (const [index, anchor] of titles.entries()) {
    const url = resolveDuckDuckGoRedirect(anchor.attrs.href ?? '')
    if (!isUsableUrl(url)) continue
    const leading = page.slice(wrappers.get(anchor.start) ?? 0, anchor.start)
    if (AD_PATTERN.test(leading) || AD_PATTERN.test(anchor.attrs.href ?? '')) continue
    const next = titles[index + 1]
    const blockEnd = next ? next.start : page.length
    const title = stripHtml(anchor.inner)
    results.push({
      title: title || url,
      url,
      snippet: findSnippetElement(page.slice(anchor.start, blockEnd))
    })
  }

  if (results.length === 0) {
    // Lite markup: no `result__*` classes at all, so fall back to outbound links.
    for (const anchor of anchors) {
      const url = resolveDuckDuckGoRedirect(anchor.attrs.href ?? '')
      if (!isUsableUrl(url)) continue
      if (AD_PATTERN.test(anchor.attrs.href ?? '')) continue
      const title = stripHtml(anchor.inner)
      if (title.length < 3) continue
      results.push({ title, url, snippet: '' })
    }
  }

  return limit(results, max)
}

/**
 * DuckDuckGo's `kl` is a region-language pair. It is only sent when the planner
 * actually asked for one: a hard-coded region would quietly hide half the web
 * from every other user.
 */
const DDG_REGIONS: Record<string, string> = {
  cn: 'cn-zh',
  tw: 'tw-tzh',
  hk: 'hk-tzh',
  us: 'us-en',
  gb: 'uk-en',
  jp: 'jp-jp',
  kr: 'kr-kr',
  de: 'de-de',
  fr: 'fr-fr',
  es: 'es-es',
  ru: 'ru-ru',
  in: 'in-en',
  sg: 'sg-en'
}

function duckDuckGoRegion(query: SearchQuery): string {
  const country = (query.country ?? '').toLowerCase()
  if (country && DDG_REGIONS[country]) return DDG_REGIONS[country]
  const lang = (query.lang ?? '').toLowerCase().split(/[-_]/)[0]
  if (lang === 'zh') return country === 'tw' || country === 'hk' ? 'tw-tzh' : 'cn-zh'
  if (lang && DDG_REGIONS[lang]) return DDG_REGIONS[lang]
  if (lang && /^[a-z]{2}$/.test(lang)) return `wt-${lang}`
  return 'wt-wt'
}

/** DuckDuckGo HTML endpoint: no API key, but the markup is not a contract. */
export async function searchDuckDuckGo(
  input: SearchInput,
  max: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  const kl = duckDuckGoRegion(query)
  const url = `${DEFAULTS.duckduckgo}?q=${encodeURIComponent(query.text)}&kl=${kl}`
  const res = await get(url, { signal })
  if (!res.ok) throw new SearchError(`DuckDuckGo HTTP ${res.status}`)
  const html = await res.text()
  return parseDuckDuckGoHtml(html, max)
}

/** Brave returns `page_age` (ISO) on web hits and `age`/`page_age` on news hits. */
interface BraveHit {
  title?: string
  url?: string
  description?: string
  age?: string
  page_age?: string
}

function braveParams(query: SearchQuery, cfg: SearchSettings): string {
  const params = new URLSearchParams({
    q: query.text,
    count: String(Number.isFinite(cfg.maxResults) && cfg.maxResults > 0 ? cfg.maxResults : DEFAULT_LIMIT)
  })
  if (query.lang) params.set('search_lang', query.lang.toLowerCase())
  if (query.country) params.set('country', query.country.toUpperCase())
  if (query.freshness) params.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[query.freshness])
  return params.toString()
}

function bravoPublishedAt(hit: BraveHit): string | undefined {
  const raw = hit.page_age ?? hit.age ?? ''
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

/** Brave Search API, web or news index. */
export async function searchBrave(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Brave 需要 API Key'))
  // A caller-supplied endpoint always wins: it is the only way to point at a
  // proxy, and guessing a /news/ rewrite of it would break that.
  const base = cfg.endpoint
    ? cfg.endpoint
    : query.kind === 'news'
      ? DEFAULTS.braveNews
      : DEFAULTS.brave
  const url = `${base}?${braveParams(query, cfg)}`
  const res = await get(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey },
    signal
  })
  if (!res.ok) throw new SearchError(`Brave HTTP ${res.status}`)
  const body = (await res.json()) as {
    web?: { results?: BraveHit[] }
    results?: BraveHit[]
  }
  // News index flattens to `results`, the web index nests under `web`.
  const hits = body.results ?? body.web?.results ?? []
  const results = hits.map((item) => {
    const mapped: SearchResult = {
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: stripHtml(item.description ?? '')
    }
    const publishedAt = bravoPublishedAt(item)
    if (publishedAt) mapped.publishedAt = publishedAt
    return mapped
  })
  return limit(results, cfg.maxResults)
}

/** Tavily search API (LLM-oriented snippets). */
export async function searchTavily(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Tavily 需要 API Key'))
  const payload: Record<string, unknown> = {
    query: query.text,
    max_results: cfg.maxResults,
    include_answer: false,
    include_published_date: true,
    search_depth: 'basic'
  }
  if (query.freshness) {
    payload.time_range = query.freshness
  }
  if (query.kind === 'news') payload.topic = 'news'
  const res = await fetch(cfg.endpoint || DEFAULTS.tavily, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(payload),
    signal
  })
  if (!res.ok) throw new SearchError(`Tavily HTTP ${res.status}`)
  const body = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>
  }
  return limit(
    (body.results ?? []).map((item) => {
      const mapped: SearchResult = {
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: item.content ?? ''
      }
      if (item.published_date) mapped.publishedAt = item.published_date
      return mapped
    }),
    cfg.maxResults
  )
}

/** Self-hosted SearXNG instance returning JSON. */
export async function searchSearxng(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.endpoint) throw new SearchError(mt('SearXNG 需要填写实例地址'))
  const base = cfg.endpoint.replace(/\/+$/, '')
  const params = new URLSearchParams({
    q: query.text,
    format: 'json',
    language: query.lang ? query.lang.toLowerCase() : 'auto'
  })
  if (query.freshness) params.set('time_range', query.freshness)
  const url = `${base}/search?${params.toString()}`
  const res = await get(url, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) throw new SearchError(`SearXNG HTTP ${res.status}`)
  const body = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>
  }
  return limit(
    (body.results ?? []).map((item) => {
      const mapped: SearchResult = {
        title: item.title ?? '',
        url: item.url ?? '',
        snippet: item.content ?? ''
      }
      if (item.publishedDate) mapped.publishedAt = item.publishedDate
      return mapped
    }),
    cfg.maxResults
  )
}

// ---------------------------------------------------------------------------
// The rest of the catalogue. One function per backend, same contract as above:
// `(cfg, input, signal) => SearchResult[]`, empty list for an honest empty
// answer, `SearchError` for anything the caller must degrade around.
// ---------------------------------------------------------------------------

/** One body read, kept whole so an error path can quote the vendor's own text. */
interface BodyRead {
  raw: string
  json: unknown
}

/**
 * Reads the body once. A 200 with an empty body is a legitimate "no results" on
 * several of these endpoints, so an unparseable body is `json: null`, not a throw.
 */
async function readBody(res: Response): Promise<BodyRead> {
  const raw = await res.text()
  if (!raw.trim()) return { raw, json: null }
  try {
    return { raw, json: JSON.parse(raw) as unknown }
  } catch {
    return { raw, json: null }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * First non-empty string among `names`. Every vendor spells title/url/body
 * differently (`name`/`link`/`content`, `text`/`summary`…), and a single reader
 * keeps the adapters from turning into thirty lines of `if` each.
 */
function field(row: unknown, ...names: string[]): string {
  const record = asRecord(row)
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** Notification timestamps are not all ISO (`publishedDate`, `date`); normalise. */
function publishedOf(value: string): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

interface HitShape {
  url: string[]
  title: string[]
  /** Candidate body fields, first non-empty wins. */
  body: string[]
  date?: string[]
}

function mapHits(rows: unknown[], shape: HitShape): SearchResult[] {
  const out: SearchResult[] = []
  for (const row of rows) {
    const url = field(row, ...shape.url)
    if (!url) continue
    const mapped: SearchResult = {
      title: field(row, ...shape.title) || url,
      url,
      snippet: shape.body.map((name) => field(row, name)).find(Boolean) ?? ''
    }
    const publishedAt = shape.date ? publishedOf(field(row, ...shape.date)) : undefined
    if (publishedAt) mapped.publishedAt = publishedAt
    out.push(mapped)
  }
  return out
}

/** Appends query parameters to a base that may already carry some (`?cx=…`). */
function withQuery(base: string, params: Record<string, string>): string {
  try {
    const url = new URL(base)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    return url.toString()
  } catch {
    const search = new URLSearchParams(params).toString()
    return `${base}${base.includes('?') ? '&' : '?'}${search}`
  }
}

/** Reads the OpenAI-shaped `{error:{message,code}}` envelope these APIs share. */
function vendorError(body: unknown): string {
  const error = asRecord(asRecord(body).error)
  return field(error, 'message') || field(error, 'code')
}

function failure(provider: string, status: number, body: unknown): string {
  const detail = vendorError(body)
  return detail ? `${provider} HTTP ${status}：${detail}` : `${provider} HTTP ${status}`
}

/** POST + bearer/key headers are the same dance four times over. */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
}

/**
 * Exa. `contents.text` asks for whole-page text, which is what makes this worth
 * paying for: the answer stage can then cite the launch note instead of a blurb.
 */
export async function searchExa(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Exa 需要 API Key'))
  const res = await postJson(
    cfg.endpoint || DEFAULTS.exa,
    {
      query: query.text,
      numResults: Math.min(100, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT)),
      // 2000 characters is enough for a lede plus numbers, and keeps the take's
      // context budget predictable.
      contents: { text: { maxCharacters: 2000 } }
    },
    { 'x-api-key': cfg.apiKey },
    signal
  )
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Exa', res.status, json))
  return limit(
    mapHits(asArray(asRecord(json).results), {
      url: ['url'],
      title: ['title'],
      body: ['text', 'summary'],
      date: ['publishedDate']
    }),
    cfg.maxResults
  )
}

/** Serper: paid Google proxy, `organic` is already in ranking order. */
export async function searchSerper(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Serper 需要 API Key'))
  const res = await postJson(
    cfg.endpoint || DEFAULTS.serper,
    { q: query.text, num: Math.min(100, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT)) },
    // Not `Authorization`: Serper reads its own header name.
    { 'X-API-KEY': cfg.apiKey },
    signal
  )
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Serper', res.status, json))
  return limit(
    mapHits(asArray(asRecord(json).organic), { url: ['link', 'url'], title: ['title'], body: ['snippet'] }),
    cfg.maxResults
  )
}

/** Bing Web Search v7 (Azure subscription key, not a bearer token). */
export async function searchBing(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Bing 需要订阅密钥'))
  const url = withQuery(cfg.endpoint || DEFAULTS.bing, {
    q: query.text,
    count: String(Math.min(50, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT)))
  })
  const res = await get(url, {
    headers: { Accept: 'application/json', 'Ocp-Apim-Subscription-Key': cfg.apiKey },
    signal
  })
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Bing', res.status, json))
  const pages = asRecord(asRecord(json).webPages)
  return limit(
    mapHits(asArray(pages.value), { url: ['url'], title: ['name'], body: ['snippet'] }),
    cfg.maxResults
  )
}

/**
 * Where `cx` comes from. The Custom Search JSON API refuses to run without the
 * search-engine id and the settings screen has no third field for it, so it
 * rides in 自定义地址: either the full URL with `?cx=…`, or the bare id, which is
 * then paired with the official host.
 */
function googleCseTarget(cfg: SearchSettings): { base: string; cx: string } {
  const raw = (cfg.endpoint || '').trim()
  if (!raw) return { base: DEFAULTS.googleCse, cx: '' }
  if (!/^https?:\/\//i.test(raw)) return { base: DEFAULTS.googleCse, cx: raw }
  try {
    const url = new URL(raw)
    return { base: `${url.origin}${url.pathname}`, cx: url.searchParams.get('cx') ?? '' }
  } catch {
    return { base: raw, cx: '' }
  }
}

/** Google Custom Search JSON API. Returns nothing unless both key and `cx` exist. */
export async function searchGoogleCse(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Google 可编程搜索需要 API Key'))
  const { base, cx } = googleCseTarget(cfg)
  if (!cx) throw new SearchError(mt('Google 可编程搜索还需要 cx（搜索引擎 ID）：填在自定义地址里'))
  const url = withQuery(base, {
    key: cfg.apiKey,
    cx,
    q: query.text,
    num: String(Math.min(10, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT)))
  })
  const res = await get(url, { headers: { Accept: 'application/json' }, signal })
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Google CSE', res.status, json))
  return limit(
    mapHits(asArray(asRecord(json).items), { url: ['link'], title: ['title'], body: ['snippet'] }),
    cfg.maxResults
  )
}

/** Markdown links, the only structure the plain-text reader response guarantees. */
function parseJinaMarkdown(raw: string): SearchResult[] {
  const hits: SearchResult[] = []
  const re = /\[([^\]\n]{2,200})\]\((https?:\/\/[^)\s]+)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) {
    hits.push({ title: match[1].trim(), url: match[2], snippet: '' })
  }
  return hits
}

/**
 * Jina Reader search. No key is required, so the adapter must not demand one;
 * the response is either `{data:[…]}` (with `Accept: application/json`) or the
 * reader's markdown, and both shapes are accepted here.
 */
export async function searchJina(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const res = await get(withQuery(cfg.endpoint || DEFAULTS.jina, { q: query.text }), {
    headers,
    signal
  })
  const { raw, json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Jina', res.status, json))
  const rows = asArray(asRecord(json).data)
  if (rows.length) {
    return limit(
      mapHits(rows, { url: ['url'], title: ['title'], body: ['content', 'description'] }),
      cfg.maxResults
    )
  }
  return limit(parseJinaMarkdown(raw), cfg.maxResults)
}

/**
 * Perplexity is an answer engine, not an index: the body is the synthesised
 * reply and the links live next to it (`search_results`, or bare `citations`).
 */
export async function searchPerplexity(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('Perplexity 需要 API Key'))
  const res = await postJson(
    cfg.endpoint || DEFAULTS.perplexity,
    { model: 'sonar', messages: [{ role: 'user', content: query.text }] },
    { Authorization: `Bearer ${cfg.apiKey}` },
    signal
  )
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure('Perplexity', res.status, json))
  const body = asRecord(json)
  const answer = field(asRecord(asArray(body.choices)[0]).message, 'content')
  let hits = mapHits(asArray(body.search_results), {
    url: ['url'],
    title: ['title'],
    body: ['snippet'],
    date: ['date']
  })
  if (!hits.length) {
    // Older/leaner payloads list citations as plain URLs.
    hits = asArray(body.citations)
      .map((item) => (typeof item === 'string' ? item : field(item, 'url')))
      .filter((url) => /^https?:\/\//i.test(url))
      .map((url) => ({ title: url, url, snippet: '' }))
  }
  if (!hits.length) {
    // No citation block at all: keep the answer as one hit. It needs a URL to
    // survive `limit()`, and Perplexity's own search page is the honest target.
    if (!answer) return []
    return limit(
      [
        {
          title: query.text,
          url: `https://www.perplexity.ai/search?q=${encodeURIComponent(query.text)}`,
          snippet: answer
        }
      ],
      cfg.maxResults
    )
  }
  // The synthesis is the most useful text in the payload; attach it where the
  // top link has no snippet of its own.
  if (answer && !hits[0].snippet) hits[0].snippet = answer
  return limit(hits, cfg.maxResults)
}

/** Zhipu (BigModel) web search; same key as GLM chat. */
export async function searchZhipuWeb(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('智谱 Web 搜索需要 API Key'))
  const res = await postJson(
    cfg.endpoint || DEFAULTS.zhipuWeb,
    { search_query: query.text, search_engine: 'search_std' },
    { Authorization: `Bearer ${cfg.apiKey}` },
    signal
  )
  const { json } = await readBody(res)
  if (!res.ok) throw new SearchError(failure(mt('智谱 Web 搜索'), res.status, json))
  return limit(
    mapHits(asArray(asRecord(json).search_result), {
      url: ['link', 'url'],
      title: ['title'],
      body: ['content', 'snippet']
    }),
    cfg.maxResults
  )
}

/**
 * Baidu has no free JSON search API (the Wenxin `search` RPC needs an
 * access_token minted from an AK/SK pair and is not offered to every account),
 * so this reads the organic results out of the public result page.
 *
 * `mu` on the result container is the one stable anchor: the `<h3><a href>`
 * carries a `/link?url=…` redirect that would cost a second request per hit to
 * resolve, while `mu` already holds the real target.
 */
export function parseBaiduHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = []
  const containers: Array<{ end: number; url: string; html: string }> = []
  const re = /<div\b([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const attrs = match[1]
    const url = parseAttributes(attrs).mu ?? ''
    if (!/^https?:\/\//i.test(url)) continue
    // Sponsored slots carry `ec_ad`/`data-adblock`; they are placeholders, not answers.
    if (/\bec_ad\b|ec_ad_|data-adblock/i.test(attrs)) continue
    containers.push({ end: match.index + match[0].length, url, html })
  }

  for (const [index, container] of containers.entries()) {
    const block = html.slice(container.end, containers[index + 1]?.end ?? html.length)
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block)
    if (!heading) continue
    const title = stripHtml(heading[1])
    if (!title) continue
    results.push({ title, url: container.url, snippet: baiduSnippet(block) })
  }

  if (results.length === 0) {
    // Layout change: no `mu` at all, so fall back to outbound anchors.
    for (const anchor of scanAnchors(html)) {
      const url = anchor.attrs.href ?? ''
      if (!/^https?:\/\//i.test(url) || /(?:^|\.)baidu\.com$/i.test(hostOf(url))) continue
      const title = stripHtml(anchor.inner)
      if (title.length < 4) continue
      results.push({ title, url, snippet: '' })
    }
  }
  return limit(results, max)
}

function baiduSnippet(block: string): string {
  const re = /<(div|span|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(block))) {
    const className = parseAttributes(match[2]).class ?? ''
    if (!/c-abstract|content-right_|c-span-last|c-abstract-new/i.test(className)) continue
    const text = stripHtml(match[3])
    if (text) return text
  }
  return ''
}

/** Baidu result page. No key; a burst of requests earns a captcha, not a ban. */
export async function searchBaidu(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  const url = withQuery(cfg.endpoint || DEFAULTS.baidu, {
    wd: query.text,
    ie: 'utf-8',
    rn: String(Math.min(50, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT)))
  })
  const res = await get(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal
  })
  if (!res.ok) throw new SearchError(`Baidu HTTP ${res.status}`)
  const html = await res.text()
  const results = parseBaiduHtml(html, cfg.maxResults)
  // Baidu answers a throttled request with a captcha page and HTTP 200; an empty
  // parse of a page that never mentioned the query is that captcha, not "no hits".
  if (results.length === 0 && /验证码|安全验证|antispider/i.test(html)) {
    throw new SearchError(mt('Baidu 要求人机验证，稍后重试或换用其它服务商'))
  }
  return results
}

/** Every status `/v1/tools/search` documents, in the docs' own words. */
const DEEPSEEK_STATUS: Record<number, string> = {
  400: mt('请求参数不合法'),
  401: mt('API Key 无效'),
  402: mt('账户余额不足'),
  403: mt('没有调用该接口的权限'),
  404: mt('接口地址不存在'),
  408: mt('上游请求超时'),
  413: mt('请求体过大'),
  429: mt('超过 QPS 限制'),
  504: mt('上游网关超时')
}

function deepSeekFailure(status: number, body: unknown, raw: string): string {
  const hint = DEEPSEEK_STATUS[status] ?? (status >= 500 ? mt('服务端错误') : '')
  const label = mt('DeepSeek 检索失败（HTTP {{status}}{{hint}}）', {
    status,
    hint: hint ? `：${hint}` : ''
  })
  const detail = vendorError(body) || raw.trim().slice(0, 200)
  return detail ? `${label}：${detail}` : label
}

/**
 * The settings field holds the *base* URL (`https://api.deepseek.com`), not the
 * full path, so a custom endpoint is completed here rather than demanded of the
 * user. A value that already names the route is used verbatim.
 */
function deepSeekSearchUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (!base) return DEFAULTS.deepseek
  if (/\/tools\/search$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/tools/search`
  return `${base}/v1/tools/search`
}

interface DeepSeekHit {
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  date?: string
}

/**
 * DeepSeek 搜索 (`POST /v1/tools/search`).
 *
 * `need_content` is opt-in because whole-page text is what the request is billed
 * on: it is only requested for a take that wants more than three hits, where the
 * extra body is actually read. Without it `content` comes back as an empty
 * string, so the body falls back to `summary` and then to `snippet`.
 */
export async function searchDeepSeek(
  cfg: SearchSettings,
  input: SearchInput,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const query = normalizeQuery(input)
  if (!query.text) return []
  if (!cfg.apiKey) throw new SearchError(mt('DeepSeek 搜索需要 API Key'))
  const count = Math.min(50, Math.max(1, Math.round(cfg.maxResults) || DEFAULT_LIMIT))
  const payload: Record<string, unknown> = {
    query: query.text,
    count,
    need_content: count > 3
  }
  const res = await postJson(
    deepSeekSearchUrl(cfg.endpoint),
    payload,
    { Authorization: `Bearer ${cfg.apiKey}` },
    signal
  )
  const { raw, json } = await readBody(res)
  if (!res.ok) throw new SearchError(deepSeekFailure(res.status, json, raw))
  const hits = asArray(asRecord(json).results) as DeepSeekHit[]
  // An empty `results` array is the documented "nothing found", not an error.
  return limit(
    mapHits(hits, {
      url: ['url'],
      title: ['title'],
      body: ['content', 'summary', 'snippet'],
      date: ['date']
    }),
    count
  )
}

export interface SearchWebOptions {
  /** Per-query expansion, e.g. a news roundup; ordinary connections keep their own page size. */
  maxResults?: number
  /** Overrides `SEARCH_TIMEOUT_MS`; `0` disables the deadline. */
  timeoutMs?: number
}

/**
 * Dispatches to the configured provider, under a hard deadline.
 *
 * Measured: a stalled provider used to block the entire take with no ceiling at
 * all. Now the call either answers inside its budget or throws `SearchError`, so
 * the caller can record the failed round and answer from the rounds that landed.
 */
export async function searchWeb(
  cfg: SearchSettings,
  query: SearchInput,
  signal?: AbortSignal,
  options: SearchWebOptions = {}
): Promise<SearchResult[]> {
  const request = normalizeQuery(query)
  if (!request.text) return []
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
  const label = `${cfg.provider}/${request.kind ?? 'web'}`
  const started = Date.now()
  const completed: SearchResult[] = []
  const outcome = await runWithDeadline(
    (bounded) => {
      if (!cfg.strategy || cfg.strategy === 'single') return dispatchSearch(cfg, request, bounded)
      return searchConnections(cfg, request, bounded, timeoutMs, completed, options.maxResults)
    },
    signal,
    timeoutMs
  )
  const ms = Date.now() - started

  if (outcome.ok) {
    logPerf(`[perf] search ${ms}ms ${label} hits=${outcome.value.length} "${request.text}"`)
    return outcome.value
  }
  if (completed.length && outcome.reason === 'timeout') return rankSources(completed)
  logPerf(`[perf] search ${ms}ms ${label} ${outcome.reason} "${request.text}"`)
  if (outcome.reason === 'timeout') {
    throw new SearchError(
      mt('检索超时（{{seconds}}s）', { seconds: Math.round(timeoutMs / 1000) })
    )
  }
  if (outcome.reason === 'aborted') throw new SearchError(mt('检索已取消'))
  throw new SearchError(outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
}

/** Uses saved, enabled connections without changing any provider's credentials. */
async function searchConnections(cfg: SearchSettings, query: SearchQuery, signal: AbortSignal, budgetMs: number, completed: SearchResult[], maxResults?: number): Promise<SearchResult[]> {
  const connections = (cfg.connections ?? []).filter(connection => connection.enabled)
  if (!connections.length) throw new SearchError(mt('没有启用的搜索连接'))
  const errors: string[] = []
  const attempt = async (connection: typeof connections[number]): Promise<SearchResult[]> => {
    if (signal.aborted) return []
    const perConnectionMs = budgetMs > 0 ? Math.max(1, Math.floor(budgetMs / Math.ceil(connections.length / (cfg.strategy === 'aggregate' ? 2 : 1)))) : 0
    const outcome = await runWithDeadline(bounded => dispatchSearch({ ...cfg, ...connection, maxResults: maxResults ?? connection.maxResults }, query, bounded), signal, perConnectionMs)
    if (outcome.ok && outcome.value.length) { completed.push(...outcome.value); return outcome.value }
    errors.push(`${connection.name}: ${outcome.ok ? mt('没有检索到结果') : outcome.reason === 'error' ? String(outcome.error instanceof Error ? outcome.error.message : outcome.error) : outcome.reason}`)
    return []
  }
  if (cfg.strategy === 'fallback') {
    for (const connection of connections) {
      if (signal.aborted) break
      const hits = await attempt(connection)
      if (hits.length) return hits
    }
  } else await runPool(connections, 2, async connection => { await attempt(connection) })
  if (completed.length) return rankSources(completed)
  if (signal.aborted) throw new SearchError(mt('检索已取消'))
  throw new SearchError(errors.join('; '))
}

/**
 * One provider, never a fan-out.
 *
 * Every id in `SearchProvider` has its own adapter below; the `default` arm is
 * only reachable from a settings file written by a newer build, and DuckDuckGo
 * (keyless, always available) is the least surprising thing to do there.
 */
async function dispatchSearch(
  cfg: SearchSettings,
  request: SearchQuery,
  signal: AbortSignal | undefined
): Promise<SearchResult[]> {
  switch (cfg.provider) {
    case 'brave':
      return searchBrave(cfg, request, signal)
    case 'tavily':
      return searchTavily(cfg, request, signal)
    case 'searxng':
      return searchSearxng(cfg, request, signal)
    case 'exa':
      return searchExa(cfg, request, signal)
    case 'serper':
      return searchSerper(cfg, request, signal)
    case 'bing':
      return searchBing(cfg, request, signal)
    case 'google-cse':
      return searchGoogleCse(cfg, request, signal)
    case 'jina':
      return searchJina(cfg, request, signal)
    case 'perplexity':
      return searchPerplexity(cfg, request, signal)
    case 'zhipu-web':
      return searchZhipuWeb(cfg, request, signal)
    case 'baidu':
      return searchBaidu(cfg, request, signal)
    case 'deepseek':
      return searchDeepSeek(cfg, request, signal)
    case 'duckduckgo':
    default:
      return searchDuckDuckGo(request, cfg.maxResults, signal)
  }
}

export interface SearchRound {
  query: SearchQuery
  results: SearchResult[]
  error?: string
}

/**
 * Runs `task` over `items` with at most `limit` in flight, preserving index
 * order in whatever the task writes. Used by the search planner and by the
 * agent's page reads; no dependency, no scheduler.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
}

/**
 * Runs a small, fixed set of queries and merges them.
 *
 * At most two in flight: the second query usually corroborates the first, and an
 * unbounded burst is exactly what free endpoints throttle — but waiting for the
 * first to finish before starting the second adds a whole round trip for nothing
 * on a news question. Duplicate text is dropped before dispatch.
 */
export async function searchPlanned(
  cfg: SearchSettings,
  queries: SearchQuery[],
  signal?: AbortSignal,
  budget = MAX_SEARCH_QUERIES,
  options: SearchWebOptions = {}
): Promise<SearchRound[]> {
  const plan: SearchQuery[] = []
  const executed = new Set<string>()
  for (const query of queries.slice(0, Math.max(1, budget))) {
    const text = query.text.trim()
    const key = text.toLowerCase()
    if (!text || executed.has(key)) continue
    executed.add(key)
    plan.push(query.text === text ? query : { ...query, text })
  }

  const rounds: SearchRound[] = new Array(plan.length)
  await runPool(plan, SEARCH_CONCURRENCY, async (query, index) => {
    try {
      const input = searchInputOf(query)
      // Keep the three-argument call when no override exists: callers and tests
      // treat the provider call as `(cfg, input, signal)`.
      const results = options.timeoutMs
        ? await searchWeb(cfg, input, signal, options)
        : await searchWeb(cfg, input, signal)
      rounds[index] = { query, results }
    } catch (err) {
      rounds[index] = {
        query,
        results: [],
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
  return rounds
}

/** Formats results into the compact block the model reads. */
export function formatSearchResults(results: SearchResult[]): string {
  return results
    .map((item, index) => {
      const line = `[${index + 1}] ${item.title} — ${item.url}`
      // The date travels with the link: without it the model cannot tell a
      // fresh report from a two-year-old page that merely ranks well.
      const info = assessRecency(item)
      const published = info.publishedAt ? info.publishedAt.slice(0, 10) : ''
      if (published && info.eventDate && published !== info.eventDate) {
        return mt('{{line}}（事件日期：{{event}}；页面发布于：{{published}}）', {
          line,
          event: info.eventDate,
          published
        })
      }
      if (info.eventDate) return mt('{{line}}（事件日期：{{event}}）', { line, event: info.eventDate })
      if (published) return mt('{{line}}（页面发布于：{{published}}）', { line, published })
      return line
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Retrieval planning: question type -> queries -> freshness -> read budget
// ---------------------------------------------------------------------------

/**
 * Budgets. Deliberately tiny: a voice take must not turn into a research
 * project, and three paid API calls per question is the ceiling this product
 * can afford. Two queries cover zh+en, one extra call is the follow-up.
 */
export const MAX_SEARCH_QUERIES = 2
/** A roundup covers several topics; the per-request result setting is not its total. */
export const MAX_DIGEST_QUERIES = 6
export const MAX_SEARCH_CALLS = 3
export const MAX_DEEP_READS = 3

export type QuestionKind =
  | 'news'
  | 'realtime'
  | 'technical'
  | 'research'
  | 'comparison'
  | 'language'
  | 'stable'

/**
 * Ordered, first match wins. `realtime` sits in front of `news` on purpose:
 * "今天天气" is a forecast lookup, not journalism, and it must keep a single
 * query so the structured weather API stays the primary source.
 */
const KIND_HINTS: Array<{ kind: QuestionKind; pattern: RegExp }> = [
  {
    kind: 'language',
    pattern:
      /翻译|润色|改写|摘要|总结一下|纠错|换个说法|语气|translate|rewrite|polish|summari[sz]e|proofread/i
  },
  {
    kind: 'realtime',
    pattern:
      /天气|气温|下雨|降雨|台风|空气质量|雾霾|限行|股价|股票|汇率|利率|油价|金价|房价|比分|赛果|赛程|航班|车次|时刻表|票价|现价|报价|weather|forecast|stock price|share price|exchange rate|\bscore\b|flight status/i
  },
  {
    kind: 'research',
    pattern:
      /研究|论文|试验|临床|疗效|副作用|可信度|证据|期刊|同行评审|study|trial|paper|journal|clinical|evidence|peer.reviewed|meta.analysis/i
  },
  {
    kind: 'comparison',
    pattern:
      /对比|比较|哪个好|哪个更|区别|差异|优缺点|值不值|还是买|\bvs\.?\b|versus|compare|comparison|better than|pros and cons/i
  },
  {
    kind: 'news',
    pattern:
      /新闻|最新|今天|今日|昨天|突发|官宣|发布会|公告|进展|头条|国际|科技圈|news|today|latest|breaking|announce|rollout/i
  },
  {
    kind: 'technical',
    pattern:
      /版本|更新|功能|文档|接口|\bapi\b|sdk|库|框架|模型|参数|规格|显存|性能|跑分|仓库|项目|开源|github|docs|release|feature|benchmark|spec|vram|firmware/i
  }
]

/**
 * The question's own type decides how it may be answered: a pure language task
 * must not hit the web at all, while a news question is worthless without a
 * time bound. Exported because the tests and the prompt layer both need it.
 */
export function classifyQuestion(text: string): QuestionKind {
  const source = String(text ?? '')
  for (const hint of KIND_HINTS) {
    if (hint.pattern.test(source)) {
      // Model/version lookups need the documentation window. Earlier language,
      // weather and other explicit task matches retain their original priority.
      if (hint.kind === 'news' && /(?:最新|latest|newest).{0,30}(?:模型|版本|\bmodel\b|\bversion\b)/i.test(source) &&
          !/新闻|头条|资讯|\b(?:news|headlines|roundup)\b/i.test(source)) return 'technical'
      return hint.kind
    }
  }
  return 'stable'
}

/** Chinese surface forms -> English search terms. Order-insensitive on purpose. */
const EN_TERMS: Array<[string, string]> = [
  ['人工智能', 'artificial intelligence'],
  ['大语言模型', 'large language model'],
  ['大模型', 'large language model'],
  ['机器学习', 'machine learning'],
  ['新闻发布会', 'press conference'],
  ['发布会', 'launch event'],
  ['医学', 'medical'],
  ['医疗', 'medical'],
  ['医药', 'pharma'],
  ['研究', 'study'],
  ['论文', 'paper'],
  ['临床', 'clinical'],
  ['试验', 'trial'],
  ['可信度', 'credibility'],
  ['证据', 'evidence'],
  ['期刊', 'journal'],
  ['国际', 'global'],
  ['全球', 'global'],
  ['科技', 'tech'],
  ['中国', 'China'],
  ['美国', 'US'],
  ['新闻', 'news'],
  ['最新', 'latest'],
  ['今天', 'today'],
  ['今日', 'today'],
  ['昨天', 'yesterday'],
  ['本周', 'this week'],
  ['本月', 'this month'],
  ['今年', 'this year'],
  ['突发', 'breaking'],
  ['发布', 'release'],
  ['官宣', 'announcement'],
  ['公告', 'announcement'],
  ['更新', 'update'],
  ['版本', 'version'],
  ['新功能', 'new feature'],
  ['功能', 'feature'],
  ['特性', 'feature'],
  ['模型', 'model'],
  ['参数', 'specs'],
  ['规格', 'specs'],
  ['显存', 'VRAM'],
  ['性能', 'performance'],
  ['跑分', 'benchmark'],
  ['价格', 'price'],
  ['股价', 'stock price'],
  ['对比', 'vs'],
  ['比较', 'vs'],
  ['区别', 'difference'],
  ['优缺点', 'pros and cons'],
  ['哪个好', 'which is better'],
  ['项目', 'project'],
  ['仓库', 'repository'],
  ['开源', 'open source'],
  ['文档', 'docs'],
  ['接口', 'API'],
  ['教程', 'tutorial'],
  ['如何', 'how to'],
  ['为什么', 'why'],
  ['多少', ''],
  ['什么', ''],
  ['怎么样', ''],
  ['怎么', ''],
  ['是否', ''],
  ['哪些', '']
]

const EN_TERMS_SORTED = [...EN_TERMS].sort((a, b) => b[0].length - a[0].length)

/** Time words go last in English queries: "AI news today", not "today AI news". */
const EN_TIME_WORDS = new Set(['today', 'yesterday', 'latest', 'breaking', 'this week', 'this month', 'this year'])

const CJK = /[\u3400-\u9fff]/

/**
 * Best-effort zh -> en keyword variant, no model call.
 *
 * A Chinese question searched only in Chinese misses the primary English
 * coverage of anything global (a US launch, a GitHub release, a paper). This is
 * a glossary, not a translator: entities and identifiers survive untouched and
 * unmapped words are simply dropped.
 */
export function toEnglishQuery(text: string): string {
  const source = String(text ?? '')
  if (!source.trim() || !CJK.test(source)) return ''
  let rest = source
  const mapped: string[] = []
  for (const [zh, en] of EN_TERMS_SORTED) {
    if (!zh || !rest.includes(zh)) continue
    if (en) mapped.push(en)
    rest = rest.split(zh).join(' ')
  }
  const latin = rest.match(/[A-Za-z][A-Za-z0-9.+#-]*|\d{2,}/g) ?? []
  const nonTime = mapped.filter((term) => !EN_TIME_WORDS.has(term))
  const time = mapped.filter((term) => EN_TIME_WORDS.has(term))
  const tokens = [...new Set([...latin, ...nonTime, ...time].map((token) => token.trim()))].filter(
    Boolean
  )
  if (!tokens.length) return ''
  const english = tokens.join(' ')
  return english.toLowerCase() === source.trim().toLowerCase() ? '' : english
}

/** Filler that adds nothing to an index lookup but a lot of noise. */
const ZH_FILLER = /(有哪些|有什么|是什么|怎么回事|怎么样|为什么|多少|哪些|请问|帮我|查一下|了解一下)/g
const ZH_PUNCT = /[，。？！、；：“”‘’（）()【】《》〈〉…—~!?,.;:\s]+/g

/**
 * Opposite direction of `toEnglishQuery`: a Chinese keyword variant.
 *
 * The router usually writes Chinese keywords for a Chinese question, but not
 * always — a model that answers with `AI news today` would leave the Chinese
 * coverage unsearched, which is the same failure mirrored.
 */
export function toChineseQuery(text: string): string {
  const source = String(text ?? '')
  if (!CJK.test(source)) return ''
  const cleaned = source
    .replace(ZH_FILLER, ' ')
    .replace(ZH_PUNCT, ' ')
    .replace(/(的|了|吗|呢|吧|啊|呀)/g, ' ')
    .trim()
  const tokens = cleaned
    .split(' ')
    .filter((token) => token && (CJK.test(token) || /[A-Za-z0-9]/.test(token)))
    .slice(0, 4)
  if (!tokens.length) return ''
  return tokens.join(' ')
}

export interface QueryPlan {
  kind: QuestionKind
  /** Ordered; the first entry is the primary query. */
  queries: SearchQuery[]
  freshness?: Freshness
  /** How many page reads the answer stage may spend. */
  deepRead: number
  /** True when the question is about the last day or two. */
  urgent: boolean
  digest?: boolean
}

/** News roundups need breadth; translating a news headline is still a language task. */
export function isNewsDigest(text: string): boolean {
  return /新闻|资讯|快讯|动态|\bnews\b|roundup|round.up/i.test(text) &&
    /今天|今日|本周|这周|最新|汇总|盘点|有哪些|有什么|全部|所有|today|latest|roundup|round.up|this week/i.test(text) &&
    !/翻译|润色|改写|这句话|这篇|这条|这则|translate|rewrite|this (?:article|sentence|headline)/i.test(text)
}

const FRESHNESS_BY_KIND: Partial<Record<QuestionKind, Freshness>> = {
  news: 'week',
  technical: 'month',
  research: 'year',
  comparison: 'year'
}

const DEEP_READS_BY_KIND: Record<QuestionKind, number> = {
  news: 3,
  research: 3,
  technical: 2,
  comparison: 2,
  realtime: 0,
  language: 0,
  stable: 0
}

/** Kinds whose answer is wrong if it only saw one language's coverage. */
const BILINGUAL_KINDS = new Set<QuestionKind>(['news', 'research', 'comparison', 'technical'])

const TODAY_HINT = /今天|今日|刚刚|今早|今晚|今天早上|breaking|today|just now/i

/**
 * Turns a question plus the model's keywords into a small, typed query plan.
 *
 * Invariants: at most `MAX_SEARCH_QUERIES` queries, the primary query is always
 * first and never rewritten, and hints are only attached where the provider
 * actually accepts them (so a plain stock lookup stays a plain string).
 */
export function planSearch(
  question: string,
  primary: string,
  opts: { bilingual?: boolean; maxQueries?: number } = {}
): QueryPlan {
  const digest = isNewsDigest(question)
  const kind = digest ? 'news' : classifyQuestion(question || primary)
  const text = (primary || question || '').trim()
  const urgent = kind === 'news' && TODAY_HINT.test(question)
  const freshness: Freshness | undefined = urgent ? 'day' : FRESHNESS_BY_KIND[kind]
  const budget = digest ? MAX_DIGEST_QUERIES : MAX_SEARCH_QUERIES
  const maxQueries = Math.max(1, Math.min(opts.maxQueries ?? budget, budget))
  const queries: SearchQuery[] = []

  if (text) {
    const first: SearchQuery = { text }
    if (freshness) first.freshness = freshness
    if (kind === 'news') first.kind = 'news'
    // A Latin-only primary on a bilingual kind is searched as English, so the
    // engine returns English coverage instead of guessing from the locale.
    if (!CJK.test(text) && BILINGUAL_KINDS.has(kind)) first.lang = 'en'
    queries.push(first)
  }

  const bilingual = opts.bilingual !== false
  if (bilingual && text && BILINGUAL_KINDS.has(kind) && queries.length < maxQueries) {
    const english = toEnglishQuery(text) || toEnglishQuery(question)
    const chinese = CJK.test(text) ? '' : toChineseQuery(question)
    const variant: SearchQuery | null = english
      ? { text: english, lang: 'en' }
      : chinese
        ? { text: chinese, lang: 'zh' }
        : null
    // Never duplicate the language the primary already covers.
    if (variant && variant.text !== text) {
      if (freshness) variant.freshness = freshness
      if (kind === 'news') variant.kind = 'news'
      queries.push(variant)
    }
  }

  if (digest && text) {
    const ai = /\bai\b|人工智能|大模型|机器学习/i.test(question)
    const facets = ai
      ? (CJK.test(question) ? ['模型发布', '产品与应用', '开源与研究', '产业与政策'] : ['model releases', 'products and applications', 'open source and research', 'industry and policy'])
      : (CJK.test(question) ? ['官方发布', '最新进展', '行业动态', '独立报道'] : ['official announcements', 'latest developments', 'industry updates', 'independent reporting'])
    for (const facet of facets) {
      if (queries.length >= maxQueries) break
      queries.push({ text: `${text} ${facet}`, kind: 'news', freshness, lang: CJK.test(question) ? 'zh' : 'en' })
    }
  }

  return {
    kind,
    queries,
    freshness,
    urgent,
    deepRead: DEEP_READS_BY_KIND[kind],
    ...(digest ? { digest: true } : {})
  }
}

// ---------------------------------------------------------------------------
// Dates: event time vs publication time
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * First explicit calendar date in a string, as `YYYY-MM-DD`.
 *
 * Only unambiguous forms are read; a bare "10/19" is skipped rather than guessed,
 * because a wrong date is worse than no date.
 */
export function extractDate(text: string): string | undefined {
  const source = String(text ?? '')
  let match = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(source)
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(source)
  if (match) {
    const day = Number(match[3])
    // `2026/10/19` and `2026-10-19` are unambiguously year-first.
    return isoDate(Number(match[1]), Number(match[2]), day)
  }
  match = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(source)
  if (match) {
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()]
    if (month) return isoDate(Number(match[3]), month, Number(match[2]))
  }
  match = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(source)
  if (match) {
    const month = MONTHS[match[2].slice(0, 3).toLowerCase()]
    if (month) return isoDate(Number(match[3]), month, Number(match[1]))
  }
  return undefined
}

export interface RecencyInfo {
  /** The date the article is *about*, when the snippet states one. */
  eventDate?: string
  /** What the provider says the page was published. */
  publishedAt?: string
  /** Age of the event, falling back to publication time. */
  ageHours?: number
  basis: 'event' | 'published' | 'none'
}

function hoursBetween(then: Date, now: Date): number {
  const delta = (now.getTime() - then.getTime()) / 3_600_000
  // A clock-skewed "future" date is treated as brand new, never as negative age.
  return delta < 0 ? 0 : delta
}

/**
 * Separates the event date from the publication date.
 *
 * This is the difference between news and an update: a 2023 analysis refreshed
 * today still reports 2023 events, so the event date wins whenever one is
 * stated.
 */
export function assessRecency(result: SearchResult, now: Date = new Date()): RecencyInfo {
  const eventDate =
    extractDate(result.snippet) ?? extractDate(result.title) ?? extractDate(result.url)
  let publishedAt: string | undefined
  if (result.publishedAt) {
    const parsed = Date.parse(result.publishedAt)
    if (Number.isFinite(parsed)) publishedAt = new Date(parsed).toISOString()
  }
  const effective = eventDate ?? publishedAt
  if (!effective) return { publishedAt, basis: 'none' }
  const ageHours = hoursBetween(new Date(effective), now)
  return {
    eventDate,
    publishedAt,
    ageHours,
    basis: eventDate ? 'event' : 'published'
  }
}

/**
 * Drops items whose *known* age exceeds the window. Undated items are kept: not
 * knowing a date is not evidence that the item is old.
 */
export function filterByRecency(
  results: SearchResult[],
  opts: { now?: Date; maxAgeHours?: number } = {}
): SearchResult[] {
  const now = opts.now ?? new Date()
  const maxAgeHours = opts.maxAgeHours ?? 48
  return results.filter((result) => {
    const info = assessRecency(result, now)
    if (info.ageHours === undefined) return true
    return info.ageHours <= maxAgeHours
  })
}

/** A calendar-day roundup must not label yesterday's or tomorrow's known events as today. */
export function filterTodayNews(results: SearchResult[], now: Date = new Date()): SearchResult[] {
  const localDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const today = localDay(now)
  return results.filter(result => {
    const info = assessRecency(result, now)
    const day = info.eventDate ?? (info.publishedAt ? localDay(new Date(info.publishedAt)) : undefined)
    // Undated leads remain usable but the answer must explicitly separate them.
    return !day || day === today
  })
}

/** Hours allowed by a freshness hint; `day` widens to 48 for timezone spread. */
export function hoursForFreshness(freshness?: Freshness): number | undefined {
  if (!freshness) return undefined
  if (freshness === 'day') return 48
  if (freshness === 'week') return 24 * 8
  if (freshness === 'month') return 24 * 31
  return 24 * 366
}

// ---------------------------------------------------------------------------
// Source quality: syndication clusters, scores, ranking
// ---------------------------------------------------------------------------

const MULTI_LABEL_SUFFIX =
  /\.(?:co|com|net|org|gov|edu|ac|or|ne|go|nic)\.[a-z]{2}$/i

/**
 * Registrable domain: `news.ycombinator.com` -> `ycombinator.com`.
 *
 * Two copies of one story on the same publisher are one source, so the cluster
 * key has to be the publisher, not the subdomain.
 */
export function registrableDomain(url: string): string {
  const host = hostOf(url)
  if (!host || /^\d+(?:\.\d+){3}$/.test(host)) return host
  if (MULTI_LABEL_SUFFIX.test(host)) {
    const parts = host.split('.')
    return parts.slice(-3).join('.')
  }
  const parts = host.split('.')
  return parts.slice(-2).join('.')
}

/** Punctuation-free title key: the same headline republished keeps this key. */
function titleFingerprint(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120)
}

function titleTokens(title: string): Set<string> {
  const source = String(title ?? '').toLowerCase()
  const tokens = new Set(source.match(/[a-z0-9]{2,}/g) ?? [])
  for (const run of source.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Sites that republish or link out rather than report. Used only as a penalty. */
const AGGREGATOR_HOSTS = new Set([
  'news.google.com',
  'news.yahoo.com',
  'news.msn.com',
  'www.msn.com',
  'flipboard.com',
  'smartnews.com',
  'inshorts.com',
  'techmeme.com',
  'newsnow.co.uk',
  'www.toutiao.com',
  'news.baidu.com'
])

const REPRINT_MARKERS =
  /转载|转自|本文来源|来源[:：]\s*(?:新浪|搜狐|网易|腾讯|凤凰|澎湃)|syndicated|reprinted|originally published/i

const CLICKBAIT =
  /震惊|揭秘|你不知道|必看|十大|排行榜|最强推荐|clickbait|you won'?t believe/i

/** Aggregator, portal reprint, or a redirect wrapper: a lead, not evidence. */
export function isAggregator(result: SearchResult): boolean {
  const host = hostOf(result.url)
  if (!host) return true
  if (AGGREGATOR_HOSTS.has(host)) return true
  // `news.` / `m.` mirrors of a portal still aggregate; the path is the tell.
  if (/^news\./.test(host) && !/\/\d{4}\//.test(result.url)) return true
  if (REPRINT_MARKERS.test(result.snippet) || REPRINT_MARKERS.test(result.title)) return true
  if (/[?&](?:utm_|redirect|url=|r=)/i.test(result.url)) return true
  return false
}

/** Known brand spellings -> the host that publishes them first-hand. */
const BRAND_ALIASES: Array<[RegExp, string]> = [
  [/\bdeepseek\b/i, 'deepseek'],
  [/\bopenai\b|\bchatgpt\b/i, 'openai'],
  [/\bnvidia\b|\brtx\b|\bgeforce\b|\bcuda\b/i, 'nvidia'],
  [/\bgithub\b/i, 'github'],
  [/\bapple\b|\bmacbook\b|\biphone\b/i, 'apple'],
  [/\bmicrosoft\b|\bwindows\b|\bazure\b/i, 'microsoft'],
  [/\bgoogle\b|\bgemini\b|\bandroid\b/i, 'google'],
  [/\bmeta\b|\bllama\b/i, 'meta'],
  [/\bamd\b|\bryzen\b|\bradeon\b/i, 'amd'],
  [/\bintel\b|\bcore ultra\b/i, 'intel'],
  [/\btsmc\b/i, 'tsmc'],
  [/\bhugging ?face\b/i, 'huggingface']
]

/** Entity strings the question names, used to spot a first-party host. */
export function entityTokens(question: string): string[] {
  const source = String(question ?? '')
  const found: string[] = []
  for (const [pattern, host] of BRAND_ALIASES) {
    if (pattern.test(source)) found.push(host)
  }
  for (const token of source.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (!found.includes(token)) found.push(token)
  }
  return found
}

/** Documentation, code and paper hosts rank above journalism for their topic. */
const PRIMARY_HOST =
  /(?:^|\.)(?:docs|api-docs|developer|developers|dev|api|platform|support|opensource|research|engineering)\.[a-z0-9-]+\.[a-z.]+$/i
const RESEARCH_HOST =
  /pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|arxiv\.org|nature\.com|science\.org|thelancet\.com|nejm\.org|bmj\.com|jamanetwork\.com|cochranelibrary\.com|who\.int$/i
const VENDOR_SELF_REPORT = /\b(?:we|our)\b.{0,40}\b(?:measured|benchmark|outperforms)\b/i

/**
 * One source's quality, as a number the ranker can sort on.
 *
 * Six signals from the brief, each scaled so no single one can dominate:
 * originality (first-party host, research primary), relevance (question term
 * overlap), recency (age vs today), credibility (docs/gov/edu/primary),
 * independence (aggregator/reprint penalty) and completeness (snippet length).
 *
 * This is a weighting, never a gate: an unknown domain still ranks on content,
 * which is why there is no global allow-list here.
 */
export function scoreSource(result: SearchResult, question = '', now: Date = new Date()): number {
  const host = hostOf(result.url)
  const title = result.title ?? ''
  const snippet = result.snippet ?? ''
  let score = 0

  if (isAggregator(result)) score -= 25
  if (CLICKBAIT.test(title) || CLICKBAIT.test(snippet)) score -= 8
  if (!snippet.trim()) score -= 5
  if (VENDOR_SELF_REPORT.test(snippet)) score -= 4

  const entities = entityTokens(question)
  if (host && entities.some((entity) => host.includes(entity))) score += 30
  if (RESEARCH_HOST.test(host)) score += 16
  if (/\.gov(?:\.|$)/i.test(host) || /\.edu(?:\.|$)/i.test(host)) score += 10
  if (PRIMARY_HOST.test(host)) score += 10
  if (/(?:^|\.)github\.com$/i.test(host)) {
    score += /\/(?:releases|blob|tree|issues|pull)\b/i.test(result.url) ? 14 : 8
  }
  if (/\/(\d{4})\/(\d{2})\/(\d{2})\//.test(result.url)) score += 4

  const info = assessRecency(result, now)
  if (info.ageHours !== undefined) {
    if (info.ageHours <= 48) score += 10
    else if (info.ageHours <= 24 * 8) score += 6
    else if (info.ageHours <= 24 * 31) score += 2
    else score -= 10
  }

  const asked = titleTokens(question)
  if (asked.size) {
    score += Math.round(overlapRatio(asked, titleTokens(title)) * 10)
    score += Math.round(overlapRatio(asked, titleTokens(snippet)) * 5)
  }
  if (snippet.length >= 120) score += 3
  if (snippet.length >= 240) score += 2
  return score
}

/**
 * Collapses one story republished on several sites into one evidence item.
 *
 * Two different sites running the same headline are not corroboration, so the
 * cluster keeps a single representative and prefers the copy that is not an
 * aggregator. Near-identical titles (>= 80% token overlap) cluster too, since
 * publishers reword the headline slightly.
 */
export function dedupeSyndicated(results: SearchResult[]): SearchResult[] {
  const kept: Array<{ result: SearchResult; fingerprint: string; tokens: Set<string>; domain: string }> = []
  for (const result of results) {
    const fingerprint = titleFingerprint(result.title)
    const tokens = titleTokens(result.title)
    const domain = registrableDomain(result.url)
    const twin = kept.find(
      (entry) =>
        (fingerprint && entry.fingerprint === fingerprint) ||
        (entry.domain === domain && fingerprint && entry.fingerprint === fingerprint) ||
        overlapRatio(tokens, entry.tokens) >= 0.8
    )
    if (!twin) {
      kept.push({ result, fingerprint, tokens, domain })
      continue
    }
    // Keep the original report, not the copy that links to it.
    if (isAggregator(twin.result) && !isAggregator(result)) {
      twin.result = result
      twin.fingerprint = fingerprint
      twin.tokens = tokens
      twin.domain = domain
    }
  }
  return kept.map((entry) => entry.result)
}

function urlKey(url: string): string {
  return sourceKey(String(url ?? ''))
}

export interface RankOptions {
  now?: Date
  /** Drop items provably older than this. Omit to keep everything. */
  maxAgeHours?: number
  /** Hard cap after ranking. */
  limit?: number
}

/**
 * The ranker the answer stage feeds on.
 *
 * Order of operations matters: exact-URL dedupe, then recency, then syndication
 * clusters, then scoring. Syndication runs after recency so an old reprint
 * cannot displace a fresh original.
 */
export function rankSources(
  results: SearchResult[],
  question = '',
  opts: RankOptions = {}
): SearchResult[] {
  const now = opts.now ?? new Date()
  const unique: SearchResult[] = []
  const seen = new Set<string>()
  for (const result of results) {
    const key = urlKey(result.url)
    if (!key || !/^https?:\/\//i.test(result.url) || seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }
  const fresh =
    opts.maxAgeHours === undefined
      ? unique
      : filterByRecency(unique, { now, maxAgeHours: opts.maxAgeHours })
  const clustered = dedupeSyndicated(fresh)
  const scored = clustered.map((result, index) => ({
    result,
    index,
    score: scoreSource(result, question, now)
  }))
  scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
  const ranked = scored.map((entry) => entry.result)
  return opts.limit && opts.limit > 0 ? ranked.slice(0, opts.limit) : ranked
}

/**
 * Which pages are worth a full read. Aggregators are skipped outright: reading
 * a portal copy teaches nothing the original would not.
 */
export function pickDeepReadTargets(
  results: SearchResult[],
  limit = MAX_DEEP_READS
): SearchResult[] {
  const picked: SearchResult[] = []
  const domains = new Set<string>()
  for (const result of results) {
    if (picked.length >= limit) break
    if (!/^https?:\/\//i.test(result.url) || isAggregator(result)) continue
    const domain = registrableDomain(result.url)
    // One page per publisher: more from the same site adds no independence.
    if (domains.has(domain)) continue
    domains.add(domain)
    picked.push(result)
  }
  return picked
}

export interface PageQuality {
  chars: number
  hasDate: boolean
  firstParty: boolean
  /** 0..1 confidence that the body is a usable primary document. */
  score: number
}

/** Completeness signal for a page a `read_webpage` call already fetched. */
export function pageCompleteness(
  page: { url?: string; text?: string },
  question = ''
): PageQuality {
  const text = String(page.text ?? '')
  const host = hostOf(page.url ?? '')
  const entities = entityTokens(question)
  const firstParty = Boolean(host) && entities.some((entity) => host.includes(entity))
  const hasDate = Boolean(extractDate(text))
  const length = text.length
  let score = 0
  if (length >= 600) score += 0.4
  else if (length >= 200) score += 0.25
  else if (length >= 60) score += 0.1
  if (hasDate) score += 0.25
  if (firstParty) score += 0.25
  if (RESEARCH_HOST.test(host) || PRIMARY_HOST.test(host)) score += 0.1
  return { chars: length, hasDate, firstParty, score: Math.min(1, Number(score.toFixed(2))) }
}
