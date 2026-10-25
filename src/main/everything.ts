/**
 * Everything (voidtools) integration: filename/metadata lookup over the local
 * index instead of walking the disk ourselves.
 *
 * Three tiers, each cheaper to abandon than to hang on:
 *
 * 1. **HTTP service** — `GET http://127.0.0.1:<port>/?search=…&json=1`. This is
 *    the normal case (the user enabled "HTTP 服务器" in Everything) and answers
 *    in milliseconds.
 * 2. **es.exe** — the command-line client Everything ships; used when the HTTP
 *    service is off but the install is on PATH or in Program Files.
 * 3. **Unavailable** — `{available:false, reason}`, so the caller can fall back
 *    to the built-in search and *say so*, rather than pretending the machine has
 *    an index.
 *
 * The host is a constant. Everything's service listens on loopback and a
 * configurable host would turn a settings field into an SSRF primitive, so the
 * port is configurable and the address is not; redirects are refused outright
 * for the same reason.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat as statFile } from 'node:fs/promises'
import { basename, join, isAbsolute } from 'node:path'
import { mt } from '@shared/mainI18n'

/** Everything's HTTP server default. */
export const EVERYTHING_DEFAULT_PORT = 80
/** Connect-and-answer budget for tier 1; a local index is never this slow. */
export const EVERYTHING_TIMEOUT_MS = 1500
/** es.exe has to start a process and talk to its IPC, so it gets slightly more. */
export const EVERYTHING_CLI_TIMEOUT_MS = 2500
export const EVERYTHING_LIMIT = 20
export const EVERYTHING_MAX_LIMIT = 50

export interface EverythingHit {
  name: string
  path: string
  size: number
  /** ISO 8601; empty when the backend did not report a usable timestamp. */
  modifiedAt: string
}

export interface EverythingResult {
  available: boolean
  backend: 'http' | 'cli' | 'none'
  query: string
  hits: EverythingHit[]
  /** Everything's own total (`totalResults`), not the page we kept. */
  total: number
  truncated: boolean
  /** Human-readable why-was-it-unavailable sentence; empty on success. */
  reason: string
  /**
   * Set only when `hits` are the rows a deadline cut short. Callers that need to
   * branch on the cause get a stable value instead of parsing Chinese prose.
   */
  failure?: 'timeout'
}

/** The stream slice of a child process this module listens to. */
export interface ChildStreamLike {
  setEncoding: (encoding: string) => unknown
  on: (event: 'data', listener: (chunk: string) => void) => unknown
}

/**
 * The slice of `node:child_process.spawn` this module uses. Kept structural
 * because the real overloads resolve to `ChildProcessWithoutNullStreams`, which
 * no test double can satisfy without a cast.
 */
export interface ChildLike {
  stdout?: ChildStreamLike | null
  stderr?: ChildStreamLike | null
  on: {
    (event: 'error', listener: (error: Error) => void): unknown
    (event: 'close', listener: (code: number | null) => void): unknown
  }
  kill?: (signal?: string) => unknown
}

export interface EverythingOptions {
  cliPath?: string
  /** HTTP port of the Everything service. `false` disables tier 1 entirely. */
  port?: number
  http?: boolean
  limit?: number
  timeoutMs?: number
  cliTimeoutMs?: number
  signal?: AbortSignal
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to `node:child_process.spawn`. */
  spawnImpl?: (command: string, args: string[], options: { windowsHide: boolean; signal?: AbortSignal }) => ChildLike
  /** Injected in tests: does this candidate `es.exe` exist. */
  fileExists?: (path: string) => boolean | Promise<boolean>
  /** Injected in tests: PATH used to find es.exe; defaults to the process PATH. */
  pathValue?: string
  /** Injected in tests: environment used for the usual install folders. */
  env?: Record<string, string | undefined>
  /** Injected in tests: size/mtime for an es.exe result line. */
  statImpl?: (path: string) => Promise<{ size: number; mtimeMs: number }>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampLimit(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number) || number <= 0) return EVERYTHING_LIMIT
  return Math.min(Math.floor(number), EVERYTHING_MAX_LIMIT)
}

/** A configured port wins, anything unusable falls back to the stock 80. */
export function everythingPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : EVERYTHING_DEFAULT_PORT
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])$/i

/** Loopback allow-list, exported so a caller can refuse a user-supplied host. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(String(host ?? '').trim())
}

/**
 * The one URL this module may request. Built by hand rather than with
 * `URLSearchParams` so the encoder stays `encodeURIComponent` — `%20`, not `+` —
 * because Everything's parser is happier with it and the shape is then exactly
 * the documented one.
 */
export function everythingUrl(query: string, port: unknown = EVERYTHING_DEFAULT_PORT, limit = EVERYTHING_LIMIT): string {
  const target = `http://127.0.0.1:${everythingPort(port)}/`
  // The address is a literal above; this keeps the invariant checked in one place
  // even if someone later tries to make the host configurable.
  if (!isLoopbackHost(new URL(target).hostname)) throw new Error(mt('Everything 检索只允许本机回环地址'))
  return `${target}?search=${encodeURIComponent(String(query ?? '').trim())}&json=1&path_column=1&count=${clampLimit(limit)}`
}

/** Everything reports FILETIME: 100 ns ticks since 1601-01-01 UTC. */
function fileTime(value: unknown): string {
  const ticks = Number(value)
  if (!Number.isFinite(ticks) || ticks <= 0) return ''
  const ms = ticks / 10_000 - 11_644_473_600_000
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ''
}

function toSize(value: unknown): number {
  const size = Number(value)
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
}

/** Normalizes one Everything JSON page. Exported so the field mapping is tested. */
export function normalizeEverythingJson(payload: unknown, limit: number): EverythingHit[] {
  const rows = (payload as { results?: unknown } | null)?.results
  if (!Array.isArray(rows)) return []
  const hits: EverythingHit[] = []
  for (const row of rows.slice(0, clampLimit(limit))) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    // path_column=1 gives the containing folder; older builds put the whole path
    // in `name`, so either shape has to end up with one absolute path.
    const folder = typeof record.path === 'string' ? record.path.trim() : ''
    const path = folder && name ? join(folder, name) : name || folder
    if (!path) continue
    hits.push({
      // Always the leaf name: older builds put the whole path in `name`, and a
      // card that repeats the folder reads worse than one that does not.
      name: basename(path),
      path,
      size: toSize(record.size),
      modifiedAt: fileTime(record.date_modified)
    })
  }
  return hits
}

type Bounded<T> = { ok: true; value: T } | { ok: false; error: string; timedOut: boolean }

/** Races `work` against a deadline; the loser is aborted, never awaited forever. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number
): Promise<Bounded<T>> {
  const controller = new AbortController()
  const forward = (): void => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) forward()
    else parent.addEventListener('abort', forward, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  // The abort can surface as the work's own rejection a microtask before the
  // deadline settles, so the flag — not the race winner — decides what happened.
  let expired = false
  const deadline = new Promise<{ ok: false; error: string; timedOut: boolean }>(resolve => {
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error('timeout'))
      resolve({ ok: false, error: mt('{{ms}} 毫秒内没有响应', { ms: timeoutMs }), timedOut: true })
    }, Math.max(1, timeoutMs))
    // A pending deadline must not keep the process alive on its own.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  const task = work(controller.signal).then(
    (value): Bounded<T> => ({ ok: true, value }),
    (error): Bounded<T> => ({ ok: false, error: messageOf(error), timedOut: expired })
  )
  try {
    return await Promise.race([task, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener('abort', forward)
  }
}

/**
 * Why a tier produced nothing usable. The distinction is the whole point of the
 * wording below: "no answer at all", "something answered but it is not
 * Everything" and "es.exe is not installed" send the user to three different
 * places, and the old single sentence sent all of them to the firewall.
 */
type TierFailure = 'timeout' | 'no-response' | 'not-everything' | 'missing' | 'failed'

interface TierResult {
  ok: boolean
  hits: EverythingHit[]
  total: number
  truncated: boolean
  error: string
  code: TierFailure | ''
}

const parseJson = (text: string): unknown => {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

/**
 * Complete row objects inside a JSON body that arrived cut short.
 *
 * Everything streams one flat `results` array, so every row is a balanced object
 * at brace depth 2. Scanning for those — and skipping over strings, so a brace in
 * a file name cannot close a row early — is what lets a slow server still answer
 * with the rows that did arrive instead of nothing at all.
 */
function salvageRows(text: string): unknown[] {
  const rows: unknown[] = []
  let depth = 0
  let start = -1
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{') {
      depth += 1
      if (depth === 2) start = index
      continue
    }
    if (char !== '}') continue
    if (depth === 2 && start >= 0) {
      const row = parseJson(text.slice(start, index + 1))
      if (row !== undefined) rows.push(row)
      start = -1
    }
    depth = Math.max(0, depth - 1)
  }
  return rows
}

/**
 * Reads the body incrementally so a caller that times out can look at what had
 * already arrived. `Response.body` is typed differently by the DOM and the Node
 * typings, hence the structural cast; a body-less fake falls back to `text()`.
 */
async function readBody(response: Response, onProgress: (text: string) => void): Promise<string> {
  const body = response.body as unknown as
    | { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } }
    | null
    | undefined
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text()
    onProgress(text)
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value) continue
    text += decoder.decode(chunk.value, { stream: true })
    onProgress(text)
  }
  return text + decoder.decode()
}

/** Tier 1: the HTTP service. */
async function queryHttp(query: string, options: EverythingOptions, limit: number): Promise<TierResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, hits: [], total: 0, truncated: false, error: 'no fetch', code: 'no-response' }
  const url = everythingUrl(query, options.port, limit)
  const fail = (error: string, code: TierFailure): TierResult => ({ ok: false, hits: [], total: 0, truncated: false, error, code })
  let received = ''
  let code: TierFailure = 'no-response'
  const outcome = await bounded(async signal => {
    // `redirect: 'error'` keeps a hypothetical bounce off-loopback impossible.
    const response = await doFetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) {
      // Something is listening, it just is not Everything: say so instead of
      // letting a connection-level sentence send the user to the firewall.
      code = 'not-everything'
      throw new Error(`HTTP ${response.status}`)
    }
    const text = await readBody(response, partial => { received = partial })
    return { text, url: response.url }
  }, options.signal, options.timeoutMs ?? EVERYTHING_TIMEOUT_MS)
  if (!outcome.ok) {
    // A deadline is the only case worth salvaging: a caller cancelling the take
    // asked for no answer at all.
    if (outcome.timedOut && received) {
      const hits = normalizeEverythingJson({ results: salvageRows(received) }, limit)
      if (hits.length > 0) return { ok: true, hits, total: hits.length, truncated: true, error: outcome.error, code: 'timeout' }
    }
    return fail(outcome.error, code)
  }
  const landed = outcome.value.url
  if (landed) {
    let host = ''
    try { host = new URL(landed).hostname } catch { host = '' }
    if (host && !isLoopbackHost(host)) return fail(`non-loopback response host ${host}`, 'not-everything')
  }
  const payload = parseJson(outcome.value.text)
  // A service answering HTML means "json=1 was ignored" — not Everything.
  if (payload === undefined) return fail('response is not JSON', 'not-everything')
  const hits = normalizeEverythingJson(payload, limit)
  const reported = Number((payload as { totalResults?: unknown } | null)?.totalResults)
  const total = Number.isFinite(reported) && reported > 0 ? reported : hits.length
  return { ok: true, hits, total, truncated: total > hits.length, error: '', code: '' }
}

/** Candidate `es.exe` locations: PATH first, then the two conventional installs. */
export function esCandidates(options: EverythingOptions = {}): string[] {
  const env = options.env ?? process.env
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const list: string[] = []
  if (options.cliPath) list.push(options.cliPath)
  for (const folder of pathValue.split(';')) {
    const clean = folder.trim().replace(/^"|"$/g, '')
    if (clean) list.push(join(clean, 'es.exe'))
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (base) list.push(join(base, 'Everything', 'es.exe'))
  }
  return [...new Set(list)]
}

async function findEs(options: EverythingOptions): Promise<string> {
  if(options.cliPath && (!isAbsolute(options.cliPath)||basename(options.cliPath).toLowerCase()!=='es.exe'))throw new Error('Everything CLI path must be an absolute path to es.exe')
  const probe = options.fileExists ?? existsSync
  for (const candidate of esCandidates(options)) {
    if (await probe(candidate)) return candidate
  }
  return ''
}

async function describePath(path: string, options: EverythingOptions): Promise<EverythingHit> {
  const name = basename(path)
  const statImpl = options.statImpl ?? statFile
  try {
    const info = await statImpl(path)
    return { name, path, size: toSize(info.size), modifiedAt: new Date(info.mtimeMs).toISOString() }
  } catch {
    // es.exe prints a path only; a file deleted since indexing is still a hit.
    return { name, path, size: 0, modifiedAt: '' }
  }
}

/** es.exe prints one path per line; a deadline may leave the last line cut. */
function cliPaths(text: string, complete: boolean): string[] {
  const lines = text.split(/\r?\n/)
  if (!complete) lines.pop()
  return lines.map(line => line.trim()).filter(Boolean)
}

/** Tier 2: the Everything command-line client. */
async function queryCli(query: string, options: EverythingOptions, limit: number): Promise<TierResult> {
  const exe = await findEs(options)
  if (!exe) return { ok: false, hits: [], total: 0, truncated: false, error: 'es.exe not found', code: 'missing' }
  const run = options.spawnImpl ?? spawn
  let output = ''
  const outcome = await bounded(signal => new Promise<string>((resolve, reject) => {
    // Only stable, documented flags: `-n` caps the result count, the query is a
    // separate argv entry so no shell quoting is involved anywhere.
    const child = run(exe, ['-n', String(limit), query], { windowsHide: true, signal })
    let failure = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { if (output.length < 200_000) output += text })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => { failure = (failure + text).slice(0, 500) })
    child.on('error', reject)
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(output)
      else reject(new Error(failure.trim() || `es.exe exit ${code}`))
    })
  }), options.signal, options.cliTimeoutMs ?? EVERYTHING_CLI_TIMEOUT_MS)
  const paths = cliPaths(output, outcome.ok)
  const hits = await Promise.all(paths.slice(0, limit).map(path => describePath(path, options)))
  if (!outcome.ok) {
    // Rows that already printed are real hits: return them instead of throwing
    // away a slow machine's whole answer.
    if (outcome.timedOut && hits.length > 0) {
      return { ok: true, hits, total: hits.length, truncated: true, error: outcome.error, code: 'timeout' }
    }
    return { ok: false, hits: [], total: 0, truncated: false, error: outcome.error, code: outcome.timedOut ? 'timeout' : 'failed' }
  }
  return { ok: true, hits, total: hits.length, truncated: paths.length > hits.length, error: '', code: '' }
}

/**
 * Looks `query` up through the first tier that answers. Never throws: an absent
 * installation is a normal, explainable state, not an error.
 */
export async function searchEverything(query: string, options: EverythingOptions = {}): Promise<EverythingResult> {
  const trimmed = String(query ?? '').trim()
  const limit = clampLimit(options.limit)
  const unavailable = (reason: string): EverythingResult =>
    ({ available: false, backend: 'none', query: trimmed, hits: [], total: 0, truncated: false, reason })
  const answered = (backend: 'http' | 'cli', tier: TierResult): EverythingResult => {
    // A partial answer keeps its own explanation: the card has to say that more
    // rows exist, otherwise a timeout looks like a complete result set.
    const partial = tier.code === 'timeout'
    return {
      available: true,
      backend,
      query: trimmed,
      hits: tier.hits,
      total: tier.total,
      truncated: tier.truncated || partial,
      reason: partial ? mt('超时前只拿到 {{count}} 条结果，可能还有更多', { count: tier.hits.length }) : '',
      ...(partial ? { failure: 'timeout' as const } : {})
    }
  }
  if (!trimmed) return unavailable(mt('缺少要搜索的文件名关键词'))

  const port = everythingPort(options.port)
  const reasons: string[] = []
  if (options.http === false) {
    reasons.push(mt('已按设置关闭 Everything 的 HTTP 服务'))
  } else {
    const http = await queryHttp(trimmed, options, limit)
    if (http.ok) return answered('http', http)
    reasons.push(http.code === 'not-everything'
      // A JSON/HTML mismatch means the port is busy with some other service; the
      // old "端口未响应" here is what sent users hunting for a firewall rule.
      ? mt('{{port}} 端口有服务在应答，但返回的不是 Everything 的 JSON（{{message}}）', { port, message: http.error })
      : mt('{{port}} 端口没有响应（{{message}}）', { port, message: http.error }))
    // A caller cancelling the take must not be re-interpreted as "try es.exe".
    options.signal?.throwIfAborted()
  }

  const cli = await queryCli(trimmed, options, limit)
  if (cli.ok) return answered('cli', cli)
  reasons.push(cli.code === 'missing'
    ? mt('没有找到 es.exe（{{message}}）', { message: cli.error })
    : mt('es.exe 运行失败（{{message}}）', { message: cli.error }))
  return unavailable(mt('无法连接 Everything 查询接口（{{detail}}）', { detail: reasons.join('；') }))
}
