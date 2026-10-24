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
import { basename, join } from 'node:path'
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

type Bounded<T> = { ok: true; value: T } | { ok: false; error: string }

/** Races `work` against a deadline; the loser is aborted, never awaited forever. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const controller = new AbortController()
  const forward = (): void => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) forward()
    else parent.addEventListener('abort', forward, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<{ ok: false; error: string }>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new Error('timeout'))
      resolve({ ok: false, error: mt('{{ms}} 毫秒内没有响应', { ms: timeoutMs }) })
    }, Math.max(1, timeoutMs))
    // A pending deadline must not keep the process alive on its own.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  const task = work(controller.signal).then(
    (value): Bounded<T> => ({ ok: true, value }),
    (error): Bounded<T> => ({ ok: false, error: messageOf(error) })
  )
  try {
    return await Promise.race([task, expired])
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener('abort', forward)
  }
}

interface TierResult {
  ok: boolean
  hits: EverythingHit[]
  total: number
  truncated: boolean
  error: string
}

/** Tier 1: the HTTP service. */
async function queryHttp(query: string, options: EverythingOptions, limit: number): Promise<TierResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, hits: [], total: 0, truncated: false, error: 'no fetch' }
  const url = everythingUrl(query, options.port, limit)
  const outcome = await bounded(async signal => {
    // `redirect: 'error'` keeps a hypothetical bounce off-loopback impossible.
    const response = await doFetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { text: await response.text(), url: response.url }
  }, options.signal, options.timeoutMs ?? EVERYTHING_TIMEOUT_MS)
  if (!outcome.ok) return { ok: false, hits: [], total: 0, truncated: false, error: outcome.error }
  const landed = outcome.value.url
  if (landed) {
    let host = ''
    try { host = new URL(landed).hostname } catch { host = '' }
    if (host && !isLoopbackHost(host)) return { ok: false, hits: [], total: 0, truncated: false, error: `non-loopback response host ${host}` }
  }
  let payload: unknown
  try { payload = JSON.parse(outcome.value.text) as unknown } catch {
    // A service answering HTML means "json=1 was ignored" — treat as absent.
    return { ok: false, hits: [], total: 0, truncated: false, error: 'response is not JSON' }
  }
  const hits = normalizeEverythingJson(payload, limit)
  const reported = Number((payload as { totalResults?: unknown } | null)?.totalResults)
  const total = Number.isFinite(reported) && reported > 0 ? reported : hits.length
  return { ok: true, hits, total, truncated: total > hits.length, error: '' }
}

/** Candidate `es.exe` locations: PATH first, then the two conventional installs. */
export function esCandidates(options: EverythingOptions = {}): string[] {
  const env = options.env ?? process.env
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const list: string[] = []
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

/** Tier 2: the Everything command-line client. */
async function queryCli(query: string, options: EverythingOptions, limit: number): Promise<TierResult> {
  const exe = await findEs(options)
  if (!exe) return { ok: false, hits: [], total: 0, truncated: false, error: 'es.exe not found' }
  const run = options.spawnImpl ?? spawn
  const outcome = await bounded(signal => new Promise<string>((resolve, reject) => {
    // Only stable, documented flags: `-n` caps the result count, the query is a
    // separate argv entry so no shell quoting is involved anywhere.
    const child = run(exe, ['-n', String(limit), query], { windowsHide: true, signal })
    let output = ''
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
  if (!outcome.ok) return { ok: false, hits: [], total: 0, truncated: false, error: outcome.error }
  const paths = outcome.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const hits: EverythingHit[] = []
  for (const path of paths.slice(0, limit)) hits.push(await describePath(path, options))
  return { ok: true, hits, total: hits.length, truncated: paths.length > hits.length, error: '' }
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
  if (!trimmed) return unavailable(mt('缺少要搜索的文件名关键词'))

  const reasons: string[] = []
  if (options.http === false) {
    reasons.push(mt('已按设置关闭 Everything 的 HTTP 服务'))
  } else {
    const http = await queryHttp(trimmed, options, limit)
    if (http.ok) {
      return { available: true, backend: 'http', query: trimmed, hits: http.hits, total: http.total, truncated: http.truncated, reason: '' }
    }
    reasons.push(mt('HTTP 服务 {{port}} 端口未响应（{{message}}）', { port: everythingPort(options.port), message: http.error }))
    // A caller cancelling the take must not be re-interpreted as "try es.exe".
    options.signal?.throwIfAborted()
  }

  const cli = await queryCli(trimmed, options, limit)
  if (cli.ok) {
    return { available: true, backend: 'cli', query: trimmed, hits: cli.hits, total: cli.total, truncated: cli.truncated, reason: '' }
  }
  reasons.push(mt('也没有找到 es.exe（{{message}}）', { message: cli.error }))
  return unavailable(mt('这台机器没有 Everything（{{detail}}），已改用内置文件搜索', { detail: reasons.join('；') }))
}
