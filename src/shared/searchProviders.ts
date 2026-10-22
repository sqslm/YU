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

const META: Record<SearchProvider, SearchProviderMeta> = {
  duckduckgo: {
    label: 'DuckDuckGo',
    hint: mt('免 Key，直接抓 HTML 结果页；量大时会被限流。'),
    keyHint: mt('该服务直接抓取结果页，不需要 API Key'),
    keyPlaceholder: mt('该服务不使用'),
    endpointHint: mt('该服务固定走官方结果页，不需要自定义地址'),
    needsKey: false,
    needsEndpoint: false
  },
  tavily: {
    label: 'Tavily',
    hint: mt('为 LLM 设计的搜索 API，需要 API Key。'),
    keyHint: mt('必填；只保存在本机，切回 Tavily 时自动恢复'),
    keyPlaceholder: 'tvly-…',
    endpointHint: mt('可留空；留空则使用 Tavily 官方地址'),
    needsKey: true,
    needsEndpoint: false
  },
  brave: {
    label: 'Brave',
    hint: mt('Brave Search API，需要订阅令牌；新闻类会走 news 端点。'),
    keyHint: mt('必填；填 Brave Search 的订阅令牌'),
    keyPlaceholder: mt('订阅令牌'),
    endpointHint: mt('可留空；留空则使用 Brave 官方地址'),
    needsKey: true,
    needsEndpoint: false
  },
  searxng: {
    label: 'SearXNG',
    hint: mt('自建实例，填实例地址即可（形如 http://127.0.0.1:8080）。'),
    keyHint: mt('可选；实例开启鉴权时才需要'),
    keyPlaceholder: mt('可选；实例开启鉴权时填写'),
    endpointHint: mt('必填，形如 http://127.0.0.1:8080（实例需开启 format=json）'),
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
    label: mt('DeepSeek 搜索'),
    hint: mt('DeepSeek 官方检索接口，返回摘要，可额外索取正文；与模型共用一个 Key。'),
    keyHint: mt('必填；DeepSeek 开放平台的 API Key'),
    keyPlaceholder: 'sk-…',
    endpointHint: mt('可留空；留空则用 https://api.deepseek.com（自动补 /v1/tools/search）'),
    needsKey: true,
    needsEndpoint: false
  },
  exa: {
    label: 'Exa',
    hint: mt('语义检索，/search 直接返回整页正文，适合当资料喂给模型。'),
    keyHint: mt('必填；Exa 控制台的 API Key'),
    keyPlaceholder: 'Exa API Key',
    endpointHint: mt('可留空；留空则用 https://api.exa.ai/search'),
    needsKey: true,
    needsEndpoint: false
  },
  serper: {
    label: mt('Serper（Google 结果）'),
    hint: mt('按次计费的 Google 结果代理，返回结构接近官方。'),
    keyHint: mt('必填；请求头是 X-API-KEY，不是 Bearer'),
    keyPlaceholder: 'Serper API Key',
    endpointHint: mt('可留空；留空则用 https://google.serper.dev/search'),
    needsKey: true,
    needsEndpoint: false
  },
  bing: {
    label: 'Bing Web Search',
    hint: mt('Azure 的 Web Search v7，需要订阅密钥。'),
    keyHint: mt('必填；Azure 资源里的 Ocp-Apim-Subscription-Key'),
    keyPlaceholder: mt('Azure 订阅密钥'),
    endpointHint: mt('可留空；留空则用 https://api.bing.microsoft.com/v7.0/search'),
    needsKey: true,
    needsEndpoint: false
  },
  'google-cse': {
    label: mt('Google 可编程搜索'),
    hint: mt('官方 Custom Search JSON API，每日免费额度很小。'),
    keyHint: mt('必填；Google Cloud 里的 API Key'),
    keyPlaceholder: 'Google API Key',
    endpointHint: mt('填搜索引擎 ID：可只写 cx，也可写 https://www.googleapis.com/customsearch/v1?cx=…'),
    needsKey: true,
    needsEndpoint: true,
    caveat: mt('这家除了 API Key 还要 cx（搜索引擎 ID），写在自定义地址里即可。')
  },
  jina: {
    label: mt('Jina Reader 搜索'),
    hint: mt('s.jina.ai 先检索再把正文抽干净，Key 可以不填。'),
    keyHint: mt('可选；不带 Key 也能用，只是限流更早'),
    keyPlaceholder: mt('可选；jina_…'),
    endpointHint: mt('可留空；留空则用 https://s.jina.ai'),
    needsKey: false,
    needsEndpoint: false
  },
  perplexity: {
    label: 'Perplexity Search',
    hint: mt('Perplexity 的 sonar 模型，直接给出带引用的答案。'),
    keyHint: mt('必填；Perplexity 控制台的 API Key'),
    keyPlaceholder: 'pplx-…',
    endpointHint: mt('可留空；留空则用 https://api.perplexity.ai/chat/completions'),
    needsKey: true,
    needsEndpoint: false
  },
  'zhipu-web': {
    label: mt('智谱 Web 搜索'),
    hint: mt('智谱开放平台的 web_search 接口，和 GLM 共用一个 Key。'),
    keyHint: mt('必填；智谱开放平台的 API Key（与 GLM 通用）'),
    keyPlaceholder: mt('智谱 API Key'),
    endpointHint: mt('可留空；留空则用 https://open.bigmodel.cn/api/paas/v4/web_search'),
    needsKey: true,
    needsEndpoint: false
  },
  baidu: {
    label: mt('百度网页'),
    hint: mt('免 Key，抓百度结果页；连续请求会跳验证码。'),
    keyHint: mt('该服务抓取公开结果页，不需要 API Key'),
    keyPlaceholder: mt('该服务不使用'),
    endpointHint: mt('可留空；留空则用 https://www.baidu.com/s'),
    needsKey: false,
    needsEndpoint: false
  }
}

/** Every backend the UI can switch between, in menu order. */
export const SEARCH_PROVIDERS = Object.keys(META) as SearchProvider[]

/** Reads one field out of every row, keeping `Record<SearchProvider, …>` shape. */
function derived<T>(read: (meta: SearchProviderMeta) => T): Record<SearchProvider, T> {
  const table = {} as Record<SearchProvider, T>
  for (const provider of SEARCH_PROVIDERS) table[provider] = read(META[provider])
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
export const SEARCH_PROVIDER_CAVEAT: Partial<Record<SearchProvider, string>> =
  Object.fromEntries(
    SEARCH_PROVIDERS.flatMap((provider) => {
      const caveat = META[provider].caveat
      return caveat ? [[provider, caveat]] : []
    })
  )

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
