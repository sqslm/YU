/**
 * The one SSRF guard the main process uses for model-chosen and user-chosen URLs.
 *
 * Two callers used to carry their own copy of this logic: `read_webpage` checked
 * the URL string and followed redirects by hand, while the ICS subscriber handed a
 * bare `fetch` to undici and inherited `redirect: 'follow'`. Both had the same
 * hole. A string check cannot see that `localtest.me` is an ordinary public name
 * whose A record is 127.0.0.1, and `redirect: 'follow'` issues the request to the
 * redirect target *before* anyone gets to look at it. So the guard here resolves
 * the host and judges the addresses, and it runs again on every hop instead of
 * only on the URL the caller started with.
 *
 * Nothing in this file trusts its input: an unresolvable host is refused, because
 * "cannot judge" has to mean "do not connect".
 */
import { lookup } from 'node:dns/promises'
import { mt } from '@shared/mainI18n'

/** Redirects followed by hand, so every hop is checked before it is requested. */
export const MAX_SAFE_REDIRECTS = 5

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** A name server that answers questions is not a name server worth waiting on. */
const DEFAULT_DNS_TIMEOUT_MS = 4000

/** Hosts that must never be reachable from a model-chosen URL. */
const PRIVATE_HOST =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/

export interface UrlCheck {
  ok: boolean
  url?: URL
  error?: string
}

/** Only the slice of `node:dns` this module needs, so a test can answer instead. */
export type HostResolver = (host: string) => Promise<Array<{ address: string; family?: number }>>

export interface SafeFetchOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to a real `lookup(host, { all: true })`. */
  resolveHost?: HostResolver
  /**
   * Skips the address check, keeping only the URL-string check.
   *
   * Reserved for a transport that is already a seam — an injected fake fetch with
   * fictional hostnames, where there is no address to judge. Real traffic must
   * never set this: it is the difference between "refused" and "requested".
   */
  skipAddressCheck?: boolean
  maxRedirects?: number
  dnsTimeoutMs?: number
}

/**
 * Protocol + host allow-list. Exported so every caller and its tests agree.
 *
 * Synchronous on purpose: it is the cheap half, and the callers that cannot do a
 * lookup (settings validation, a URL typed into a form) still get this much.
 */
export function inspectUrl(raw: string): UrlCheck {
  let url: URL
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return { ok: false, error: 'URL 无法解析' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只允许 http/https 链接' }
  }
  const host = url.hostname.toLowerCase()
  if (!host) return { ok: false, error: 'URL 缺少主机名' }
  if (PRIVATE_HOST.test(host)) return { ok: false, error: '拒绝访问内网地址' }
  // CGNAT (100.64.0.0/10) is not RFC1918 but is still carrier-internal, and
  // 100.100.100.200 is the Alibaba Cloud metadata endpoint.
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) {
    return { ok: false, error: '拒绝访问内网地址' }
  }
  // WHATWG URL accepts several spellings of an IPv4 literal: decimal
  // (2130706433), hex (0x7f000001), octal (0177.0.0.1) and mixed. All of them
  // resolve to a real address while looking like a name, so any host whose
  // labels are only digits or hex is treated as an address literal. The dotted
  // private ranges above are the normal form; this is the alias form.
  if (host.split('.').every((label) => /^(?:\d+|0x[0-9a-f]+)$/i.test(label))) {
    return { ok: false, error: '拒绝访问 IP 直连地址，请使用域名' }
  }
  if (/\.(?:local|internal|lan|home\.arpa)$/.test(host)) {
    return { ok: false, error: '拒绝访问内网域名' }
  }
  if (host.startsWith('[')) {
    // URL#hostname keeps the brackets for IPv6 literals.
    if (
      host === '[::1]' ||
      host === '[::]' ||
      host.startsWith('[::ffff:') ||
      host.startsWith('[fe80:') ||
      // Unique local addresses (fc00::/7) and site-local (fec0::/10).
      host.startsWith('[fc') ||
      host.startsWith('[fd') ||
      host.startsWith('[fec')
    ) {
      return { ok: false, error: '拒绝访问内网地址' }
    }
  }
  return { ok: true, url }
}

/** Drops the brackets WHATWG keeps around an IPv6 literal, and any zone id. */
function bareHost(hostname: string): string {
  const host = String(hostname ?? '').trim().toLowerCase()
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const zoneAt = unbracketed.indexOf('%')
  return zoneAt === -1 ? unbracketed : unbracketed.slice(0, zoneAt)
}

function looksLikeIp(host: string): boolean {
  return /^[0-9.]+$/.test(host) ? host.split('.').length === 4 : host.includes(':')
}

function expandV6(text: string): number[] | undefined {
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 0 : head.length !== 8) return undefined
  const groups = halves.length === 2
    ? [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
    : head
  const parsed: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined
    parsed.push(parseInt(group, 16))
  }
  return parsed.length === 8 ? parsed : undefined
}

function isPrivateV6(address: string): boolean {
  if (address === '::1' || address === '::') return true
  // Both v4-mapped (::ffff:7f00:1) and NAT64 (64:ff9b::7f00:1) carry the address in
  // the last 32 bits, so the judgement is the same as for the dotted form.
  const embedded = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (embedded) {
    const high = parseInt(embedded[1], 16)
    const low = parseInt(embedded[2], 16)
    return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return isPrivateAddress(mapped[1])
  const groups = expandV6(address)
  if (!groups) return true
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True when `address` is not a globally routable unicast address.
 *
 * Anything unparseable counts as private: a caller that cannot classify an
 * address must not be told "public" and connect.
 */
export function isPrivateAddress(address: string): boolean {
  const value = bareHost(address)
  if (!value) return true
  if (value.includes(':')) return isPrivateV6(value)
  const octets = value.split('.')
  if (octets.length !== 4) return true
  const parts = octets.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 benchmarking
  if (a >= 224) return true // multicast and reserved
  return false
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

const realResolver: HostResolver = (host) => lookup(host, { all: true })

/**
 * Refuses a host whose addresses are not all public.
 *
 * Every answer is checked, not just the first: a name with both a public and a
 * private A record would otherwise be a coin flip per connection, and the runtime
 * may retry on the private one after the public attempt fails.
 */
export async function assertPublicHost(hostname: string, options: SafeFetchOptions = {}): Promise<void> {
  if (options.skipAddressCheck) return
  const host = bareHost(hostname)
  if (looksLikeIp(host)) {
    if (isPrivateAddress(host)) throw new Error(mt('拒绝访问内网地址'))
    return
  }
  const resolve = options.resolveHost ?? realResolver
  const timeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS
  let answers: Array<{ address: string; family?: number }>
  try {
    answers = await withDeadline(resolve(host), timeoutMs)
  } catch {
    // No answer, a timeout or SERVFAIL all mean the same thing here: we cannot say
    // where this name points, so we do not send the request.
    throw new Error(mt('域名解析失败：{{host}}', { host }))
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error(mt('域名解析失败：{{host}}', { host }))
  }
  for (const answer of answers) {
    if (isPrivateAddress(answer.address)) throw new Error(mt('拒绝访问内网地址'))
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `fetch` with the guard in front of every hop.
 *
 * `redirect: 'manual'` makes the redirect a value instead of a side effect: the
 * Location header is inspected, resolved and re-checked before it is requested,
 * and the loop is bounded so a redirect cycle cannot hang the caller. A non-2xx
 * response is returned rather than thrown, because "the server said 404" is an
 * answer the callers report to the user.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error(mt('当前环境不支持网络请求'))
  const maxRedirects = options.maxRedirects ?? MAX_SAFE_REDIRECTS
  let target = String(url ?? '').trim()
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = inspectUrl(target)
    if (!check.ok || !check.url) {
      // The first hop reports its own reason ("拒绝访问内网域名"); a later one is a
      // redirect, and saying so is what lets the user tell the two apart.
      throw new Error(hop === 0 ? (check.error ?? 'URL 不合法') : mt('重定向到不允许的地址：{{url}}', { url: target }))
    }
    await assertPublicHost(check.url.hostname, options)
    let response: Response
    try {
      response = await doFetch(target, { ...init, redirect: 'manual' })
    } catch (err) {
      throw new Error(mt('抓取失败：{{message}}', { message: describe(err) }))
    }
    const location = response.headers.get('location')
    if (REDIRECT_STATUS.has(response.status) && location) {
      // Release the empty redirect body so the connection is not held.
      await response.body?.cancel().catch(() => undefined)
      try {
        target = new URL(location, target).toString()
      } catch {
        throw new Error(mt('重定向地址无法解析：{{location}}', { location }))
      }
      continue
    }
    /**
     * `redirect: 'manual'` covers a plain fetch, but a system proxy or a wrapped
     * fetch can still follow on its own: `response.url` is then where the bytes
     * actually came from, and that address has to pass the same check.
     */
    const landed = response.url || target
    if (landed !== target) {
      const recheck = inspectUrl(landed)
      if (!recheck.ok || !recheck.url) {
        throw new Error(mt('重定向到不允许的地址：{{url}}', { url: landed }))
      }
      await assertPublicHost(recheck.url.hostname, options)
    }
    return response
  }
  throw new Error('重定向次数过多')
}
