/**
 * `read_webpage`: fetch one page and reduce it to readable text.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **SSRF guard.** Only http(s) leaves the machine, and only to a public
 *    host — `localhost`, RFC1918 ranges, link-local, IPv6 loopback and the
 *    `.local` / `.internal` suffixes are refused before a socket is opened.
 *    Redirects are re-validated, so a public URL cannot bounce into the LAN.
 * 2. **The page is data, never instructions.** The extractor keeps prose only
 *    (script/style/nav/header/footer/aside/form/iframe/svg are dropped) and the
 *    caller wraps the result in `<untrusted_page>` before it reaches a prompt.
 *
 * No DOM, no readability library: a handful of regexes is enough for "roughly
 * the article body", and "roughly" is all an answer needs.
 */
import { mt } from '@shared/mainI18n'


const DEFAULT_MAX_BYTES = 600 * 1024
const DEFAULT_MAX_CHARS = 6000
const MAX_TITLE_CHARS = 300

/**
 * Hard ceiling for one page read. A slow origin — or a host that accepts the
 * connection and then dribbles bytes — must never hold the take: six seconds is
 * already generous for an article body, and the caller can degrade to snippets.
 */
export const DEFAULT_READ_TIMEOUT_MS = 6000

/** Hosts that must never be reachable from a model-chosen URL. */
const PRIVATE_HOST =
  /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/

export interface ReadWebpageOptions {
  signal?: AbortSignal
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  maxBytes?: number
  maxChars?: number
  /**
   * Hard ceiling for fetch + body read, in milliseconds. `0` disables it.
   * Defaults to `DEFAULT_READ_TIMEOUT_MS`.
   */
  timeoutMs?: number
}

export interface WebpageContent {
  ok: boolean
  url?: string
  title?: string
  text?: string
  truncated?: boolean
  error?: string
}

export interface UrlCheck {
  ok: boolean
  url?: URL
  error?: string
}

/** Protocol + host allow-list. Exported so the tool and its tests agree. */
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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®'
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => safeCodePoint(parseInt(hex, 16)) || match)
    .replace(/&#(\d+);/g, (match, dec: string) => safeCodePoint(parseInt(dec, 10)) || match)
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * Blocks whose text is chrome, boilerplate or code — never the answer body.
 * `title` is in here too: it is captured separately, and leaving it in would
 * prepend the page title to every article body.
 */
const NOISE_BLOCK =
  /<(script|style|noscript|template|svg|canvas|iframe|nav|header|footer|aside|form|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/** Exported for tests: HTML → `{title, text}` with the noise removed. */
export function cleanHtml(html: string): { title: string; text: string } {
  const source = String(html ?? '')
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, ' ')

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutComments)
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
    : ''

  // Nested blocks (`<nav><script>`) need a second pass; loops converge fast.
  let body = withoutComments
  let previous = ''
  while (previous !== body) {
    previous = body
    body = body.replace(NOISE_BLOCK, ' ')
  }
  // An unclosed <script> at the end of a truncated document would swallow the
  // rest of the page; drop the tail instead.
  body = body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*$/gi, ' ')
  body = body
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const text = decodeEntities(body)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()

  return { title, text }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type DeadlineReason = 'timeout' | 'aborted' | 'error'

export type DeadlineOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DeadlineReason; error?: unknown }

/**
 * Runs `work` under a hard deadline. Shared by every network step in Ask mode
 * (page read, provider search, LLM round) so no single slow hop can stall the
 * whole take.
 *
 * The race is deliberate: `fetch` honours an abort signal, but a provider that
 * buffers, a gateway that ignores signals, or a mocked transport will not — and
 * waiting forever is worse than degrading to what we already have. `work` still
 * receives a signal, so a well-behaved transport actually closes its socket.
 *
 * Never rejects: a genuine failure comes back as `{ok: false, reason: 'error'}`.
 */
export async function runWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) forwardAbort()
    else parent.addEventListener('abort', forwardAbort, { once: true })
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new Error('deadline exceeded'))
        }, timeoutMs)
      : null
  // A pending timeout must never keep the process alive on its own.
  ;(timer as unknown as { unref?: () => void } | null)?.unref?.()

  const expired = new Promise<DeadlineOutcome<T>>((resolve) => {
    const settle = (): void => resolve({ ok: false, reason: timedOut ? 'timeout' : 'aborted' })
    if (controller.signal.aborted) settle()
    else controller.signal.addEventListener('abort', settle, { once: true })
  })

  const task = work(controller.signal).then(
    (value): DeadlineOutcome<T> => ({ ok: true, value }),
    (error): DeadlineOutcome<T> => ({
      ok: false,
      reason: timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'error',
      error
    })
  )

  try {
    return await Promise.race([task, expired])
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Fetches `rawUrl` and returns cleaned text. Never throws: every failure is an
 * `{ok: false, error}` so the model can say it could not read the page.
 */
export async function readWebpage(
  rawUrl: string,
  options: ReadWebpageOptions = {}
): Promise<WebpageContent> {
  const check = inspectUrl(rawUrl)
  if (!check.ok || !check.url) return { ok: false, error: check.error ?? 'URL 不合法' }
  const target = check.url.toString()

  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, error: '当前环境不支持网络请求' }

  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  const outcome = await runWithDeadline(
    (signal) => loadPage(target, doFetch, signal, options),
    options.signal,
    timeoutMs
  )
  if (outcome.ok) return outcome.value
  if (outcome.reason === 'timeout') {
    return { ok: false, error: mt('读取超时（{{seconds}}s）', { seconds: Math.round(timeoutMs / 1000) }) }
  }
  if (outcome.reason === 'aborted') return { ok: false, error: '读取已取消' }
  return { ok: false, error: mt('抓取失败：{{message}}', { message: messageOf(outcome.error) }) }
}

/** Redirects followed by hand, so every hop is checked before it is requested. */
const MAX_REDIRECTS = 5
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const FETCH_HEADERS = {
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  'user-agent': 'Mozilla/5.0 (compatible; Typeless/1.0; +https://typeless.local)'
}

type Fetched =
  | { ok: true; response: Response; url: string }
  | { ok: false; error: string }

/**
 * Fetches `target` with every hop validated **before** the request is issued.
 *
 * `redirect: 'follow'` asked the runtime to fetch whatever the server pointed at
 * and only then compared the landing URL: a redirect to `http://127.0.0.1:8080/`
 * or to a cloud metadata endpoint had already been requested by the time the
 * check ran. Following redirects by hand puts `inspectUrl` in front of each one.
 */
async function fetchChecked(
  target: string,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined
): Promise<Fetched> {
  let url = target
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = inspectUrl(url)
    if (!check.ok) return { ok: false, error: mt('不允许的地址：{{url}}', { url }) }
    let response: Response
    try {
      response = await doFetch(url, { signal, redirect: 'manual', headers: FETCH_HEADERS })
    } catch (err) {
      return { ok: false, error: mt('抓取失败：{{message}}', { message: messageOf(err) }) }
    }
    const location = response.headers.get('location')
    if (REDIRECT_STATUS.has(response.status) && location) {
      // Release the empty redirect body so the connection is not held.
      await response.body?.cancel().catch(() => undefined)
      try {
        url = new URL(location, url).toString()
      } catch {
        return { ok: false, error: mt('重定向地址无法解析：{{location}}', { location }) }
      }
      continue
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    /**
     * `redirect: 'manual'` covers a plain fetch, but a system proxy or a wrapped
     * fetch can still follow on its own: `response.url` is then where the bytes
     * actually came from, and that address has to pass the same check.
     */
    const landed = response.url || url
    if (landed !== url) {
      const recheck = inspectUrl(landed)
      if (!recheck.ok) return { ok: false, error: mt('重定向到不允许的地址：{{url}}', { url: landed }) }
      url = landed
    }
    return { ok: true, response, url }
  }
  return { ok: false, error: '重定向次数过多' }
}

/**
 * Reads at most `maxBytes` of the body.
 *
 * `await response.text()` buffered the whole page before slicing it, so one
 * link to a 200 MB file was a 200 MB allocation plus the parsing that followed.
 */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  // Some fetch implementations (and every hand-written test double) hand back an
  // object with only `text()`; there is nothing to stream there, so fall back to
  // reading the whole thing and let the caller slice it.
  if (!reader) return response.text()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      out += decoder.decode(value, { stream: true })
      if (received >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    // A truncated or reset stream still yields what did arrive.
  }
  return out + decoder.decode()
}

async function loadPage(
  target: string,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined,
  options: ReadWebpageOptions
): Promise<WebpageContent> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  const fetched = await fetchChecked(target, doFetch, signal)
  if (!fetched.ok) return fetched
  const { response, url: landed } = fetched

  let body: string
  try {
    body = await readLimited(response, maxBytes)
  } catch (err) {
    return { ok: false, error: mt('读取失败：{{message}}', { message: messageOf(err) }) }
  }

  const sliced = body.length > maxBytes ? body.slice(0, maxBytes) : body
  const contentType = response.headers.get('content-type') ?? ''
  const looksHtml = /html|xml/i.test(contentType) || /<html|<body|<!doctype/i.test(sliced.slice(0, 1024))
  const cleaned = looksHtml
    ? cleanHtml(sliced)
    : { title: '', text: sliced.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s+/g, ' ').trim() }

  const truncated = sliced.length < body.length || cleaned.text.length > maxChars
  const text = cleaned.text.length > maxChars ? cleaned.text.slice(0, maxChars) : cleaned.text

  return {
    ok: true,
    url: landed,
    title: cleaned.title,
    text,
    truncated
  }
}
