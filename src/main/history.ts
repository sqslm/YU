import { app } from 'electron'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HistoryEntry, HistoryStatus } from '@shared/types'
import { mt } from '@shared/mainI18n'

/**
 * Row cap sanitiser. `0` and negative values used to reach `prune()` as-is,
 * where `entries.slice(0, -1)` silently dropped the newest row (and its wav) on
 * *every* load — a slow, invisible way to lose the whole history.
 */
function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 500
  return Math.min(100_000, Math.max(1, Math.round(value)))
}

/**
 * How long a delete is remembered. A machine that has been offline for longer
 * than this will resurrect the rows it still has — the alternative is a tombstone
 * per delete forever, and ninety days is far past any realistic gap.
 */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

// Archived successful results are still normal history. Legacy failures stay
// local until the user chooses cleanup, and must not be uploaded again.
const NORMAL_HISTORY_SQL = `status IN ('completed', 'archived')
  AND trim(final, char(9) || char(10) || char(13) || ' ') <> ''
  AND coalesce(json_extract(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, '$.archivedStatus'), 'completed') = 'completed'
  AND coalesce(trim(json_extract(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, '$.error')), '') = ''`

/**
 * Columns that exist as real SQL columns because something queries, sorts or
 * filters on them. Everything else rides in the `extra` JSON column.
 *
 * The reference client stores history in SQLite for the same reason: a sync
 * engine cannot diff a whole-file rewrite, and "select the newest 200 rows"
 * should not parse thirty thousand objects.
 */
const CORE_COLUMNS = [
  'id',
  'createdAt',
  'updatedAt',
  'mode',
  'status',
  'app',
  'transcript',
  'final',
  'durationMs',
  'wordCount',
  'audioPath'
] as const

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  app TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  final TEXT NOT NULL DEFAULT '',
  durationMs INTEGER NOT NULL DEFAULT 0,
  wordCount INTEGER,
  audioPath TEXT,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS history_created_at ON history (createdAt DESC);
CREATE INDEX IF NOT EXISTS history_status ON history (status);
CREATE INDEX IF NOT EXISTS history_app ON history (app);
CREATE INDEX IF NOT EXISTS history_updated_at ON history (updatedAt);
CREATE TABLE IF NOT EXISTS history_deleted (
  id TEXT PRIMARY KEY,
  deletedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_deleted_at ON history_deleted (deletedAt);
`

/** Everything the pipeline may supply when it records a take. */
export type HistoryAddInput = Pick<
  HistoryEntry,
  | 'mode'
  | 'transcript'
  | 'final'
  | 'durationMs'
  | 'status'
  | 'alertKind'
  | 'attempts'
  | 'audioPath'
  | 'wordCount'
  | 'appPath'
  | 'focusedWindowTitle'
  | 'editedText'
  | 'editedStatus'
  | 'hasRevertedAI'
  | 'inputAreaType'
  | 'lang'
  | 'promptKind'
  | 'promptId'
  | 'promptName'
  | 'providerId'
  | 'providerName'
> & {
  app?: string
  error?: string
  sources?: HistoryEntry['sources']
  route?: HistoryEntry['route']
}

/** `%` and `_` are LIKE wildcards; a user searching for "50%" means the two chars. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** Drops `undefined` (and empty arrays) so the JSON column stays honest. */
function tidy<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (Array.isArray(item) && item.length === 0) continue
    out[key] = item
  }
  return out as T
}

type Row = Record<string, unknown>

function rowToEntry(row: Row): HistoryEntry {
  let extra: Record<string, unknown> = {}
  if (typeof row.extra === 'string' && row.extra.length > 0) {
    try {
      extra = JSON.parse(row.extra) as Record<string, unknown>
    } catch {
      // A hand-edited row must not poison the whole list.
      extra = {}
    }
  }
  const entry: HistoryEntry = {
    ...(extra as Partial<HistoryEntry>),
    id: String(row.id),
    createdAt: Number(row.createdAt),
    mode: String(row.mode) as HistoryEntry['mode'],
    status: String(row.status ?? 'completed') as HistoryStatus,
    app: String(row.app ?? ''),
    transcript: String(row.transcript ?? ''),
    final: String(row.final ?? ''),
    durationMs: Number(row.durationMs ?? 0)
  }
  // Rows written before sync existed have no `updatedAt`; the migration backfills
  // it from `createdAt`, so a 0 here means a row that was never touched since.
  const updatedAt = Number(row.updatedAt ?? 0)
  if (updatedAt > 0) entry.updatedAt = updatedAt
  if (row.wordCount !== null && row.wordCount !== undefined) entry.wordCount = Number(row.wordCount)
  if (typeof row.audioPath === 'string') entry.audioPath = row.audioPath
  return entry
}

function entryToRow(entry: HistoryEntry): Row {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue
    if ((CORE_COLUMNS as readonly string[]).includes(key)) continue
    extra[key] = value
  }
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt ?? entry.createdAt,
    mode: entry.mode,
    status: entry.status ?? 'completed',
    app: entry.app ?? '',
    transcript: entry.transcript ?? '',
    final: entry.final ?? '',
    durationMs: entry.durationMs ?? 0,
    wordCount: entry.wordCount ?? null,
    audioPath: entry.audioPath ?? null,
    extra: JSON.stringify(extra)
  }
}

/**
 * Fields that travel between machines.
 *
 * Deliberately not "the whole row": `audioPath` points at a wav that exists only
 * on this disk (syncing a megabyte per take is a different feature), and every
 * key in `extra` is client-local metadata that the other machine has no use for.
 * An allowlist also means a malicious server cannot smuggle unknown keys into a
 * row and have them believed next launch.
 */
const SYNC_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'mode',
  'status',
  'app',
  'transcript',
  'final',
  'durationMs',
  'wordCount',
  'error',
  'route',
  'sources',
  'alertKind',
  'attempts',
  'appPath',
  'focusedWindowTitle',
  'inputAreaType',
  'lang',
  'promptKind',
  'promptId',
  'promptName',
  'providerId',
  'providerName',
  'editedText',
  'editedStatus',
  'hasRevertedAI'
] as const

/** One row as the wire carries it: allowlisted keys, nothing `undefined`. */
export type SyncRow = Record<string, unknown>

export function toSyncRow(entry: HistoryEntry): SyncRow {
  const out: SyncRow = {}
  for (const key of SYNC_FIELDS) {
    const value = (entry as unknown as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** The inverse, with types checked: a bad row from the wire is skipped, not trusted. */
export function fromSyncRow(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id.length === 0) return null
  const createdAt = Number(item.createdAt)
  if (!Number.isFinite(createdAt)) return null
  const mode = typeof item.mode === 'string' ? item.mode : 'dictation'
  const entry: HistoryEntry = {
    id: item.id,
    createdAt,
    mode: mode as HistoryEntry['mode'],
    transcript: typeof item.transcript === 'string' ? item.transcript : '',
    final: typeof item.final === 'string' ? item.final : '',
    durationMs: Number(item.durationMs) || 0,
    app: typeof item.app === 'string' ? item.app : ''
  }
  if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) {
    entry.updatedAt = item.updatedAt
  }
  if (typeof item.status === 'string') entry.status = item.status as HistoryStatus
  if (typeof item.wordCount === 'number') entry.wordCount = item.wordCount
  if (typeof item.error === 'string') entry.error = item.error
  if (typeof item.alertKind === 'string') entry.alertKind = item.alertKind
  if (typeof item.attempts === 'number') entry.attempts = item.attempts
  if (typeof item.appPath === 'string') entry.appPath = item.appPath
  if (typeof item.focusedWindowTitle === 'string') entry.focusedWindowTitle = item.focusedWindowTitle
  if (typeof item.inputAreaType === 'string') {
    entry.inputAreaType = item.inputAreaType as HistoryEntry['inputAreaType']
  }
  if (typeof item.lang === 'string') entry.lang = item.lang
  if (typeof item.promptKind === 'string') entry.promptKind = item.promptKind as HistoryEntry['promptKind']
  if (typeof item.promptId === 'string') entry.promptId = item.promptId
  if (typeof item.promptName === 'string') entry.promptName = item.promptName
  if (typeof item.providerId === 'string') entry.providerId = item.providerId
  if (typeof item.providerName === 'string') entry.providerName = item.providerName
  if (typeof item.editedText === 'string') entry.editedText = item.editedText
  if (typeof item.editedStatus === 'string') {
    entry.editedStatus = item.editedStatus as HistoryEntry['editedStatus']
  }
  if (typeof item.hasRevertedAI === 'boolean') entry.hasRevertedAI = item.hasRevertedAI
  if (typeof item.route === 'string') entry.route = item.route as HistoryEntry['route']
  if (Array.isArray(item.sources)) entry.sources = item.sources as HistoryEntry['sources']
  if ((entry.status && entry.status !== 'completed' && entry.status !== 'archived') || entry.error?.trim() || !entry.final.trim()) return null
  return entry
}

/**
 * Local transcription history, stored in SQLite (`node:sqlite`).
 *
 * The store used to be a JSON array rewritten in full on every mutation. That
 * worked, but it cannot answer "the newest 200 rows" without parsing everything,
 * it rewrites the entire document to change one field, and a sync engine has no
 * per-row identity to diff. SQLite gives all three for free, and it costs no
 * dependency: Electron 38 ships Node 22.22, whose `node:sqlite` needs no flag.
 *
 * The pipeline writes successful results only. Older abnormal rows remain until
 * explicit cleanup. A retention window trims old entries on load and append,
 * and kept wav files live in
 * `<userData>/audio/` so a take can be downloaded or retried (REQ-07).
 */
export class HistoryStore {
  private readonly path: string
  private db: DatabaseSync | null = null
  private limit = 500
  /** `-1` forever, `0` never persist to disk, otherwise a window in seconds. */
  private retentionSeconds = -1
  /**
   * True once `load()` has run. Guarding writes on it matters because the app
   * calls `setRetention()` *before* `load()` on startup: flushing at that point
   * would write the still-empty store over the history we are about to read.
   */
  private loaded = false
  /**
   * Absolute path of the preserved copy when the database could not be opened.
   * Exposed so the UI can say "we kept your old file" instead of the user
   * silently starting from an empty list.
   */
  private damagedCopy: string | null = null
  /** Last time expired tombstones were swept, so `prune()` does not repeat it. */
  private prunedTombstones = 0
  /**
   * Highest `updatedAt` handed out so far. Two writes inside one millisecond would
   * otherwise share a stamp, and a sync cursor of `updatedAt > cursor` would skip
   * the second row forever — the one failure mode a LWW merge cannot recover from.
   */
  private lastStamp = 0

  /**
   * A stamp that is strictly greater than every earlier one. `base` is normally
   * `Date.now()`; a remote row's stamp is passed in when merging so local writes
   * cannot end up behind a row the other machine already has.
   */
  private stampAt(base: number): number {
    const stamp = base > this.lastStamp ? base : this.lastStamp + 1
    this.lastStamp = stamp
    return stamp
  }

  constructor(filePath = join(app.getPath('userData'), 'history.sqlite')) {
    this.path = filePath
  }

  /** Absolute directory that holds kept wav files. */
  audioDir(): string {
    return join(app.getPath('userData'), 'audio')
  }

  /** Applies a changed row cap immediately, including to subsequent appends. */
  setLimit(limit: number): void {
    this.limit = clampLimit(limit)
    if (this.loaded) this.prune()
  }

  /** Applies the retention window on load and immediately after a change. */
  async setRetention(seconds: number): Promise<void> {
    const next = Number.isFinite(seconds) ? Math.round(seconds) : -1
    const wasMemory = this.retentionSeconds === 0
    this.retentionSeconds = next
    // Before `load()` the store is not open yet; `load()` applies the window on
    // the way in instead.
    if (!this.loaded) return
    if (next === 0) {
      await this.wipeAll()
      return
    }
    if (wasMemory) {
      // Coming back from "never keep": the session's rows were in memory only,
      // so reopen the file and let the next take populate it.
      this.close()
      this.open()
    }
    this.prune()
  }

  async load(limit = this.limit): Promise<void> {
    this.limit = clampLimit(limit)
    // Retention 0 means "never keep history": a stale file would resurrect the
    // entries the user asked us to forget, so it is removed instead of opened.
    if (this.retentionSeconds === 0) {
      await this.clearDisk()
      // Wavs from earlier "never keep" runs have no surviving row that could
      // name them, so the whole audio directory goes with the database.
      await this.clearAudioDir()
      this.open()
      this.loaded = true
      return
    }
    try {
      this.open()
      this.adoptLegacyJson()
    } catch (err) {
      console.error('[history] cannot open database:', err)
      // Unreadable is not the same as empty. Treating a damaged database as `[]`
      // and then writing to it turns one bad read into permanent loss of every
      // row and every wav, so the bytes are moved aside first.
      this.close()
      await this.quarantine()
      this.open()
    }
    this.prune()
    this.loaded = true
  }

  private open(): void {
    if (this.db) return
    // "Never keep" uses an in-memory database: the session list stays usable
    // (the bar and retry read it) but nothing can survive a restart.
    const target = this.retentionSeconds === 0 ? ':memory:' : this.path
    const db = new DatabaseSync(target)
    if (target !== ':memory:') {
      // WAL keeps a reader (the settings window listing rows) from blocking the
      // writer (a take landing at the same moment).
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    }
    db.exec(SCHEMA)
    this.migrateColumns(db)
    this.lastStamp = Number((db.prepare('SELECT MAX(updatedAt) AS n FROM history').get() as Row)?.n ?? 0)
    this.db = db
  }

  /**
   * Adds `updatedAt` to a database created before sync existed.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing file, so a column added
   * to the schema never reaches a store that already has rows in it. The backfill
   * uses `createdAt`, which is the honest answer: nothing has touched those rows
   * since they were written.
   */
  private migrateColumns(db: DatabaseSync): void {
    const columns = db.prepare('PRAGMA table_info(history)').all() as { name?: unknown }[]
    const has = columns.some((column) => String(column.name ?? '') === 'updatedAt')
    if (has) return
    db.exec('ALTER TABLE history ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0')
    db.exec('UPDATE history SET updatedAt = createdAt WHERE updatedAt = 0')
    db.exec('CREATE INDEX IF NOT EXISTS history_updated_at ON history (updatedAt)')
    console.log('[history] added updatedAt to an older database')
  }

  /**
   * Releases the database handle. Windows keeps a lock on an open SQLite file,
   * so anything that deletes or moves the store (tests, a profile wipe) has to
   * close it first.
   */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // Closing an already-broken handle is not worth reporting.
    }
    this.db = null
  }

  private handle(): DatabaseSync {
    this.open()
    if (!this.db) throw new Error('history database is not open')
    return this.db
  }

  /**
   * Imports `history.json` from the JSON era, once.
   *
   * The old file is renamed rather than deleted: if the import ever disagrees
   * with what the user remembers, the original bytes are still there.
   */
  private adoptLegacyJson(): void {
    const legacy = join(dirname(this.path), 'history.json')
    if (!existsSync(legacy)) return
    try {
      const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        const rows = parsed.filter((item): item is HistoryEntry => {
          return Boolean(item) && typeof (item as HistoryEntry).id === 'string'
        })
        if (rows.length > 0) this.insertMany(rows)
        console.log(`[history] migrated ${rows.length} row(s) from history.json`)
      }
    } catch (err) {
      console.error('[history] cannot migrate history.json:', err)
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      renameSync(legacy, `${legacy}.migrated-${stamp}`)
    } catch (err) {
      console.error('[history] cannot archive history.json:', err)
    }
  }

  /**
   * Drops rows outside the retention window or beyond the row limit.
   * Returns true when something was removed.
   */
  private prune(now = Date.now()): boolean {
    const db = this.handle()
    let removed = 0
    if (this.retentionSeconds > 0) {
      const cutoff = now - this.retentionSeconds * 1000
      const stale = db.prepare('SELECT id, audioPath, updatedAt FROM history WHERE createdAt < ?').all(cutoff)
      if (stale.length > 0) {
        db.prepare('DELETE FROM history WHERE createdAt < ?').run(cutoff)
        for (const row of stale) {
          this.markDeleted(String(row.id), now)
          this.removeAudioPath(row.audioPath)
        }
        removed += stale.length
      }
    }
    const total = Number((db.prepare('SELECT COUNT(*) AS n FROM history').get() as Row)?.n ?? 0)
    if (total > this.limit) {
      // Trimming rows alone would leave the dropped rows' wav files on disk
      // forever with no row pointing at them, so the audio goes with the row.
      const tail = db
        .prepare('SELECT id, audioPath FROM history ORDER BY createdAt DESC LIMIT -1 OFFSET ?')
        .all(this.limit)
      const drop = db.prepare('DELETE FROM history WHERE id = ?')
      for (const row of tail) {
        drop.run(String(row.id))
        this.markDeleted(String(row.id), now)
        this.removeAudioPath(row.audioPath)
      }
      removed += tail.length
    }
    // Tombstones only have to outlive the other machines' next pull. Keeping them
    // forever would grow the file by one row per delete, which is the thing this
    // store was rewritten to avoid.
    if (removed || this.prunedTombstones !== now) {
      db.prepare('DELETE FROM history_deleted WHERE deletedAt < ?').run(now - TOMBSTONE_TTL_MS)
      this.prunedTombstones = now
    }
    return removed > 0
  }

  /**
   * Records that `id` was deleted, so the next sync can tell the server.
   *
   * A delete is not expressed by "the row is missing": another machine cannot
   * distinguish that from "not pushed yet", and would happily push it back.
   */
  private markDeleted(id: string, at: number): void {
    try {
      this.handle()
        .prepare(
          `INSERT INTO history_deleted (id, deletedAt) VALUES (?, ?)
           ON CONFLICT(id) DO UPDATE SET deletedAt = excluded.deletedAt`
        )
        .run(id, this.stampAt(at))
    } catch (err) {
      console.error('[history] cannot record a delete:', err)
    }
  }

  private removeAudioPath(audioPath: unknown): void {
    if (typeof audioPath !== 'string' || audioPath.length === 0) return
    void unlink(join(app.getPath('userData'), audioPath)).catch(() => undefined)
  }

  /**
   * Writes are already durable — SQLite commits per statement, so there is
   * nothing to flush. Kept as a no-op so call sites do not have to know that.
   */
  private async flush(): Promise<void> {
    this.open()
  }

  /** Moves an unreadable database aside so the next session cannot overwrite it. */
  private async quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const broken = `${this.path}.broken-${stamp}`
    try {
      await rename(this.path, broken)
      this.damagedCopy = broken
      console.error(`[history] damaged database kept at ${broken}`)
    } catch (err) {
      console.error('[history] cannot keep damaged database:', err)
    }
  }

  /** Path of the preserved unreadable file, when the last load found one. */
  damagedPath(): string | null {
    return this.damagedCopy
  }

  /** Deletes the database files; a missing file is not an error. */
  private async clearDisk(): Promise<void> {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await unlink(`${this.path}${suffix}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[history] cannot remove ${suffix || 'database'}:`, err)
        }
      }
    }
  }

  /**
   * Forgets everything: rows, their wav files and the database itself when the
   * user asked for "never keep". Shared by `clear()` and by the retention path,
   * which must also drop what is already on disk.
   */
  private async wipeAll(): Promise<void> {
    const db = this.handle()
    const rows = db.prepare('SELECT id, audioPath FROM history').all()
    const now = Date.now()
    for (const row of rows) this.markDeleted(String(row.id), now)
    db.exec('DELETE FROM history')
    for (const row of rows) this.removeAudioPath(row.audioPath)
    if (this.retentionSeconds === 0) {
      this.close()
      await this.clearDisk()
      this.open()
    }
  }

  /**
   * Removes kept wavs that no row points at any more.
   *
   * "Never keep history" still writes a wav per take for the upload of that
   * take, and because the rows are never persisted, a later start has no
   * record of those files. Sweeping the audio directory on load is the only
   * place left that can reclaim them without touching the pipeline.
   */
  private async clearAudioDir(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.audioDir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[history] cannot list audio:', err)
      }
      return
    }
    for (const name of names) {
      try {
        await unlink(join(this.audioDir(), name))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[history] cannot remove audio:', err)
        }
      }
    }
  }

  private upsert(entry: HistoryEntry): void {
    const row = entryToRow(entry)
    this.handle()
      .prepare(
        `INSERT INTO history (id, createdAt, updatedAt, mode, status, app, transcript, final, durationMs, wordCount, audioPath, extra)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt,
           mode = excluded.mode,
           status = excluded.status,
           app = excluded.app,
           transcript = excluded.transcript,
           final = excluded.final,
           durationMs = excluded.durationMs,
           wordCount = excluded.wordCount,
           audioPath = excluded.audioPath,
           extra = excluded.extra`
      )
      .run(
        row.id as string,
        row.createdAt as number,
        row.updatedAt as number,
        row.mode as string,
        row.status as string,
        row.app as string,
        row.transcript as string,
        row.final as string,
        row.durationMs as number,
        (row.wordCount as number | null) ?? null,
        (row.audioPath as string | null) ?? null,
        row.extra as string
      )
  }

  private insertMany(entries: HistoryEntry[]): void {
    this.open()
    const db = this.handle()
    db.exec('BEGIN')
    try {
      for (const entry of entries) this.upsert(entry)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Inserts rows that already carry their identity — used by the `history.json`
   * migration and by tests that need to seed what an earlier run left behind.
   * Returns how many rows were written.
   */
  migrateFrom(entries: HistoryEntry[]): number {
    this.insertMany(entries)
    return entries.length
  }

  async add(input: HistoryAddInput): Promise<HistoryEntry> {
    const now = Date.now()
    const entry: HistoryEntry = tidy({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: this.stampAt(now),
      mode: input.mode,
      transcript: input.transcript,
      final: input.final,
      durationMs: input.durationMs,
      app: input.app ?? '',
      status: input.status ?? 'completed'
    })
    this.upsert(entry)
    this.prune()
    await this.flush()
    return entry
  }

  /**
   * Patches one row (edit capture, retry counters, reverted flag). The row is
   * rewritten whole rather than column-by-column: the field list would have to
   * be maintained in two places, and the last time that happened a caller's
   * value was silently dropped.
   */
  async update(id: string, patch: Partial<HistoryEntry>): Promise<HistoryEntry | undefined> {
    const current = this.get(id)
    if (!current) return undefined
    // The patch may carry `updatedAt` (a row pulled from the server keeps the
    // remote stamp so the next push does not send it back); otherwise it moves now.
    const next: HistoryEntry = tidy({
      ...current,
      ...patch,
      id: current.id,
      updatedAt: patch.updatedAt ?? this.stampAt(Date.now())
    })
    this.upsert(next)
    await this.flush()
    return next
  }

  /** Stores a wav for one take and returns its path relative to `userData`. */
  async saveAudio(id: string, wav: Buffer): Promise<string> {
    const dir = this.audioDir()
    await mkdir(dir, { recursive: true })
    const relative = join('audio', `${id}.wav`)
    await writeFile(join(app.getPath('userData'), relative), wav)
    return relative
  }

  async readAudio(entry: HistoryEntry): Promise<Buffer | undefined> {
    if (!entry.audioPath) return undefined
    try {
      return await readFile(join(app.getPath('userData'), entry.audioPath))
    } catch {
      return undefined
    }
  }

  /**
   * Copies a kept wav into `destDir` (the user's Downloads folder by default)
   * and returns the new path. The entry keeps its own copy.
   */
  async downloadAudio(
    id: string,
    destDir = app.getPath('downloads')
  ): Promise<{ ok: boolean; path?: string; message?: string }> {
    const entry = this.get(id)
    if (!entry) return { ok: false, message: mt('找不到这条记录') }
    if (!entry.audioPath) return { ok: false, message: mt('这条记录没有保存音频') }
    const source = join(app.getPath('userData'), entry.audioPath)
    try {
      await stat(source)
    } catch {
      return { ok: false, message: mt('音频文件已不存在') }
    }
    await mkdir(destDir, { recursive: true })
    const stamp = new Date(entry.createdAt).toISOString().replace(/[:.]/g, '-')
    const target = join(destDir, `typeless-${stamp}.wav`)
    await copyFile(source, target)
    return { ok: true, path: target }
  }

  /** Absolute path of an entry's wav, for playback or retry. */
  audioPathOf(entry: HistoryEntry): string | undefined {
    if (!entry.audioPath) return undefined
    return join(app.getPath('userData'), entry.audioPath)
  }

  /**
   * Newest rows first. A query does a substring match on text, app and card name.
   * SQLite's LIKE is case-insensitive for ASCII and an exact
   * substring match for Chinese, which is what the old in-memory index got
   * wrong for CJK (it tokenised on spaces, so a whole Chinese sentence was one
   * token and prefix search missed every match inside it).
   */
  list(query = '', limit = 200, range?: { from: number; until: number }): HistoryEntry[] {
    const trimmed = query.trim()
    const needle = `%${escapeLike(trimmed)}%`
    const filters: string[] = [], values: (string | number)[] = []
    if (trimmed) {
      filters.push(`(final LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\' OR app LIKE ? ESCAPE '\\'
        OR json_extract(CASE WHEN json_valid(extra) THEN extra ELSE '{}' END, '$.promptName') LIKE ? ESCAPE '\\')`)
      values.push(needle, needle, needle, needle)
    }
    if (range) { filters.push('createdAt >= ? AND createdAt < ?'); values.push(range.from, range.until) }
    const rows = this.handle().prepare(`SELECT * FROM history${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY createdAt DESC LIMIT ?`).all(...values, limit)
    return rows.map(rowToEntry)
  }

  latest(): HistoryEntry | undefined {
    const row = this.handle()
      .prepare(`SELECT * FROM history WHERE ${NORMAL_HISTORY_SQL} ORDER BY createdAt DESC LIMIT 1`)
      .get() as Row | undefined
    return row ? rowToEntry(row) : undefined
  }

  get(id: string): HistoryEntry | undefined {
    const row = this.handle().prepare('SELECT * FROM history WHERE id = ?').get(id) as Row | undefined
    return row ? rowToEntry(row) : undefined
  }

  /** Newest entry with the given status, used by the bar's retry button. */
  latestWithStatus(status: HistoryEntry['status']): HistoryEntry | undefined {
    const row = this.handle()
      .prepare('SELECT * FROM history WHERE status = ? ORDER BY createdAt DESC LIMIT 1')
      .get(status ?? 'completed') as Row | undefined
    return row ? rowToEntry(row) : undefined
  }

  /** Total row count, independent of the `limit` that `list()` applies. */
  count(): number {
    const row = this.handle().prepare('SELECT COUNT(*) AS n FROM history').get() as Row | undefined
    return Number(row?.n ?? 0)
  }

  async remove(id: string): Promise<void> {
    const entry = this.get(id)
    this.rawDelete(id)
    this.markDeleted(id, Date.now())
    if (entry?.audioPath) this.removeAudioPath(entry.audioPath)
    await this.flush()
  }

  /** Deletes one row without a tombstone — the server already knows about it. */
  private rawDelete(id: string): void {
    this.handle().prepare('DELETE FROM history WHERE id = ?').run(id)
  }

  /**
   * Hides an entry without deleting it or its audio.
   *
   * `dismissed` means "the user threw this take away" and is part of the
   * dictionary-learning signal; archiving is the opposite — the text was good,
   * the user just does not want it in the list any more. Keeping them apart is
   * why the reference client has an `archived` state instead of one "hidden".
   * Legacy abnormal entries retain their original status locally when put away.
   */
  async archive(id: string, archived = true): Promise<boolean> {
    const entry = this.get(id)
    if (!entry) return false
    if ((entry.status === 'archived') === archived) return true
    const previous = entry.status === 'archived'
      ? entry.archivedStatus ?? (entry.error?.trim() ? 'error' : 'completed')
      : entry.status ?? (entry.error?.trim() ? 'error' : 'completed')
    await this.update(id, { status: archived ? 'archived' : previous,
      archivedStatus: archived && previous !== 'completed' ? previous : undefined })
    return true
  }

  async clear(): Promise<void> {
    await this.wipeAll()
  }

  /** Explicit cleanup of old abnormal rows; successful and archived text stays. */
  async clearAbnormal(): Promise<number> {
    const db = this.handle()
    const rows = db.prepare(`SELECT id, audioPath FROM history WHERE NOT (${NORMAL_HISTORY_SQL})`).all()
    db.exec('BEGIN')
    try {
      for (const row of rows) {
        this.rawDelete(String(row.id))
        this.markDeleted(String(row.id), Date.now())
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    for (const row of rows) this.removeAudioPath(row.audioPath)
    return rows.length
  }

  /* ----------------------------- sync cursors ----------------------------- */

  /**
   * Rows changed after `since`, oldest first.
   *
   * Ordered by `updatedAt` so a caller that stops at `limit` can resume from the
   * last stamp it saw instead of skipping the tail.
   */
  changesSince(since: number, limit = 500): HistoryEntry[] {
    const rows = this.handle()
      .prepare(`SELECT * FROM history WHERE updatedAt > ? AND ${NORMAL_HISTORY_SQL} ORDER BY updatedAt ASC LIMIT ?`)
      .all(since, limit)
    return rows.map(rowToEntry)
  }

  /** Deletes recorded after `since`, oldest first. */
  deletionsSince(since: number, limit = 500): { id: string; deletedAt: number }[] {
    const rows = this.handle()
      .prepare('SELECT id, deletedAt FROM history_deleted WHERE deletedAt > ? ORDER BY deletedAt ASC LIMIT ?')
      .all(since, limit)
    return rows.map((row) => ({ id: String(row.id), deletedAt: Number(row.deletedAt) }))
  }

  /** How many rows carry a change newer than `since` — the "N to push" counter. */
  pendingSince(since: number): number {
    const row = this.handle()
      .prepare(`SELECT COUNT(*) AS n FROM history WHERE updatedAt > ? AND ${NORMAL_HISTORY_SQL}`)
      .get(since) as Row | undefined
    return Number(row?.n ?? 0)
  }

  /**
   * Newest stamp on either side of the ledger.
   *
   * Used after a pull: every local row has just been sent, so "the highest stamp
   * I hold" is exactly "everything up to here is on the server".
   */
  newestStamp(): number {
    const db = this.handle()
    const row = db.prepare('SELECT MAX(updatedAt) AS a FROM history').get() as Row | undefined
    const gone = db.prepare('SELECT MAX(deletedAt) AS b FROM history_deleted').get() as Row | undefined
    return Math.max(Number(row?.a ?? 0), Number(gone?.b ?? 0))
  }

  /**
   * Merges one page from the server.
   *
   * Last write wins on `updatedAt`, with two rules that matter when two machines
   * disagree: a local row that is newer is kept, and a server-side delete only
   * removes a row the server had seen last. Returns how many rows changed.
   */
  async applyRemote(entries: unknown, deleted: unknown): Promise<number> {
    const incoming = Array.isArray(entries) ? entries : []
    const tombstones = Array.isArray(deleted) ? deleted : []
    if (incoming.length === 0 && tombstones.length === 0) return 0

    const db = this.handle()
    let changed = 0
    db.exec('BEGIN')
    try {
      for (const raw of incoming) {
        const remote = fromSyncRow(raw)
        if (!remote) continue
        const local = this.get(remote.id)
        if (local && (local.updatedAt ?? local.createdAt) >= (remote.updatedAt ?? 0)) continue
        // Keep the local clock ahead of anything the server sent, or the next local
        // write would sort before a row that is already in the database.
        if (remote.updatedAt) this.stampAt(remote.updatedAt)
        const merged: HistoryEntry = local?.audioPath ? { ...remote, audioPath: local.audioPath } : remote
        this.upsert(merged)
        changed += 1
      }
      for (const raw of tombstones) {
        const item = raw as { id?: unknown; deletedAt?: unknown }
        const id = typeof item.id === 'string' ? item.id : ''
        const at = Number(item.deletedAt)
        if (!id || !Number.isFinite(at)) continue
        const local = this.get(id)
        if (!local) continue
        // A local edit made after the delete is the user's latest word on it.
        if ((local.updatedAt ?? local.createdAt) > at) continue
        this.rawDelete(id)
        if (local.audioPath) this.removeAudioPath(local.audioPath)
        changed += 1
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    if (changed > 0) await this.flush()
    return changed
  }
}

