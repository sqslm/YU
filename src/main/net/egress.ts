/**
 * One egress path for every outbound request in the main process.
 *
 * ## Why this file exists
 *
 * Node's `fetch` (undici) reads `HTTP(S)_PROXY` and nothing else. It never looks
 * at the Windows proxy settings or a PAC file, so on a machine that reaches the
 * internet through Clash Verge, the main process connected *directly* whenever
 * TUN mode was off and the system proxy carried the traffic. Search answered with
 * timeouts while the browser was fine, which is exactly the report this module
 * fixes.
 *
 * Electron's `net`/`session.fetch` run on Chromium's network stack, which does
 * read the OS proxy configuration and PAC. So:
 * - `applyEgress` pushes the user's choice into the session once per change;
 * - `egressFetch` is the transport every adapter uses instead of the global.
 *
 * ## Design notes
 *
 * - No registry parsing here. Chromium already implements "system proxy + PAC",
 *   including per-URL resolution and WinINET changes at runtime; re-implementing
 *   `ProxyServer`/`ProxyEnable`/`AutoConfigURL` would be a worse copy that also
 *   misses WPAD.
 * - `resolveProxy()` is logged after every change: "the setting was saved" and
 *   "the network stack resolves to a proxy" are different facts, and only the
 *   second one predicts whether a request can leave the machine.
 * - Nothing here logs a key. Probe URLs are `robots.txt`/`/models` only; the
 *   Authorization header is attached but never echoed.
 * - Outside Electron (vitest) `session` is undefined, so the module degrades to
 *   `globalThis.fetch` and `setEgressFetchForTests` is the seam tests use.
 */
import { net, session } from 'electron'
import type { Session } from 'electron'
import { mt } from '@shared/mainI18n'
import type { SearchProvider, Settings } from '@shared/types'
import type {
  EgressDiagnosis,
  EffectiveProxyMode,
  NetworkEnvProxy,
  NetworkMode,
  NetworkProbe
} from '@shared/network'
import { parseHeaderLines } from '../providers/headers'

/**
 * Loopback must never travel through the proxy: a Clash TUN/proxy that receives
 * a request for itself answers with a redirect loop or a DNS failure. `<local>`
 * keeps single-label machine names direct as well.
 */
export const PROXY_BYPASS_RULES = '<local>;127.0.0.1;localhost;::1;[::1]'

/** The `ProxyConfig` slice `setProxy` consumes; typed here so tests need no Electron. */
export interface EgressProxyConfig {
  mode: EffectiveProxyMode
  proxyRules?: string
  proxyBypassRules?: string
}

type EgressLog = (line: string) => void

/**
 * Silent until `index.ts` wires the app logger: a module that prints on import
 * would pollute test output, and the runtime requirement is one line per change,
 * which only the caller can attribute to a file.
 */
let logSink: EgressLog = () => undefined

export function setEgressLog(sink: EgressLog | null): void {
  logSink = sink ?? (() => undefined)
}

export function logEgress(line: string): void {
  try {
    logSink(line)
  } catch {
    // A logger that throws must not turn a working request into a failed one.
  }
}

/**
 * The network settings the running process believes in.
 *
 * `safe-fetch` needs this: a name that does not resolve locally may still be
 * reachable through the proxy (the proxy resolves it remotely), so "cannot judge"
 * has to become "allow" exactly when the request can leave through a proxy.
 */
let currentNetwork: { mode: NetworkMode; proxyUrl: string } = { mode: 'system', proxyUrl: '' }

export function currentNetworkSettings(): { mode: NetworkMode; proxyUrl: string } {
  return { ...currentNetwork }
}

/** True when a request may leave through a proxy instead of this machine's DNS. */
export function proxyEgressActive(): boolean {
  return currentNetwork.mode !== 'direct'
}

/** Test seam: set the mode without an Electron session. */
export function setEgressNetworkForTests(network: { mode: NetworkMode; proxyUrl: string } | null): void {
  currentNetwork = network ? { ...network } : { mode: 'system', proxyUrl: '' }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `127.0.0.1:7897`, `http://…`, `https://…` and `socks5://…` become one canonical
 * URL; everything else (empty, a path, credentials, a non-proxy scheme) is a
 * `null` so the caller can fall back to the system proxy and say so.
 */
export function normalizeProxyUrl(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  // A space almost always means a pasted sentence, not an address.
  if (/\s/.test(text)) return null
  // A bare number is a port someone forgot to pair with a host: `new URL` would
  // happily read `7897` as the decimal address 0.0.30.217 and "succeed".
  if (/^\d+$/.test(text)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'socks5:') return null
  if (!url.hostname) return null
  // Credentials in the URL would end up in the log line this module prints.
  if (url.username || url.password) return null
  // A proxy is `host:port`; a path or query is a pasted API endpoint.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null
  return `${protocol}//${url.host}`
}

/** Chromium's proxy-rules grammar: `host:port`, or `socks5://host:port`. */
function proxyRuleOf(proxyUrl: string): string {
  const url = new URL(proxyUrl)
  return url.protocol === 'socks5:' ? `socks5://${url.host}` : url.host
}

/**
 * The mapping the whole feature rests on.
 *
 * `system` is passed straight through: Chromium reads Windows' proxy/PAC and
 * re-reads it when it changes. `direct` is for a machine that really is online
 * without a proxy. `custom` is for the case that used to be unrepresentable —
 * a proxy the user runs but has not written into the OS settings.
 */
export function proxyRulesFor(network: { mode: NetworkMode; proxyUrl: string } | undefined): EgressProxyConfig {
  const mode = network?.mode
  if (mode === 'direct') return { mode: 'direct' }
  if (mode !== 'custom') return { mode: 'system' }
  const proxyUrl = normalizeProxyUrl(network?.proxyUrl ?? '')
  if (!proxyUrl) {
    logEgress(`[net] custom proxy "${String(network?.proxyUrl ?? '')}" is not http/https/socks5; falling back to the system proxy`)
    return { mode: 'system' }
  }
  return { mode: 'fixed_servers', proxyRules: proxyRuleOf(proxyUrl), proxyBypassRules: PROXY_BYPASS_RULES }
}

function defaultSession(): Session | undefined {
  // Vitest mocks `electron` without every export, and a property access on such a
  // namespace throws instead of returning undefined — so the probe has to be guarded.
  try {
    const ses = (session as unknown as { defaultSession?: Session } | undefined)?.defaultSession
    return ses && typeof ses.setProxy === 'function' ? ses : undefined
  } catch {
    return undefined
  }
}

/**
 * Chromium's transport, or `undefined` outside Electron.
 *
 * `session.fetch` is preferred over `net.fetch` because it names the session the
 * proxy was configured on; both ignore `HTTP(S)_PROXY`, which is the point.
 * (`net.fetch`'s init has no `session` field in Electron's typings, so the older
 * `net.fetch(url, { session })` spelling would be a lie.)
 */
function electronFetch(): typeof fetch | undefined {
  try {
    const ses = defaultSession() as (Session & { fetch?: typeof fetch }) | undefined
    if (ses && typeof ses.fetch === 'function') {
      return (input, init) => ses.fetch!(input, init)
    }
    const electronNet = net as unknown as { fetch?: typeof fetch } | undefined
    if (electronNet && typeof electronNet.fetch === 'function') {
      return (input, init) => electronNet.fetch!(input, init)
    }
  } catch {
    // Not running inside Electron (tests, a Node script): fall back to the global.
  }
  return undefined
}

let testFetch: typeof fetch | undefined

/** Test seam: replace the transport without an Electron session. */
export function setEgressFetchForTests(fn?: typeof fetch | null): void {
  testFetch = fn ?? undefined
}

/**
 * Every main-process request goes through here.
 *
 * Signature-compatible with `typeof fetch` (both argument types are derived from
 * it, because the main-process tsconfig has no DOM lib and `RequestInfo` is not
 * declared there), so it drops into the existing `fetchImpl` seams unchanged.
 * `AbortSignal`, streaming bodies and `redirect: 'manual'` are Chromium features
 * and behave like the browser's.
 */
export function egressFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  const impl = testFetch ?? electronFetch()
  if (impl) return impl(input, init)
  return globalThis.fetch(input, init)
}

/** `resolveProxy` for one URL, never throwing: an unknown answer is data too. */
export async function resolveProxyFor(url: string, ses?: Session | null): Promise<string> {
  const target = ses ?? defaultSession()
  if (!target || typeof target.resolveProxy !== 'function') return 'UNKNOWN'
  try {
    return await target.resolveProxy(url)
  } catch (err) {
    logEgress(`[net] resolveProxy failed: ${describe(err)}`)
    return 'UNKNOWN'
  }
}

/**
 * Push the saved network choice into Chromium and log what it resolves to.
 *
 * Call after `app.whenReady()` (a session does not exist before that) and again
 * after every settings write, so toggling the mode takes effect without a
 * restart.
 */
export async function applyEgress(settings: Settings | undefined): Promise<void> {
  currentNetwork = {
    mode: settings?.network?.mode ?? 'system',
    proxyUrl: settings?.network?.proxyUrl ?? ''
  }
  const config = proxyRulesFor(currentNetwork)
  const ses = defaultSession()
  if (!ses) {
    logEgress(`[net] mode=${currentNetwork.mode} effective=${config.mode} resolved="UNKNOWN" (no Electron session)`)
    return
  }
  try {
    await ses.setProxy({ ...config })
  } catch (err) {
    // Keep going: `resolved` below is the evidence the user needs.
    logEgress(`[net] setProxy failed: ${describe(err)}`)
  }
  const resolved = await resolveProxyFor('https://www.bing.com', ses)
  logEgress(
    `[net] mode=${currentNetwork.mode} effective=${config.mode}` +
      `${config.proxyRules ? ` proxy=${config.proxyRules}` : ''} resolved="${resolved}"`
  )
}

/** Provider origins, used only to build a keyless reachability probe. */
const SEARCH_ORIGINS: Partial<Record<SearchProvider, string>> = {
  tavily: 'https://api.tavily.com',
  brave: 'https://api.search.brave.com',
  exa: 'https://api.exa.ai',
  serper: 'https://google.serper.dev',
  bing: 'https://api.bing.microsoft.com',
  'google-cse': 'https://www.googleapis.com',
  jina: 'https://s.jina.ai',
  perplexity: 'https://api.perplexity.ai',
  'zhipu-web': 'https://open.bigmodel.cn',
  baidu: 'https://www.baidu.com',
  deepseek: 'https://api.deepseek.com',
  duckduckgo: 'https://html.duckduckgo.com',
  searxng: ''
}

interface ProbeSpec {
  label: string
  url: string
  headers?: Record<string, string>
}

/** `origin + /robots.txt` proves reachability without spending a key or a quota. */
function robotsOf(endpoint: string): string | null {
  try {
    const url = new URL(String(endpoint ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.origin}/robots.txt`
  } catch {
    return null
  }
}

function polishProbeHeaders(settings: Settings | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  const polish = settings?.polish
  if (!polish) return headers
  if (polish.extraHeaders) {
    try {
      Object.assign(headers, parseHeaderLines(polish.extraHeaders))
    } catch {
      // Bad extra headers are a settings problem the probe should not inherit.
    }
  }
  const key = String(polish.apiKey ?? '').trim()
  if (key) {
    if (polish.authHeader === 'x-api-key') headers['x-api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  return headers
}

/**
 * The probe set. Deliberately small and independent of the user's provider:
 * when search fails, the first question is "can anything leave this process at
 * all", and the second is "can the configured backend be reached".
 */
export function buildProbes(settings: Settings | undefined): ProbeSpec[] {
  const probes: ProbeSpec[] = [
    { label: 'Bing', url: 'https://www.bing.com/robots.txt' },
    { label: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=ping' }
  ]
  const provider = settings?.search?.provider
  if (provider) {
    const configured = String(settings?.search?.providers?.[provider]?.endpoint ?? '').trim()
    const endpoint = configured || SEARCH_ORIGINS[provider] || ''
    const url = robotsOf(endpoint)
    if (url) probes.push({ label: `${mt('搜索服务')} ${provider}`, url })
  }
  const base = String(settings?.polish?.baseUrl ?? '').trim()
  if (base) {
    probes.push({
      label: mt('常用模型服务'),
      url: `${base.replace(/\/+$/, '')}/models`,
      headers: polishProbeHeaders(settings)
    })
  }
  return probes
}

export interface DiagnoseOptions {
  /** Injected in tests so no real request leaves the machine. */
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to the real session. */
  resolveProxy?: (url: string) => Promise<string>
  env?: NodeJS.ProcessEnv
  /** Per-probe ceiling. */
  timeoutMs?: number
  /** Whole-diagnosis ceiling: a slow probe must not hold the settings page. */
  totalMs?: number
}

async function probeOnce(spec: ProbeSpec, fetchImpl: typeof fetch, options: DiagnoseOptions): Promise<NetworkProbe> {
  const timeoutMs = options.timeoutMs ?? 5000
  const started = Date.now()
  const controller = new AbortController()
  // The overall budget is enforced by the same timer: with every probe running in
  // parallel, the longest one decides, and 5 s per probe stays under the 12 s cap.
  const budget = Math.max(1, Math.min(timeoutMs, options.totalMs ?? 12000))
  const timer = setTimeout(() => controller.abort(new Error(mt('请求超时'))), budget)
  try {
    const response = await fetchImpl(spec.url, {
      method: 'GET',
      headers: { accept: '*/*', ...spec.headers },
      redirect: 'manual',
      signal: controller.signal
    })
    // Reachability is the question; the body is not. Release it immediately.
    await response.body?.cancel().catch(() => undefined)
    return { label: spec.label, url: spec.url, ok: true, status: response.status, ms: Date.now() - started }
  } catch (err) {
    return { label: spec.label, url: spec.url, ok: false, ms: Date.now() - started, error: describe(err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Strip `user:pass@` from a proxy URL: it is shown on screen and in logs. */
function redactProxy(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/\/\/[^/@\s]+@/, '//***@')
}

function envProxyOf(env: NodeJS.ProcessEnv): NetworkEnvProxy {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return redactProxy(value.trim())
    }
    return undefined
  }
  return {
    http: pick('HTTP_PROXY', 'http_proxy'),
    https: pick('HTTPS_PROXY', 'https_proxy'),
    noProxy: pick('NO_PROXY', 'no_proxy')
  }
}

function adviceFor(
  network: { mode: NetworkMode; proxyUrl: string },
  config: EgressProxyConfig,
  resolved: string,
  probes: NetworkProbe[]
): string[] {
  const advice: string[] = []
  if (network.mode === 'custom' && config.mode !== 'fixed_servers') {
    advice.push(mt('自定义代理地址无效，已回退为跟随系统：请填形如 http://127.0.0.1:7897 的地址。'))
  }
  if (network.mode === 'system' && /^DIRECT\b/i.test(resolved)) {
    advice.push(
      mt('系统当前是直连（DIRECT）：Clash Verge 打开「系统代理」，或在这里选「自定义」并填 http://127.0.0.1:7897。')
    )
  }
  const failed = probes.filter(probe => !probe.ok)
  if (failed.length) {
    advice.push(
      mt('{{count}} 个探测点失败：先确认代理软件正在运行，再打开它的系统代理，或在此填自定义代理地址。', {
        count: failed.length
      })
    )
  }
  if (!advice.length) advice.push(mt('网络连通，当前出口正常。'))
  return advice
}

/**
 * What the settings page shows under 「检查网络」.
 *
 * Runs real requests through the same transport as production traffic, so a user
 * who sees failures here is seeing the app's actual egress, not a separate
 * implementation that might agree with them for the wrong reason.
 */
export async function diagnoseEgress(
  settings: Settings | undefined,
  options: DiagnoseOptions = {}
): Promise<EgressDiagnosis> {
  const network = {
    mode: settings?.network?.mode ?? 'system',
    proxyUrl: settings?.network?.proxyUrl ?? ''
  }
  const config = proxyRulesFor(network)
  const resolved = options.resolveProxy
    ? await options.resolveProxy('https://www.bing.com').catch(() => 'UNKNOWN')
    : await resolveProxyFor('https://www.bing.com')
  const fetchImpl = options.fetchImpl ?? egressFetch
  const probes = await Promise.all(buildProbes(settings).map(spec => probeOnce(spec, fetchImpl, options)))
  return {
    mode: network.mode,
    proxyUrl: network.proxyUrl,
    effective: config.mode,
    resolved,
    envProxy: envProxyOf(options.env ?? process.env),
    probes,
    advice: adviceFor(network, config, resolved, probes)
  }
}
