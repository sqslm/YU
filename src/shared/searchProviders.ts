import type { SearchConnection, SearchProvider, SearchProviderEntry, SearchSettings } from './types'
import { mt } from './mainI18n'

/**
 * One row per backend: everything the settings screen needs to describe it.
 *
 * The four `Record<SearchProvider, …>` maps below are *derived* from this table
 * instead of being written out four times. Adding a provider used to mean
 * editing six places (union, menu order, label, hint, needs-key, needs-endpoint)
 * and any missed one was a compile error in the renderer; now the union is the
 * only other place, and `Record<SearchProvider, …>` on `META` makes a forgotten
 * row a type error here.
 */
interface SearchProviderMeta {
  label: string
  /** One line under the provider picker: what this backend is. */
  hint: string
  /** Sub-label of the API-key field. */
  keyHint: string
  /** Placeholder for the API-key field: whether a key is useful, not if it is typeable. */
  keyPlaceholder: string
  /** Sub-label of the custom-endpoint field. */
  endpointHint: string
  needsKey: boolean
  needsEndpoint: boolean
  /**
   * Something the user still has to bring besides a key and an address, phrased
   * as an instruction. Every backend listed here has a working adapter, so a
   * caveat is a setup note and never an "unsupported" marker.
   */
  caveat?: string
}

/**
 * Every translated field below is a getter, never a `mt()` call evaluated here.
 *
 * The table is built at import time, which is before the renderer has loaded
 * `settings.uiLanguage` and called `setMainLanguage()`; a copied string kept the
 * language the process started in, so the English UI described every backend in
 * Chinese. A getter re-translates on each read and still types as `string`.
 */
const META: Record<SearchProvider, SearchProviderMeta> = {
  duckduckgo: {
    label: 'DuckDuckGo',
    get hint() { return mt('免 Key，直接抓 HTML 结果页；量大时会被限流。') },
    get keyHint() { return mt('该服务直接抓取结果页，不需要 API Key') },
    get keyPlaceholder() { return mt('该服务不使用') },
    get endpointHint() { return mt('该服务固定走官方结果页，不需要自定义地址') },
    needsKey: false,
    needsEndpoint: false
  },
  tavily: {
    label: 'Tavily',
    get hint() { return mt('为 LLM 设计的搜索 API，需要 API Key。') },
    get keyHint() { return mt('必填；只保存在本机，切回 Tavily 时自动恢复') },
    keyPlaceholder: 'tvly-…',
    get endpointHint() { return mt('可留空；留空则使用 Tavily 官方地址') },
    needsKey: true,
    needsEndpoint: false
  },
  brave: {
    label: 'Brave',
    get hint() { return mt('Brave Search API，需要订阅令牌；新闻类会走 news 端点。') },
    get keyHint() { return mt('必填；填 Brave Search 的订阅令牌') },
    get keyPlaceholder() { return mt('订阅令牌') },
    get endpointHint() { return mt('可留空；留空则使用 Brave 官方地址') },
    needsKey: true,
    needsEndpoint: false
  },
  searxng: {
    label: 'SearXNG',
    get hint() { return mt('自建实例，填实例地址即可（形如 http://127.0.0.1:8080）。') },
    get keyHint() { return mt('可选；实例开启鉴权时才需要') },
    get keyPlaceholder() { return mt('可选；实例开启鉴权时填写') },
    get endpointHint() { return mt('必填，形如 http://127.0.0.1:8080（实例需开启 format=json）') },
    needsKey: false,
    needsEndpoint: true
  },

  // ---- Every backend below has an adapter in `src/main/providers/search.ts`.
  // Listing them is what lets a user bring a key he already pays for; the row
  // itself never decides whether a query can run, only which endpoint it runs
  // against.

  /**
   * The app's own vendor API. It rides next to Tavily because it is the same
   * shape of product: one call, snippets plus optional page text.
   */
  deepseek: {
    get label() { return mt('DeepSeek 搜索') },
    get hint() { return mt('DeepSeek 官方检索接口，返回摘要，可额外索取正文；与模型共用一个 Key。') },
    get keyHint() { return mt('必填；DeepSeek 开放平台的 API Key') },
    keyPlaceholder: 'sk-…',
    get endpointHint() { return mt('可留空；留空则用 https://api.deepseek.com（自动补 /v1/tools/search）') },
    needsKey: true,
    needsEndpoint: false
  },
  exa: {
    label: 'Exa',
    get hint() { return mt('语义检索，/search 直接返回整页正文，适合当资料喂给模型。') },
    get keyHint() { return mt('必填；Exa 控制台的 API Key') },
    keyPlaceholder: 'Exa API Key',
    get endpointHint() { return mt('可留空；留空则用 https://api.exa.ai/search') },
    needsKey: true,
    needsEndpoint: false
  },
  serper: {
    get label() { return mt('Serper（Google 结果）') },
    get hint() { return mt('按次计费的 Google 结果代理，返回结构接近官方。') },
    get keyHint() { return mt('必填；请求头是 X-API-KEY，不是 Bearer') },
    keyPlaceholder: 'Serper API Key',
    get endpointHint() { return mt('可留空；留空则用 https://google.serper.dev/search') },
    needsKey: true,
    needsEndpoint: false
  },
  bing: {
    label: 'Bing Web Search',
    get hint() { return mt('Azure 的 Web Search v7，需要订阅密钥。') },
    get keyHint() { return mt('必填；Azure 资源里的 Ocp-Apim-Subscription-Key') },
    get keyPlaceholder() { return mt('Azure 订阅密钥') },
    get endpointHint() { return mt('可留空；留空则用 https://api.bing.microsoft.com/v7.0/search') },
    needsKey: true,
    needsEndpoint: false
  },
  'google-cse': {
    get label() { return mt('Google 可编程搜索') },
    get hint() { return mt('官方 Custom Search JSON API，每日免费额度很小。') },
    get keyHint() { return mt('必填；Google Cloud 里的 API Key') },
    keyPlaceholder: 'Google API Key',
    get endpointHint() { return mt('填搜索引擎 ID：可只写 cx，也可写 https://www.googleapis.com/customsearch/v1?cx=…') },
    needsKey: true,
    needsEndpoint: true,
    get caveat() { return mt('这家除了 API Key 还要 cx（搜索引擎 ID），写在自定义地址里即可。') }
  },
  jina: {
    get label() { return mt('Jina Reader 搜索') },
    get hint() { return mt('s.jina.ai 先检索再把正文抽干净，Key 可以不填。') },
    get keyHint() { return mt('可选；不带 Key 也能用，只是限流更早') },
    get keyPlaceholder() { return mt('可选；jina_…') },
    get endpointHint() { return mt('可留空；留空则用 https://s.jina.ai') },
    needsKey: false,
    needsEndpoint: false
  },
  perplexity: {
    label: 'Perplexity Search',
    get hint() { return mt('Perplexity 的 sonar 模型，直接给出带引用的答案。') },
    get keyHint() { return mt('必填；Perplexity 控制台的 API Key') },
    keyPlaceholder: 'pplx-…',
    get endpointHint() { return mt('可留空；留空则用 https://api.perplexity.ai/chat/completions') },
    needsKey: true,
    needsEndpoint: false
  },
  'zhipu-web': {
    get label() { return mt('智谱 Web 搜索') },
    get hint() { return mt('智谱开放平台的 web_search 接口，和 GLM 共用一个 Key。') },
    get keyHint() { return mt('必填；智谱开放平台的 API Key（与 GLM 通用）') },
    get keyPlaceholder() { return mt('智谱 API Key') },
    get endpointHint() { return mt('可留空；留空则用 https://open.bigmodel.cn/api/paas/v4/web_search') },
    needsKey: true,
    needsEndpoint: false
  },
  baidu: {
    get label() { return mt('百度网页') },
    get hint() { return mt('免 Key，抓百度结果页；连续请求会跳验证码。') },
    get keyHint() { return mt('该服务抓取公开结果页，不需要 API Key') },
    get keyPlaceholder() { return mt('该服务不使用') },
    get endpointHint() { return mt('可留空；留空则用 https://www.baidu.com/s') },
    needsKey: false,
    needsEndpoint: false
  }
}

/** Every backend the UI can switch between, in menu order. */
export const SEARCH_PROVIDERS = Object.keys(META) as SearchProvider[]

/**
 * Reads one field out of every row, keeping `Record<SearchProvider, …>` shape.
 *
 * The column is installed as an accessor rather than copied, so the `mt()` behind
 * `META` runs when the UI reads the row, not when this module was first imported.
 */
function derived<T>(read: (meta: SearchProviderMeta) => T): Record<SearchProvider, T> {
  const table = {} as Record<SearchProvider, T>
  for (const provider of SEARCH_PROVIDERS) {
    Object.defineProperty(table, provider, { enumerable: true, get: () => read(META[provider]) })
  }
  return table
}

export const SEARCH_PROVIDER_LABEL: Record<SearchProvider, string> = derived((meta) => meta.label)

export const SEARCH_PROVIDER_HINT: Record<SearchProvider, string> = derived((meta) => meta.hint)

export const SEARCH_PROVIDER_KEY_HINT: Record<SearchProvider, string> = derived(
  (meta) => meta.keyHint
)

export const SEARCH_PROVIDER_KEY_PLACEHOLDER: Record<SearchProvider, string> = derived(
  (meta) => meta.keyPlaceholder
)

export const SEARCH_PROVIDER_ENDPOINT_HINT: Record<SearchProvider, string> = derived(
  (meta) => meta.endpointHint
)

/** Which providers actually need a key, so the form can disable the field elsewhere. */
export const SEARCH_PROVIDER_NEEDS_KEY: Record<SearchProvider, boolean> = derived(
  (meta) => meta.needsKey
)

export const SEARCH_PROVIDER_NEEDS_ENDPOINT: Record<SearchProvider, boolean> = derived(
  (meta) => meta.needsEndpoint
)

/**
 * What the UI must still tell the user about a provider, or nothing when there
 * is nothing to say. Every entry here is a setup note ("also needs cx"), never a
 * statement that the backend cannot be queried: there is no such backend left.
 */
export const SEARCH_PROVIDER_CAVEAT: Partial<Record<SearchProvider, string>> = caveats()

/** Accessors for the rows that have a caveat; see `derived()` for the reason. */
function caveats(): Partial<Record<SearchProvider, string>> {
  const table: Partial<Record<SearchProvider, string>> = {}
  for (const provider of SEARCH_PROVIDERS) {
    if (!META[provider].caveat) continue
    Object.defineProperty(table, provider, { enumerable: true, get: () => META[provider].caveat })
  }
  return table
}

/**
 * Runtime guard, deliberately wider than the persisted union: an id that the
 * shared schema has not picked up yet must still survive a settings round-trip
 * instead of being rewritten to DuckDuckGo.
 */
export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === 'string' && (SEARCH_PROVIDERS as string[]).includes(value)
}

/**
 * A blank slot for one provider.
 *
 * `endpoint` stays empty on purpose: an empty endpoint means "the official host
 * for this backend", which is the only sane default for a dozen vendors with
 * different paths. Self-hosted backends (SearXNG) fill it in.
 */
export function defaultSearchEntry(provider: SearchProvider): SearchProviderEntry {
  return { apiKey: '', endpoint: '', maxResults: 5 }
}

export function defaultSearchProviders(): Record<SearchProvider, SearchProviderEntry> {
  const providers = {} as Record<SearchProvider, SearchProviderEntry>
  for (const provider of SEARCH_PROVIDERS) providers[provider] = defaultSearchEntry(provider)
  return providers
}

function clampResults(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(10, Math.max(1, Math.round(parsed)))
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Rebuilds the provider map from whatever was on disk. Each provider's key,
 * endpoint and result count stay in their own slot, and the active provider's
 * values are mirrored onto the flat `apiKey`/`endpoint`/`maxResults` fields so
 * the search adapters never read a stale key from another backend.
 *
 * Slots the saved settings never heard of (every backend added after 1.0) are
 * filled from `defaultSearchProviders()`, so an old file keeps working verbatim
 * instead of being dropped or rewritten.
 */
export function normalizeSearchProviders(input: unknown): Record<SearchProvider, SearchProviderEntry> {
  const source = (input ?? {}) as Partial<Record<SearchProvider, Partial<SearchProviderEntry>>>
  const providers = defaultSearchProviders()
  for (const provider of SEARCH_PROVIDERS) {
    const entry = source[provider] ?? {}
    providers[provider] = {
      apiKey: text(entry.apiKey),
      ...(typeof entry.apiKeyEnc === 'string' ? { apiKeyEnc: entry.apiKeyEnc } : {}),
      endpoint: text(entry.endpoint),
      maxResults: clampResults(entry.maxResults, 5)
    }
  }
  return providers
}

export function activeSearchEntry(search: SearchSettings): SearchProviderEntry {
  return search.providers[search.provider] ?? defaultSearchEntry(search.provider)
}

export function normalizeSearchConnections(input: unknown): SearchConnection[] {
  if (!Array.isArray(input)) return []
  const ids = new Set<string>()
  const connections: SearchConnection[] = []
  for (const value of input) {
    if (!value || typeof value !== 'object' || !isSearchProvider(value.provider)) continue
    const id = text(value.id)
    const provider = value.provider as SearchProvider
    if (!id || ids.has(id)) continue
    ids.add(id)
    connections.push({ id, name: text(value.name).trim() || SEARCH_PROVIDER_LABEL[provider], provider,
      enabled: value.enabled !== false, apiKey: text(value.apiKey), endpoint: text(value.endpoint), maxResults: clampResults(value.maxResults, 5),
      ...(typeof value.apiKeyEnc === 'string' ? { apiKeyEnc: value.apiKeyEnc } : {}) })
  }
  return connections
}
