/**
 * `read_webpage`: fetch one page and reduce it to readable text.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **SSRF guard.** Delegated to `safe-fetch`: only http(s) leaves the machine,
 *    only to a public host (the name is resolved and every address judged, so a
 *    public-looking name that points at 127.0.0.1 is refused too), and every
 *    redirect hop is re-validated before it is requested.
 * 2. **The page is data, never instructions.** The extractor keeps prose only
 *    (script/style/nav/header/footer/aside/form/iframe/svg are dropped) and the
 *    caller wraps the result in `<untrusted_page>` before it reaches a prompt.
 *
 * No DOM, no readability library: a handful of regexes is enough for "roughly
 * the article body", and "roughly" is all an answer needs.
 */
import { mt } from '@shared/mainI18n'
import {
  MAX_SAFE_REDIRECTS,
  inspectUrl,
  safeFetch,
  type HostResolver,
  type UrlCheck
} from '../safe-fetch'

/**
 * The guard now lives in `safe-fetch` so the ICS subscriber can share it. It is
 * re-exported here because this module was its first home and callers (and tests)
 * import it from this path.
 */
export { inspectUrl, type UrlCheck }

const DEFAULT_MAX_BYTES = 600 * 1024
const DEFAULT_MAX_CHARS = 6000
const MAX_TITLE_CHARS = 300

/**
 * Hard ceiling for one page read. A slow origin — or a host that accepts the
 * connection and then dribbles bytes — must never hold the take: six seconds is
 * already generous for an article body, and the caller can degrade to snippets.
 */
export const DEFAULT_READ_TIMEOUT_MS = 6000

export interface ReadWebpageOptions {
  signal?: AbortSignal
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /**
   * Injected in tests; defaults to a real DNS lookup. When it is absent but
   * `fetchImpl` is a test double, the address check is skipped: a stub is driven by
   * fictional hostnames that no resolver could answer for. A real transport — even
   * passed explicitly — is still checked.
   */
  resolveHost?: HostResolver
  maxBytes?: number
  maxChars?: number
  /** Explicit current-page summaries prefer article/main over site chrome. */
  mainContent?: boolean
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
export function cleanHtml(html: string, mainContent = false): { title: string; text: string } {
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
  if (mainContent) {
    // Remove scripts first: embedded HTML strings are not the actual article.
    const articles = [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)]
    body = articles.length ? articles.map(match => match[1]).join('\n') : /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1] ?? body
  }
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
const FETCH_HEADERS = {
  accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  'user-agent': 'Mozilla/5.0 (compatible; YU/1.0)'
}

type Fetched =
  | { ok: true; response: Response; url: string }
  | { ok: false; error: string }

/**
 * True for a hand-written transport, i.e. a test double.
 *
 * The address check resolves the host name, and a double is driven by fictional
 * names (`example.test`) that no resolver can answer for. The *real* `fetch` — even
 * when a caller passes it explicitly, as the tool context does — still gets the
 * check: skipping it there would leave the guard comparing strings only, which is
 * the hole this file exists to close.
 */
function isStubTransport(impl: typeof fetch | undefined): boolean {
  return impl !== undefined && impl !== globalThis.fetch
}

/**
 * Fetches `target` with every hop validated **before** the request is issued.
 *
 * The hop loop itself lives in `safe-fetch`: `redirect: 'follow'` asked the
 * runtime to fetch whatever the server pointed at and only then compared the
 * landing URL, and the ICS subscriber had the same hole with a bare `fetch`. One
 * implementation, one place to keep right.
 */
async function fetchChecked(
  target: string,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined,
  options: ReadWebpageOptions
): Promise<Fetched> {
  let response: Response
  try {
    response = await safeFetch(target, { signal, headers: FETCH_HEADERS }, {
      fetchImpl: doFetch,
      maxRedirects: MAX_SAFE_REDIRECTS,
      skipAddressCheck: options.resolveHost === undefined && isStubTransport(options.fetchImpl),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost })
    })
  } catch (err) {
    // `safeFetch` already prefixes its own failures ("抓取失败：…", "重定向…"), so
    // wrapping again would print the prefix twice.
    return { ok: false, error: messageOf(err) }
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
  return { ok: true, response, url: response.url || target }
}

/**
 * Reads at most `maxBytes` of the body.
 *
 * `await response.text()` buffered the whole page before slicing it, so one
 * link to a 200 MB file was a 200 MB allocation plus the parsing that followed.
 */
async function readLimited(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  // Some fetch implementations (and every hand-written test double) hand back an
  // object with only `text()`; there is nothing to stream there, so fall back to
  // reading the whole thing and let the caller slice it.
  if (!reader) {
    const body = await response.text()
    return { body: body.slice(0, maxBytes), truncated: body.length > maxBytes }
  }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let received = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = value.subarray(0, maxBytes - received)
      received += chunk.byteLength
      out += decoder.decode(chunk, { stream: true })
      if (received >= maxBytes) {
        truncated = true
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    // A truncated or reset stream still yields what did arrive.
    truncated = true
  }
  return { body: out + decoder.decode(), truncated }
}

async function loadPage(
  target: string,
  doFetch: typeof fetch,
  signal: AbortSignal | undefined,
  options: ReadWebpageOptions
): Promise<WebpageContent> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  const fetched = await fetchChecked(target, doFetch, signal, options)
  if (!fetched.ok) return fetched
  const { response, url: landed } = fetched

  let body: string
  let partial = false
  try {
    const limited = await readLimited(response, maxBytes)
    body = limited.body; partial = limited.truncated
  } catch (err) {
    return { ok: false, error: mt('读取失败：{{message}}', { message: messageOf(err) }) }
  }

  const sliced = body.length > maxBytes ? body.slice(0, maxBytes) : body
  const contentType = response.headers.get('content-type') ?? ''
  const looksHtml = /html|xml/i.test(contentType) || /<html|<body|<!doctype/i.test(sliced.slice(0, 1024))
  const cleaned = looksHtml
    ? cleanHtml(sliced, options.mainContent)
    : { title: '', text: sliced.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s+/g, ' ').trim() }

  const truncated = partial || sliced.length < body.length || cleaned.text.length > maxChars
  const text = cleaned.text.length > maxChars ? cleaned.text.slice(0, maxChars) : cleaned.text

  return {
    ok: true,
    url: landed,
    title: cleaned.title,
    text,
    truncated
  }
}
