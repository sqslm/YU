/**
 * Long-term memory on disk.
 *
 * A JSON file, not the SQLite the reminders use: the whole point of memory is
 * that the person can open the file, read it and fix a sentence the assistant
 * misheard. A few hundred rows never needed an index, and an atomic rewrite
 * costs nothing at that size.
 *
 * Two rules shape the rest of this file. The file is the only copy of something
 * the user deliberately taught the app, so every write is atomic and a damaged
 * file is moved aside instead of overwritten. And memory must never stop the app
 * from starting, so a bad file degrades to an empty list rather than an
 * exception.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mt } from '@shared/mainI18n'
import {
  MAX_MEMORIES,
  MAX_MEMORY_TEXT,
  isMemoryKind,
  normalizeMemoryKind,
  normalizeMemoryTags,
  normalizeMemoryText,
  searchMemories
} from '@shared/memory'
import type { MemoryEntry, MemoryInput, MemoryKind } from '@shared/memory'

const SOURCES: readonly MemoryEntry['source'][] = ['voice', 'manual', 'note']

/** What lands on disk: a versioned envelope so a future shape can migrate. */
const FILE_VERSION = 1

/** Case and spacing are noise when deciding "has this been said already?". */
const dedupeKey = (text: string): string => normalizeMemoryText(text).toLowerCase()

const clone = (row: MemoryEntry): MemoryEntry => ({ ...row, tags: [...row.tags] })

const isTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Reads one stored row, or null when it cannot be trusted.
 *
 * Text and tags are re-normalised so a hand-edited file behaves like a saved
 * one, but the text is never truncated on load: cutting a sentence silently
 * would destroy exactly what the user wrote.
 */
function parseEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<MemoryEntry>
  const text = normalizeMemoryText(row.text)
  if (typeof row.id !== 'string' || !row.id) return null
  if (!isMemoryKind(row.kind) || !text) return null
  if (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string')) return null
  if (!SOURCES.includes(row.source as MemoryEntry['source'])) return null
  if (!isTimestamp(row.createdAt) || !isTimestamp(row.updatedAt)) return null
  if (row.archivedAt !== undefined && !isTimestamp(row.archivedAt)) return null
  if (row.lastUsedAt !== undefined && !isTimestamp(row.lastUsedAt)) return null
  return {
    id: row.id,
    kind: row.kind,
    text,
    tags: normalizeMemoryTags(row.tags),
    source: row.source as MemoryEntry['source'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.archivedAt === undefined ? {} : { archivedAt: row.archivedAt }),
    // A missing counter is not a reason to drop a real memory.
    hits: isTimestamp(row.hits) && row.hits >= 0 ? Math.floor(row.hits) : 0,
    ...(row.lastUsedAt === undefined ? {} : { lastUsedAt: row.lastUsedAt })
  }
}

export class MemoryStore {
  private readonly path: string
  private readonly now: () => number
  private entries: MemoryEntry[] = []
  /** Where the last unreadable file was moved, so the UI can say so. */
  private damaged: string | null = null

  constructor(file: string, now: () => number = Date.now) {
    this.path = file
    this.now = now
    this.entries = this.load()
  }

  get file(): string {
    return this.path
  }

  /** Absolute path of the preserved damaged file, when the load found one. */
  damagedPath(): string | null {
    return this.damaged
  }

  /** Live entries first, archived last, each group newest edit first. */
  list(): MemoryEntry[] {
    return this.ordered().map(clone)
  }

  active(): MemoryEntry[] {
    return this.ordered().filter(row => row.archivedAt === undefined).map(clone)
  }

  get(id: string): MemoryEntry | undefined {
    const row = this.entries.find(entry => entry.id === id)
    return row ? clone(row) : undefined
  }

  /**
   * Creates or edits one memory.
   *
   * Saving text that already exists updates that row instead of adding a
   * duplicate: a person repeating themselves to the assistant means "yes, that
   * one", and two near-identical lines would eat the prompt budget twice.
   */
  save(input: MemoryInput, id?: string): MemoryEntry {
    const stamp = this.now()
    const existing = id === undefined ? undefined : this.entries.find(entry => entry.id === id)
    if (id !== undefined && !existing) throw new Error(mt('记忆不存在'))
    const text = normalizeMemoryText(input?.text)
    if (!text) throw new Error(mt('请提供要记住的内容'))
    if (text.length > MAX_MEMORY_TEXT) throw new Error(mt('这条记忆太长，请精简到 {{count}} 字以内', { count: MAX_MEMORY_TEXT }))
    const kind = normalizeMemoryKind(input?.kind, existing?.kind ?? 'fact')
    const tags = input?.tags === undefined ? existing?.tags ?? [] : normalizeMemoryTags(input.tags)
    const source = SOURCES.includes(input?.source as MemoryEntry['source'])
      ? input.source as MemoryEntry['source']
      : existing?.source ?? 'manual'
    if (existing) {
      const updated: MemoryEntry = { ...existing, kind, text, tags, updatedAt: stamp }
      this.entries = this.entries.map(row => (row.id === existing.id ? updated : row))
      this.persist()
      return clone(updated)
    }
    // An explicit id is a targeted edit, so it bypasses duplicate folding.
    const duplicate = this.entries.find(row => row.archivedAt === undefined && dedupeKey(row.text) === dedupeKey(text))
    if (duplicate) {
      const merged: MemoryEntry = {
        ...duplicate,
        kind,
        tags: normalizeMemoryTags([...duplicate.tags, ...tags]),
        updatedAt: stamp
      }
      this.entries = this.entries.map(row => (row.id === duplicate.id ? merged : row))
      this.persist()
      return clone(merged)
    }
    if (this.active().length >= MAX_MEMORIES) {
      throw new Error(mt('记忆数量已达上限（{{count}} 条），请先归档不再需要的条目', { count: MAX_MEMORIES }))
    }
    const created: MemoryEntry = { id: randomUUID(), kind, text, tags, source, createdAt: stamp, updatedAt: stamp, hits: 0 }
    this.entries = [...this.entries, created]
    this.persist()
    return clone(created)
  }

  /** Soft delete. Repeating it is a no-op so a double click cannot lose data. */
  archive(id: string): MemoryEntry {
    const row = this.entries.find(entry => entry.id === id)
    if (!row) throw new Error(mt('记忆不存在'))
    if (row.archivedAt !== undefined) return clone(row)
    const stamp = this.now()
    const archived: MemoryEntry = { ...row, archivedAt: stamp, updatedAt: stamp }
    this.entries = this.entries.map(entry => (entry.id === id ? archived : entry))
    this.persist()
    return clone(archived)
  }

  restore(id: string): MemoryEntry {
    const row = this.entries.find(entry => entry.id === id)
    if (!row) throw new Error(mt('记忆不存在'))
    if (row.archivedAt === undefined) return clone(row)
    // Restoring must not push the active list past the ceiling the save path enforces.
    if (this.active().length >= MAX_MEMORIES) {
      throw new Error(mt('记忆数量已达上限（{{count}} 条），请先归档不再需要的条目', { count: MAX_MEMORIES }))
    }
    const lifted: MemoryEntry = { ...row, updatedAt: this.now() }
    delete lifted.archivedAt
    this.entries = this.entries.map(entry => (entry.id === id ? lifted : entry))
    this.persist()
    return clone(lifted)
  }

  /**
   * Records that memories were actually injected into a request. `updatedAt` is
   * deliberately untouched: usage must not reshuffle the list a person is
   * reading or change the order the prompt is built from.
   */
  touch(ids: readonly string[]): void {
    const wanted = new Set(ids)
    if (!wanted.size) return
    const stamp = this.now()
    let changed = false
    this.entries = this.entries.map(row => {
      if (!wanted.has(row.id) || row.archivedAt !== undefined) return row
      changed = true
      return { ...row, hits: row.hits + 1, lastUsedAt: stamp }
    })
    if (changed) this.persist()
  }

  /** Archived rows stay out of search: a deleted memory must not resurface. */
  search(query: string, kind?: MemoryKind): MemoryEntry[] {
    return searchMemories(this.entries, query, kind).map(clone)
  }

  /** Writes happen synchronously, so there is nothing pending to flush. */
  flush(): void {}

  private ordered(): MemoryEntry[] {
    const newestFirst = (a: MemoryEntry, b: MemoryEntry): number =>
      b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
    const active = this.entries.filter(row => row.archivedAt === undefined).sort(newestFirst)
    const archived = this.entries.filter(row => row.archivedAt !== undefined).sort(newestFirst)
    return [...active, ...archived]
  }

  private load(): MemoryEntry[] {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      // ENOENT is simply "no memories yet". A locked or unreadable file is not
      // corruption either: nothing is moved aside, the session starts empty.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[memory] cannot read the file, starting empty:', err)
      }
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const envelope = (parsed ?? {}) as { version?: unknown; entries?: unknown }
      // A foreign version is not readable by this build, so it is preserved like
      // corruption instead of crashing on a shape it does not know.
      if (envelope.version !== FILE_VERSION || !Array.isArray(envelope.entries)) throw new Error('unexpected memory file layout')
      const rows = envelope.entries.map(parseEntry)
      if (rows.some(row => row === null)) throw new Error('unusable memory entry')
      return rows as MemoryEntry[]
    } catch (err) {
      console.error('[memory] unusable file, keeping a copy and starting empty:', err)
      this.quarantine()
      return []
    }
  }

  /** Moves an unreadable file aside; it is the only copy, so it is never deleted. */
  private quarantine(): void {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const base = this.path.replace(/\.json$/i, '')
    let target = `${base}.broken-${stamp}.json`
    // Two boots in the same second must not overwrite each other's evidence.
    for (let n = 2; existsSync(target); n++) target = `${base}.broken-${stamp}-${n}.json`
    try {
      renameSync(this.path, target)
      this.damaged = target
      console.error(`[memory] damaged file kept at ${target}`)
    } catch (err) {
      console.error('[memory] cannot keep the damaged file:', err)
    }
  }

  /**
   * The file mirrors the list order so it reads like the panel: a person opening
   * it should see their newest memories first, not random insertion order.
   */
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = `${JSON.stringify({ version: FILE_VERSION, entries: this.ordered() }, null, 2)}\n`
    // Same directory + rename: a crash mid-write leaves the previous file whole.
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, this.path)
  }
}
