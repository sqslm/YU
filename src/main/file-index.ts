/**
 * `search_file_contents`: match a keyword inside real document bodies.
 *
 * The question this file answers is "which document actually said this?", so it
 * has to read text — but it must stay a bounded read, not a disk crawler:
 *
 * - **A per-query budget.** Four seconds, N files, one size ceiling, a result
 *   cap. Running out is reported as `truncated` with the reason, never as
 *   "nothing matched", because a half-finished scan is not evidence of absence.
 * - **Document readers.** OOXML uses the bounded ZIP reader; text-based PDF
 *   uses PDF.js in a worker with memory/time limits. Scanned or encrypted
 *   files are reported as unreadable instead of guessed.
 * - **Everything is injected.** Traversal, stat, read and the clock all come from
 *   `deps`, so the tests below run on a virtual tree without touching a profile.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { pdfText } from './pdf-text'

/** Above this a single file is a project archive, not a document to scan. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** Default wall clock for one query; the tool layer adds no ceiling of its own. */
export const DEFAULT_TIMEOUT_MS = 4000
/** Files (not entries) examined per query unless the caller asks for more. */
export const DEFAULT_MAX_FILES = 800
export const MAX_FILES_CAP = 5000
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 50
/** Deep enough for Documents\2026\Q3\report.docx, shallow enough to stay bounded. */
const MAX_DEPTH = 8
const CACHE_CAPACITY = 200
/** One zip member bigger than this is not a document body. */
const MAX_MEMBER_BYTES = 4 * 1024 * 1024
/** Large bodies are still searched, just not retained. */
const CACHE_ENTRY_BYTES = 512 * 1024
const MAX_TOKENS = 6
const SNIPPET_RADIUS = 90

/** Plain text we can match directly. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.ini', '.cfg', '.conf',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.sql', '.sh', '.ps1', '.bat',
  '.rst', '.srt', '.vtt', '.tex', '.toml'
])

/** OOXML package: unzipped and tag-stripped below. */
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])

/**
 * Known-unreadable formats. Counted so the caller can say "3 个 PDF 未读取"
 * instead of silently reporting a smaller corpus than it was asked about.
 */
const UNSUPPORTED_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.rtf', '.odt', '.ods', '.odp', '.zip', '.rar', '.7z'])

/**
 * Directories that never contain the user's own prose and can be enormous.
 * Matched case-insensitively against the folder name only, so a legit
 * `C:\Users\me\Documents\Windows` is still scanned by its own path.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.cache', '__pycache__',
  '.venv', 'venv', '.tox', '.next', '.nuxt', '$recycle.bin', 'system volume information',
  'windows', 'winsxs', 'appdata', 'programdata', 'program files', 'program files (x86)',
  'recovery', 'perflogs'
])

export interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface FileStat {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}

/** Everything the index touches outside its own memory, injectable for tests. */
export interface FileIndexDeps {
  readdir?: (path: string) => Promise<DirEntry[]>
  stat?: (path: string) => Promise<FileStat>
  readFile?: (path: string) => Promise<Uint8Array>
  /** `%USERPROFILE%` equivalent; only used to build the default roots. */
  homeDir?: () => string
  now?: () => number
}

export interface ContentHit {
  path: string
  name: string
  /** ISO 8601 modification instant — the fact "recently changed" is asked about. */
  modifiedAt: string
  size: number
  snippet: string
}

/** Why the scan stopped early. Empty means it covered the whole budget. */
export type TruncationReason = '' | 'timeout' | 'file-limit' | 'result-limit'

export interface ContentSearchResult {
  query: string
  roots: string[]
  hits: ContentHit[]
  /** Candidate files actually opened or rejected on inspection. */
  scanned: number
  truncated: boolean
  reason: TruncationReason
  elapsedMs: number
  skipped: { binary: number; tooLarge: number; unsupported: number; unreadable: number }
  cache: { hits: number; misses: number }
}

export interface ContentSearchOptions {
  pathAllowed?: (path:string)=>Promise<boolean>
  query: string
  /** Absolute folders. Defaults to Documents/Desktop/Downloads under the profile. */
  roots?: string[]
  limit?: number
  maxFiles?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** Ignore the parse cache for this query (still fills it). */
  refresh?: boolean
}

const realDeps = (): Required<FileIndexDeps> => ({
  readdir: async path => (await readdir(path, { withFileTypes: true })).map(entry => ({
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink()
  })),
  stat: async path => {
    const info = await stat(path)
    return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs }
  },
  readFile: path => readFile(path),
  // Windows sets USERPROFILE; HOME keeps the fallback honest on a POSIX runner.
  homeDir: () => process.env.USERPROFILE || process.env.HOME || '',
  now: () => Date.now()
})

/** Documents/Desktop/Downloads under a profile. Exported so the default is testable. */
export function defaultRoots(home: string): string[] {
  const base = String(home ?? '').trim()
  return base ? ['Documents', 'Desktop', 'Downloads'].map(name => join(base, name)) : []
}

/**
 * Escapes a literal fragment for `new RegExp`. A user saying "报告(终稿)" means
 * those characters, not a capture group — and a stray `*` or `(` would either
 * throw or match something else entirely.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One case-insensitive literal per whitespace-separated token; all must match. */
export function compileTokens(query: string): RegExp[] {
  return String(query ?? '')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map(token => new RegExp(escapeRegExp(token), 'i'))
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), max)
}

function isInside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && !part.startsWith('..') && !isAbsolute(part)
}

/** NUL in the head is the cheapest reliable binary signal (UTF-16 is BOM-gated). */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192)
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true
  return false
}

/**
 * Decodes a plain text file, or `null` when it is binary.
 *
 * BOM order matters: a UTF-16LE document is full of NUL bytes by construction, so
 * the BOM has to be honoured before the binary sniff or every such file is lost.
 */
export function decodePlainText(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes
  if (looksBinary(body)) return null
  return new TextDecoder('utf-8').decode(body)
}

// ---------------------------------------------------------------------------
// Minimal zip reader (central directory + one deflate member)
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  /** Offset of the local file header; the central directory is authoritative. */
  offset: number
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Reads the central directory.
 *
 * ZIP64 (sizes or offsets saturated to 0xffffffff) is deliberately unsupported: an
 * OOXML part is never 4 GB, so the honest answer for such an archive is "cannot
 * read it" rather than a wrong offset into the middle of the file.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = viewOf(bytes)
  let eocd = -1
  // The end record sits at the tail; the comment field is at most 64 KiB.
  const stop = Math.max(0, bytes.length - 22 - 0xffff)
  for (let at = bytes.length - 22; at >= stop; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) { eocd = at; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  const decoder = new TextDecoder('utf-8')
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    if (cursor + 46 + nameLength > bytes.length) break
    entries.push({
      name: decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      offset: view.getUint32(cursor + 42, true)
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflates one member, or `null` when it is unsupported, oversized or corrupt. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize > MAX_MEMBER_BYTES) return null
  const view = viewOf(bytes)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL_SIGNATURE) return null
  // The local header repeats the name/extra lengths and they may differ from the
  // central directory's; the local values are what actually precede the data.
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const end = start + entry.compressedSize
  if (end > bytes.length || end < start) return null
  const raw = bytes.subarray(start, end)
  if (entry.method === METHOD_STORED) return raw
  if (entry.method !== METHOD_DEFLATE) return null
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_MEMBER_BYTES })
  } catch {
    // A zip bomb that lies about its size is caught here rather than by OOM.
    return null
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all
      try { return String.fromCodePoint(code) } catch { return all }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all
  })
}

/**
 * XML → readable text.
 *
 * Block boundaries become whitespace *before* tags are stripped: without that,
 * two adjacent Word paragraphs or Excel cells fuse into one phantom keyword that
 * no human ever wrote.
 */
export function stripXmlText(xml: string): string {
  return decodeEntities(String(xml ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(?:w:p|a:p|si|row)>/gi, '\n')
    .replace(/<\/c>/gi, '\t')
    .replace(/<w:tab\/>/gi, '\t')
    .replace(/<[^>]*>/g, ''))
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

const slideNumber = (name: string): number => Number.parseInt(/slide(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10)
const sheetNumber = (name: string): number => Number.parseInt(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10)

function officeParts(extension: string, entries: ZipEntry[]): ZipEntry[] {
  if (extension === '.docx') {
    // word/document.xml is the body; footnotes/endnotes hold text a user may quote.
    const wanted = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']
    return wanted.flatMap(name => entries.filter(entry => entry.name === name))
  }
  if (extension === '.pptx') {
    return entries.filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
      .sort((left, right) => slideNumber(left.name) - slideNumber(right.name))
  }
  // Excel splits shared strings from cells: both are needed, shared strings first
  // so a snippet that hits a label is anchored to the label's own text run.
  const shared = entries.filter(entry => entry.name === 'xl/sharedStrings.xml')
  const sheets = entries.filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((left, right) => sheetNumber(left.name) - sheetNumber(right.name))
  return [...shared, ...sheets]
}

/** Text of one OOXML document, or `null` when the container is unreadable. */
export function officeText(bytes: Uint8Array, extension: string): string | null {
  const ext = extension.toLowerCase()
  let entries: ZipEntry[]
  try { entries = listZipEntries(bytes) } catch { return null }
  const decoder = new TextDecoder('utf-8')
  let text = ''
  for (const entry of officeParts(ext, entries)) {
    if (text.length >= MAX_MEMBER_BYTES) break
    const raw = readZipEntry(bytes, entry)
    if (!raw) continue
    text += `${stripXmlText(decoder.decode(raw))}\n`
  }
  return text.trim() ? text : null
}

/** Body text of a supported file, or `null` for binary/unreadable content. */
export function documentText(bytes: Uint8Array, extension: string): string | null {
  const ext = String(extension ?? '').toLowerCase()
  return OFFICE_EXTENSIONS.has(ext) ? officeText(bytes, ext) : decodePlainText(bytes)
}

/** One-line excerpt around the first match, collapsed for a card or a prompt. */
export function snippetAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - SNIPPET_RADIUS)
  const to = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`
}

interface CachedText { mtimeMs: number; size: number; text: string }

/**
 * Content index with an mtime/size-validated parse cache.
 *
 * Parsing a deck costs a zip walk plus XML stripping; the same deck is asked
 * about repeatedly in one session ("find that slide about pricing"). The key is
 * the path and the value carries the mtime+size it was parsed at, so an edited
 * file is re-read instead of answering from a stale body.
 */
export class FileIndex {
  private readonly cache = new Map<string, CachedText>()
  private readonly deps: Required<FileIndexDeps>

  constructor(deps: FileIndexDeps = {}) {
    this.deps = { ...realDeps(), ...deps }
  }

  /** Number of parsed bodies currently retained; used by tests and diagnostics. */
  get size(): number { return this.cache.size }

  clear(): void { this.cache.clear() }

  async search(options: ContentSearchOptions): Promise<ContentSearchResult> {
    const started = this.deps.now()
    const query = String(options.query ?? '').trim()
    const tokens = compileTokens(query)
    const limit = clampInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT)
    const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, MAX_FILES_CAP)
    const deadline = started + Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const roots = this.resolveRoots(options.roots)
    const skipped = { binary: 0, tooLarge: 0, unsupported: 0, unreadable: 0 }
    const cache = { hits: 0, misses: 0 }
    const hits: ContentHit[] = []
    let scanned = 0
    let reason: TruncationReason = ''
    const done = (): ContentSearchResult => ({
      query, roots, hits, scanned, truncated: reason !== '', reason,
      elapsedMs: Math.max(0, this.deps.now() - started), skipped, cache
    })
    if (!tokens.length || !roots.length) return done()

    const queue: { path: string; depth: number }[] = roots.map(path => ({ path, depth: 0 }))
    while (queue.length) {
      if (this.deps.now() > deadline) { reason = 'timeout'; break }
      if (hits.length >= limit) { reason = 'result-limit'; break }
      if (scanned >= maxFiles) { reason = 'file-limit'; break }
      options.signal?.throwIfAborted()
      const folder = queue.shift()!
      if(options.pathAllowed && !await options.pathAllowed(folder.path))continue
      let entries: DirEntry[]
      try { entries = await this.deps.readdir(folder.path) } catch { continue }
      // Name order keeps a bounded scan reproducible; otherwise "the first N
      // files" would depend on NTFS directory order.
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (this.deps.now() > deadline) { reason = 'timeout'; break }
        if (hits.length >= limit) { reason = 'result-limit'; break }
        if (scanned >= maxFiles) { reason = 'file-limit'; break }
        // Junctions and symlinks can point outside the authorized root; the
        // Windows search tool refuses them for the same reason.
        if (entry.isSymbolicLink) continue
        if (entry.isDirectory) {
          if (folder.depth >= MAX_DEPTH || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
          queue.push({ path: join(folder.path, entry.name), depth: folder.depth + 1 })
          continue
        }
        if (!entry.isFile) continue
        if(options.pathAllowed && !await options.pathAllowed(join(folder.path,entry.name)))continue
        const extension = extname(entry.name).toLowerCase()
        if (UNSUPPORTED_EXTENSIONS.has(extension)) { skipped.unsupported++; continue }
        if (!TEXT_EXTENSIONS.has(extension) && !OFFICE_EXTENSIONS.has(extension) && extension !== '.pdf') { skipped.unsupported++; continue }
        scanned++
        const hit = await this.inspect(join(folder.path, entry.name), extension, tokens, options.refresh === true, skipped, cache, deadline-this.deps.now(), options.signal)
        if (hit) hits.push(hit)
      }
    }
    // Newest first: "recently changed" is the other half of the question.
    hits.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
    return done()
  }

  /** One file: cap, cache, decode, match. `null` means "no match or skipped". */
  private async inspect(
    path: string,
    extension: string,
    tokens: RegExp[],
    refresh: boolean,
    skipped: ContentSearchResult['skipped'],
    cache: ContentSearchResult['cache'], timeoutMs:number, signal?:AbortSignal
  ): Promise<ContentHit | null> {
    let info: FileStat
    try { info = await this.deps.stat(path) } catch { skipped.unreadable++; return null }
    if (!info.isFile || info.size <= 0) return null
    if (info.size > MAX_FILE_BYTES) { skipped.tooLarge++; return null }

    const key = path.toLowerCase()
    const cached = refresh ? undefined : this.cache.get(key)
    let text: string
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      cache.hits++
      // Re-insert to keep the Map ordered by recency of use.
      this.cache.delete(key)
      this.cache.set(key, cached)
      text = cached.text
    } else {
      cache.misses++
      let bytes: Uint8Array
      try { bytes = await this.deps.readFile(path) } catch { skipped.unreadable++; return null }
      let decoded:string|null
      try { decoded = extension === '.pdf' ? await pdfText(bytes,timeoutMs,signal) : documentText(bytes, extension) }
      catch { signal?.throwIfAborted();skipped.unreadable++;return null }
      if (decoded === null) { skipped.binary++; return null }
      text = decoded
      if (text.length <= CACHE_ENTRY_BYTES) this.store(key, { mtimeMs: info.mtimeMs, size: info.size, text })
    }

    let index = -1
    let length = 0
    for (const token of tokens) {
      const match = token.exec(text)
      if (!match) return null
      if (index < 0 || match.index < index) { index = match.index; length = match[0].length }
    }
    if (index < 0) return null
    return {
      path,
      name: basename(path),
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      size: info.size,
      snippet: snippetAround(text, index, length)
    }
  }

  private store(key: string, value: CachedText): void {
    this.cache.delete(key)
    this.cache.set(key, value)
    while (this.cache.size > CACHE_CAPACITY) this.cache.delete(this.cache.keys().next().value!)
  }

  /**
   * Cleans the root list: drops duplicates, and drops a root that already sits
   * inside another one — otherwise the nested folder is walked twice and spends
   * the file budget on files that were already examined.
   */
  private resolveRoots(roots?: string[]): string[] {
    const requested = (roots && roots.length ? roots : defaultRoots(this.deps.homeDir()))
      .map(root => String(root ?? '').trim())
      .filter(Boolean)
    const unique = new Map<string, string>()
    for (const root of requested) {
      const normalized = root.replace(/[\\/]+$/, '')
      if (normalized && !unique.has(normalized.toLowerCase())) unique.set(normalized.toLowerCase(), normalized)
    }
    const list = [...unique.values()]
    return list.filter(root => !list.some(other => other !== root && isInside(other, root)))
  }
}

/** Convenience wrapper for one-shot callers; keeps a process-wide cache. */
const shared = new FileIndex()
export const searchFileContents = (options: ContentSearchOptions): Promise<ContentSearchResult> => shared.search(options)
