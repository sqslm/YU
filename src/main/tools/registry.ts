/**
 * The tool registry: the only place an agent-chosen action can turn into a side
 * effect.
 *
 * Design rules that keep the agent small and safe:
 *
 * - The model never names a shell command. It names one of these tools and the
 *   program validates the arguments itself — anything else is an unknown tool.
 * - Every tool returns `{ok, data, summary}` and never throws; a failure is data
 *   the model is told to acknowledge, not an exception that loses the take.
 * - Tools are plain functions over the existing providers. No framework, no
 *   dependency, no global state beyond one lazily loaded Windows DLL handle.
 */

import type { CardAction, SearchResult, Settings } from '@shared/types'
import { formatToday } from '@shared/prompts'
import {
  formatSearchResults,
  filterTodayNews,
  hoursForFreshness,
  planSearch,
  rankSources,
  runPool,
  searchInputOf,
  searchWeb,
  type Freshness,
  type SearchQuery,
  type SearchRound
} from '../providers/search'
import { fetchWeather, formatWeather, weatherSource } from '../providers/weather'
import { evaluateExpression } from './calculate'
import { getDateTime } from './datetime'
import { readWebpage, runWithDeadline } from './read-webpage'
import { getSelection, type SelectionDeps } from './selection'
import { mt } from '@shared/mainI18n'

/** Everything a tool may look at. Injected by `agent.ts`, faked in tests. */
export interface ToolContext {
  allowedTools?: readonly string[]
  settings: Settings
  /** The spoken question, for tools that can fall back to it for arguments. */
  question: string
  signal?: AbortSignal
  log: (line: string) => void
  /** Narration hook for the answer card ("正在查询天气…"). */
  onStatus?: (status: string) => void
  /** Spoken sentence → search keywords. Single source of truth lives in agent.ts. */
  rewriteQuery?: (raw: string) => string
  /** Harder cleanup used for the one retry after an empty result page. */
  sanitizeQuery?: (raw: string) => string
  /** True when the question rots within a day; gates that single retry. */
  timeSensitive?: boolean
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to `shell.openExternal`. */
  openExternal?: (url: string) => Promise<void>
  /** Injected in tests for `get_selection`. */
  selectionDeps?: Partial<SelectionDeps>
  /**
   * Per-take memo. Two tool calls with identical arguments in one take are the
   * same read of the same page; the second one waits on the first instead of
   * issuing a duplicate request. Optional: without it every call runs.
   */
  cache?: Map<string, Promise<ToolOutcome>>
  /** Per-tool ceilings in ms, overriding `TOOL_TIMEOUTS`. `0` disables. */
  timeouts?: Partial<Record<string, number>>
}

export interface ToolOutcome {
  ok: boolean
  /** JSON-ready payload handed back to the model. */
  data: Record<string, unknown>
  /** One line for the log and the card. */
  summary: string
  sources?: SearchResult[]
  /** A confirmation the UI must offer; never applied by the tool itself. */
  action?: CardAction
  error?: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for OpenAI function calling. */
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>
}

/** What actually ran, as the agent remembers it. */
export interface ToolRun {
  name: string
  ok: boolean
  data: Record<string, unknown>
  sources: SearchResult[]
  summary: string
  action?: CardAction
  error?: string
}

const MAX_SEARCH_RESULTS = 10

/**
 * Every tool that leaves the machine (or costs a provider call) gets a ceiling.
 * A tool that exceeds it degrades to `{ok:false, error:'… 超时'}` instead of
 * holding the whole take hostage — the model is told the source was skipped and
 * answers from what did land.
 */
export const TOOL_TIMEOUTS: Record<string, number> = {
  web_search: 8000,
  read_webpage: 6000,
  get_weather: 8000
}

/** Tools whose result is a pure function of their arguments within one take. */
const CACHEABLE = new Set(['web_search', 'read_webpage', 'get_weather', 'get_datetime', 'calculate'])

/** Planned queries in flight at once. The plan is two; more is throttling bait. */
const SEARCH_PLAN_CONCURRENCY = 2

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fail(error: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { ok: false, data: { ...extra, ok: false, error }, summary: error, error }
}

// ---------------------------------------------------------------------------
// get_weather
// ---------------------------------------------------------------------------

async function runWeather(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const location = textArg(args, 'location')
  const when = args.when === 'tomorrow' ? 'tomorrow' : 'today'
  const query = location || ctx.question
  if (!query) return fail(mt('缺少地点：请说明要查询哪个城市'))

  ctx.onStatus?.('正在查询天气…')
  let report: Awaited<ReturnType<typeof fetchWeather>>
  try {
    report = await fetchWeather(query, ctx.signal)
  } catch (err) {
    ctx.log(`[tool] get_weather failed: ${messageOf(err)}`)
    return fail(mt('天气查询失败：{{message}}', { message: messageOf(err) }))
  }
  if (!report) {
    return fail(mt('没有拿到「{{place}}」的实时天气数据', { place: location || query }))
  }

  ctx.log(
    `[weather] ${report.place} ${report.current.description} ${report.current.temperature}°C`
  )
  const source = weatherSource(report)
  const daily = report.daily ?? []
  const today = daily[0]
  const tomorrow = daily[1]
  const pick = (entry: typeof today): Record<string, unknown> | null =>
    entry
      ? {
          date: entry.date,
          description: entry.description,
          high: entry.high,
          low: entry.low,
          rainChance: entry.rainChance
        }
      : null

  const data: Record<string, unknown> = {
    ok: true,
    place: report.place,
    region: report.region ?? '',
    when,
    current: {
      temperature: report.current.temperature,
      apparent: report.current.apparent,
      humidity: report.current.humidity,
      precipitation: report.current.precipitation,
      wind: report.current.wind,
      description: report.current.description
    },
    today: pick(today),
    tomorrow: pick(tomorrow),
    sourceUrl: report.sourceUrl,
    /** Rendered by the provider so the prompt never re-invents the numbers. */
    text: formatWeather(report),
    /** When this program fetched it — the forecast itself carries no timestamp. */
    fetchedAt: new Date().toISOString()
  }

  return {
    ok: true,
    data,
    summary: `${report.place} ${report.current.description} ${report.current.temperature}℃`,
    sources: [source]
  }
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const FRESHNESS_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }

async function runWebSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const raw = textArg(args, 'query')
  const explicitFreshness =
    typeof args.freshness === 'string' && args.freshness in FRESHNESS_DAYS
      ? (args.freshness as Freshness)
      : undefined
  const cleanedInput = ctx.rewriteQuery ? ctx.rewriteQuery(raw) || raw : raw
  let query = cleanedInput || ctx.question
  if (!query) return fail(mt('缺少检索词'))

  ctx.onStatus?.('正在检索…')

  // The planner decides *how many* queries this question deserves. A stock
  // quote gets one; a Chinese news question additionally gets an English one,
  // because the primary coverage of anything global is not in Chinese.
  const plan = planSearch(ctx.question || query, query)
  const limit = Math.min(Math.max(1, ctx.settings.search.maxResults || 5), MAX_SEARCH_RESULTS)
  // Roundups request a full page per topic, then keep the whole deduped union.
  // Ordinary lookup settings remain unchanged, including the saved provider entry.
  const searchSettings = plan.digest ? { ...ctx.settings.search, maxResults: MAX_SEARCH_RESULTS } : ctx.settings.search
  const rankOptions = { maxAgeHours: hoursForFreshness(explicitFreshness ?? plan.freshness), ...(plan.digest || ctx.settings.search.strategy === 'aggregate' ? {} : { limit }) }
  if (explicitFreshness) {
    plan.freshness = explicitFreshness
    for (const planned of plan.queries) planned.freshness = explicitFreshness
  }
  // Legacy field: callers and tests read a freshness label, "any" when unset.
  const freshness = plan.freshness ?? 'any'

  // Both planned queries go out together, at most two in flight, identical text
  // dropped first. The English corroboration query does not depend on the
  // Chinese one; running it after the first used to add a whole provider round
  // trip to every news question for no extra coverage.
  const unique: SearchQuery[] = []
  const seenQueries = new Set<string>()
  for (const planned of plan.queries) {
    const key = planned.text.trim().toLowerCase()
    if (!key || seenQueries.has(key)) continue
    seenQueries.add(key)
    unique.push(planned)
  }
  const searchTimeout = ctx.timeouts?.web_search ?? (plan.digest ? 4000 : undefined)
  const rounds: SearchRound[] = new Array(unique.length)
  await runPool(unique, SEARCH_PLAN_CONCURRENCY, async (planned, index) => {
    try {
      const input = searchInputOf(planned)
      // Keep the three-argument call when no ceiling was overridden: callers and
      // tests treat a provider call as `(cfg, input, signal)`.
      const results = searchTimeout
        ? await searchWeb(searchSettings, input, ctx.signal, { timeoutMs: searchTimeout, ...(plan.digest ? { maxResults: MAX_SEARCH_RESULTS } : {}) })
        : await searchWeb(searchSettings, input, ctx.signal)
      rounds[index] = { query: planned, results }
    } catch (err) {
      rounds[index] = { query: planned, results: [], error: messageOf(err) }
    }
  })
  const executed = rounds.map((round) => round.query.text)
  const errors = rounds.map((round) => round.error).filter((err): err is string => Boolean(err))
  if (rounds.length > 0 && rounds.every((round) => round.error)) {
    ctx.log(`[search] provider failed: ${errors[0]}`)
    return fail(mt('检索失败：{{message}}', { message: errors[0] }), { query, queries: executed })
  }

  let results = rankSources(
    rounds.flatMap((round) => round.results),
    ctx.question || query,
    rankOptions
  )
  ctx.log(`[search] ${results.length} result(s) for "${query}" via ${executed.join(' | ')}`)

  // One — and only one — relaxed retry. An empty page for a time-sensitive
  // question is usually a query-shape problem, not a knowledge problem.
  let retried = false
  if (results.length === 0 && ctx.timeSensitive) {
    const cleaned = ctx.sanitizeQuery ? ctx.sanitizeQuery(ctx.question) : ''
    const retry = cleaned
      ? cleaned === query
        ? `${cleaned} ${formatToday()}`
        : cleaned
      : ''
    if (retry && retry !== query) {
      retried = true
      query = retry
      try {
        const retryInput = plan.freshness ? { text: retry, freshness: plan.freshness, ...(plan.kind === 'news' ? { kind: 'news' as const } : {}) } : retry
        results = rankSources(await searchWeb(searchSettings, retryInput, ctx.signal), ctx.question, rankOptions)
        executed.push(retry)
        ctx.log(`[search] retry "${query}" → ${results.length} result(s)`)
      } catch (err) {
        ctx.log(`[search] retry failed: ${messageOf(err)}`)
        results = []
      }
    }
  }

  if (plan.digest && plan.urgent) results = filterTodayNews(results)

  if (results.length === 0) {
    return {
      ok: false,
      data: { ok: false, query, queries: executed, freshness, count: 0, retried, error: '没有检索到结果' },
      summary: mt('没有检索到结果'),
      error: mt('没有检索到结果')
    }
  }

  return {
    ok: true,
    data: {
      ok: true,
      query,
      queries: executed,
      kind: plan.kind,
      digest: plan.digest === true,
      failedQueries: errors.length,
      freshness,
      recencyDays: FRESHNESS_DAYS[freshness as keyof typeof FRESHNESS_DAYS] ?? 0,
      retried,
      count: results.length,
      results: results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        publishedAt: item.publishedAt ?? ''
      })),
      text: formatSearchResults(results)
    },
    summary: mt('检索到 {{n}} 条结果（{{query}}）', { n: results.length, query }),
    sources: results
  }
}

// ---------------------------------------------------------------------------
// read_webpage
// ---------------------------------------------------------------------------

async function runReadWebpage(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const url = textArg(args, 'url')
  if (!url) return fail(mt('缺少 url'))
  ctx.onStatus?.('正在读取网页…')
  const page = await readWebpage(url, { signal: ctx.signal, fetchImpl: ctx.fetchImpl })
  if (!page.ok) return fail(page.error ?? '无法读取网页', { url })
  return {
    ok: true,
    data: {
      ok: true,
      url: page.url ?? url,
      title: page.title ?? '',
      text: page.text ?? '',
      truncated: page.truncated === true
    },
    summary: mt('读取 {{target}}', { target: page.title || page.url || url }),
    sources: [{ title: page.title || page.url || url, url: page.url ?? url, snippet: (page.text ?? '').slice(0, 160) }]
  }
}

// ---------------------------------------------------------------------------
// get_datetime
// ---------------------------------------------------------------------------

async function runDateTime(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const timezone = textArg(args, 'timezone')
  const offsetRaw = args.offsetDays
  const offsetDays = typeof offsetRaw === 'number' ? offsetRaw : Number.parseInt(String(offsetRaw ?? '0'), 10)
  const info = getDateTime({
    timezone: timezone || undefined,
    offsetDays: Number.isFinite(offsetDays) ? offsetDays : 0
  })
  if (!info.ok) return fail(info.error ?? '无法读取时间', { timezone: info.timezone })
  ctx.log(`[datetime] ${info.now} ${info.timezone} ${info.weekday}`)
  return {
    ok: true,
    data: {
      ok: true,
      now: info.now,
      iso: info.iso,
      timezone: info.timezone,
      weekday: info.weekday,
      date: info.date,
      today: info.today,
      tomorrow: info.tomorrow,
      dayAfterTomorrow: info.dayAfterTomorrow,
      offsetDays: info.offsetDays
    },
    summary: `${info.now}（${info.weekday}）`
  }
}

// ---------------------------------------------------------------------------
// calculate
// ---------------------------------------------------------------------------

async function runCalculate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const expression = typeof args.expression === 'string' ? args.expression : ''
  const result = evaluateExpression(expression)
  if (!result.ok) return fail(result.error ?? '无法计算', { expression: result.expression })
  ctx.log(`[calculate] ${result.expression} = ${result.value}`)
  return {
    ok: true,
    data: { ok: true, expression: result.expression, value: result.value },
    summary: `${result.expression} = ${result.value}`
  }
}

// ---------------------------------------------------------------------------
// get_selection / replace_selection
// ---------------------------------------------------------------------------

async function runGetSelection(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  ctx.onStatus?.('正在读取选中文字…')
  const selection = await getSelection({ deps: ctx.selectionDeps })
  if (!selection.ok) return fail(selection.error ?? '无法读取选中文字')
  const text = selection.text ?? ''
  return {
    ok: true,
    data: { ok: true, text, length: text.length },
    summary: mt('选中 {{n}} 个字符', { n: text.length })
  }
}

async function runReplaceSelection(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) return fail(mt('没有可替换的文本'))
  ctx.log(`[replace] prepared ${text.length} chars; waiting for confirmation`)
  return {
    ok: true,
    data: { ok: true, prepared: true, length: text.length, note: '已生成替换文本，等待用户点击「替换选中」' },
    summary: mt('已准备替换文本'),
    action: { id: 'replace', label: mt('替换选中'), payload: text }
  }
}

// ---------------------------------------------------------------------------
// open_search
// ---------------------------------------------------------------------------

const ENGINES: Record<string, (query: string) => string> = {
  github: (query) => `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`,
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  youtube: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`
}

/** Exported for tests: the only URLs the agent may open. */
export function searchEngineUrl(engine: string, query: string): string | null {
  const build = ENGINES[engine]
  if (!build) return null
  const trimmed = query.trim()
  if (!trimmed) return null
  return build(trimmed)
}

async function runOpenSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const engine = textArg(args, 'engine').toLowerCase() || 'google'
  const query = textArg(args, 'query')
  const url = searchEngineUrl(engine, query)
  if (!url) return fail(mt('只支持 github / google / youtube / bing，且需要检索词'))
  try {
    if (ctx.openExternal) {
      await ctx.openExternal(url)
    } else {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    }
  } catch (err) {
    return fail(mt('无法打开浏览器：{{message}}', { message: messageOf(err) }), { engine, url })
  }
  ctx.log(`[open] ${engine} ${url}`)
  return {
    ok: true,
    data: { ok: true, engine, query, url, opened: true },
    summary: mt('已在 {{engine}} 打开检索页', { engine })
  }
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description:
      mt('查询某个地点当前与今明两天的实时天气（气温、体感、湿度、降水概率、风力）。用户问天气、气温、下雨、空气质量时必须用它，不要凭记忆回答。'),
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: mt('城市或地区名，如「郑州」「河南 安阳」。不确定时省略，程序会从原问题里取。')
        },
        when: { type: 'string', enum: ['today', 'tomorrow'], description: mt('关注哪一天，默认 today。') }
      },
      required: []
    },
    run: runWeather
  },
  {
    name: 'web_search',
    description:
      mt('联网检索网页摘要。用于新闻、行情、赛事、航班、产品发布、人物近况等会随时间变化的实时信息，或你不确定的具体事实。纯语言任务与常识问题不要用。'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: mt('2–8 个关键词，不要写成问句。') },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'any'],
          description: mt('结果的新鲜度偏好，默认 any。')
        }
      },
      required: ['query']
    },
    run: runWebSearch
  },
  {
    name: 'read_webpage',
    description: mt('读取一个已知 URL 的正文，用于核实检索结果里的具体页面。只支持公网 http/https 链接。'),
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: mt('要读取的网页地址。') } },
      required: ['url']
    },
    run: runReadWebpage
  },
  {
    name: 'get_datetime',
    description:
      mt('读取系统当前时间、时区、星期几，以及今天/明天/后天的具体日期。涉及「今天/明天/这周」等相对时间时先调用它。'),
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: mt('IANA 时区，如 Asia/Shanghai。省略则用本机时区。') },
        offsetDays: { type: 'number', description: mt('相对今天偏移几天，默认 0。') }
      },
      required: []
    },
    run: runDateTime
  },
  {
    name: 'calculate',
    description:
      mt('计算一个算术表达式，支持 + - * / % ^ 与括号、小数、百分数（50% 表示 0.5）。需要精确数字时用它，不要心算。'),
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: mt('如 125*36、(2+3)*4、50%*200') }
      },
      required: ['expression']
    },
    run: runCalculate
  },
  {
    name: 'get_selection',
    description: mt('读取用户在前台应用里当前选中的文字。用户说「这段」「选中的」时才用。'),
    parameters: { type: 'object', properties: {}, required: [] },
    run: runGetSelection
  },
  {
    name: 'replace_selection',
    description:
      mt('把用户当前选中的文字替换成新文本。只准备内容并等待用户点击确认，不会立即修改用户的内容。'),
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: mt('替换后的完整文本。') } },
      required: ['text']
    },
    run: runReplaceSelection
  },
  {
    name: 'open_search',
    description: mt('在系统浏览器里打开一个检索页。仅当用户明确要求「帮我打开/搜一下」时使用。'),
    parameters: {
      type: 'object',
      properties: {
        engine: { type: 'string', enum: ['github', 'google', 'youtube', 'bing'] },
        query: { type: 'string', description: mt('检索词') }
      },
      required: ['engine', 'query']
    },
    run: runOpenSearch
  }
]

export const TOOL_NAMES: string[] = TOOL_DEFINITIONS.map((tool) => tool.name)

/** OpenAI `tools` array. */
export function toolSchemas(allowed?: readonly string[]): Array<Record<string, unknown>> {
  return TOOL_DEFINITIONS.filter(tool => !allowed || allowed.includes(tool.name)).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

export function getTool(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

function cacheKey(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  // `String(value)` flattened objects to "[object Object]" and let a value that
  // contains "&" forge another call's key, so two different calls could share one
  // cached result. JSON keeps the values distinct.
  return `${name}?${keys.map((key) => `${key}=${JSON.stringify(args[key]) ?? 'null'}`).join('&')}`
}

/** Runs the tool body under its ceiling. Never throws: a timeout is data. */
async function attemptTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const timeoutMs = ctx.timeouts?.[tool.name] ??
    (tool.name === 'web_search' && planSearch(ctx.question, textArg(args, 'query')).digest ? 15_000 : TOOL_TIMEOUTS[tool.name]) ?? 0
  const outcome = await runWithDeadline(
    (signal) => tool.run(args, { ...ctx, signal }),
    ctx.signal,
    timeoutMs
  )
  if (outcome.ok) return outcome.value
  if (outcome.reason === 'timeout') {
    ctx.log(`[tool] ${tool.name} timed out after ${timeoutMs}ms`)
    return fail(
      mt('{{tool}} 超时（{{seconds}}s），已跳过这一步', {
        tool: tool.name,
        seconds: Math.round(timeoutMs / 1000)
      })
    )
  }
  if (outcome.reason === 'aborted') return fail(mt('{{tool}} 已取消', { tool: tool.name }))
  ctx.log(`[tool] ${tool.name} threw: ${messageOf(outcome.error)}`)
  return fail(mt('{{tool}} 执行失败：{{message}}', { tool: tool.name, message: messageOf(outcome.error) }))
}

/**
 * Runs one tool by name. Unknown names, timeouts and thrown errors become
 * `{ok:false}`. Identical cacheable calls inside one take share a single
 * attempt, so a model that asks for the same page twice pays for it once.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const tool = getTool(name)
  if (ctx.allowedTools && !ctx.allowedTools.includes(name)) return fail(mt('本次任务未授权此工具：{{name}}', { name }))
  if (!tool) return fail(mt('未知工具：{{name}}', { name }))
  const input = args ?? {}
  const key = CACHEABLE.has(name) && ctx.cache ? cacheKey(name, input) : ''
  if (key) {
    const cached = ctx.cache?.get(key)
    if (cached) {
      ctx.log(`[tool] ${name} 复用本轮的同一请求`)
      return cached
    }
  }
  const started = Date.now()
  const attempt = attemptTool(tool, input, ctx)
  if (key) ctx.cache?.set(key, attempt)
  const outcome = await attempt
  ctx.log(`[perf] tool:${name} ${Date.now() - started}ms ok=${outcome.ok}`)
  return outcome
}
