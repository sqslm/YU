/**
 * 「随记」storage and background pipeline (REQ notes).
 *
 * A note is a long-lived recording: the audio is written to disk first, then the
 * entry appears in the list immediately with `polishStatus:'pending'`, and the
 * transcript / light polish arrive later in the background. That order matters —
 * the user must see their note the instant they stop talking, and a provider
 * outage must never cost them the recording.
 *
 * Layout under the data root (`settings.notesDir` or `userData`):
 *
 *   notes.json                    the NoteStore document, pretty JSON
 *   notes/audio/<id>.<ogg|wav>    one file per note
 *
 * `audioPath` in the JSON is *relative* to the root on purpose: a migrated data
 * directory stays readable without rewriting every row.
 *
 * Persistence follows `history.ts`: a plain JSON document, `flush()` after every
 * change, and no write before `load()` (a write with an empty in-memory store
 * would erase the file we have not read yet).
 */
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { app } from 'electron'
import { resolvePromptCard } from '@shared/promptLibrary'
import { renderContext } from '@shared/prompts'
import { applyReplacements } from '@shared/text'
import type { NoteBulk, NoteCategory, NoteEntry, NotePatch, NoteStore, NoteTombstone, Settings } from '@shared/types'
import { toOggOpus } from './audio/transcode'
import { encodeWav, pcmDurationMs } from './audio/wav'
import { decodeRecording } from './audio/decode'
import { chainFor, withFailover } from './providers/chain'
import { transcribe } from './providers/asr'
import { complete, unwrapModelText } from './providers/llm'
import { cleanPolishedText, POLISH_OUTPUT_RULES } from '@shared/polish'
import { mt } from '@shared/mainI18n'

/** The database document at the data root. */
const DB_FILE = 'notes.json'
/** Audio subdirectory, relative to the data root (POSIX separators in JSON). */
const AUDIO_REL_DIR = 'notes/audio'
/** Root-level container of everything the store owns; moved as a unit. */
const NOTES_DIR = 'notes'
/** Storage bitrate for note audio: notes are kept for a long time. */
const AUDIO_BITRATE_KBPS = 64

const MAX_TAGS = 12
const MAX_TAG_CHARS = 24
/** Same text limit as the sync server; clipboard text must not be truncated. */
const MAX_TEXT_CHARS = 200_000
const MAX_CATEGORIES = 40
/** Changes per push, matching the server's `notesPerPush` limit. */
const MAX_PUSH_NOTES = 200

const POLISH_STATUSES: readonly NoteEntry['polishStatus'][] = ['pending', 'ok', 'failed', 'skipped']

export interface NotesStoreOptions {
  localAsr?: { enabled: () => boolean; prepare: () => Promise<void>; transcribeWav: (wav: Uint8Array) => Promise<string> }
  log: (line: string) => void
  getSettings: () => Settings
  /** Called after any persisted change so the UI can refresh. */
  notify?: () => void
}

/**
 * One-line error text, matching the pipeline's failover log lines: status first,
 * then the reason, capped so a provider HTML page cannot flood the log.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status
    const head = typeof status === 'number' ? `${status} ` : ''
    return `${head}${error.message}`.slice(0, 120)
  }
  return String(error).slice(0, 120)
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * Tags as the UI expects them: trimmed, blank-free, clipped, deduped, capped.
 * First appearance wins so the order the user typed is preserved.
 */
function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const tags: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim().replace(/\s+/g, ' ')
    if (!trimmed) continue
    // Code points, not UTF-16 units: clipping must never split an emoji.
    const clipped = Array.from(trimmed).slice(0, MAX_TAG_CHARS).join('')
    if (tags.includes(clipped)) continue
    tags.push(clipped)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/** Category list as the UI expects it: unique ids, non-empty trimmed names, capped. */
function sanitizeCategories(input: unknown): NoteCategory[] {
  if (!Array.isArray(input)) return []
  const categories: NoteCategory[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof (raw as NoteCategory).id === 'string' ? (raw as NoteCategory).id.trim() : ''
    const name = typeof (raw as NoteCategory).name === 'string' ? (raw as NoteCategory).name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    categories.push({ id, name })
    if (categories.length >= MAX_CATEGORIES) break
  }
  return categories
}

/** An unreadable status is not worth guessing at: derive it from the text itself. */
function readPolishStatus(value: unknown, polished: string): NoteEntry['polishStatus'] {
  if (typeof value === 'string' && (POLISH_STATUSES as readonly string[]).includes(value)) {
    return value as NoteEntry['polishStatus']
  }
  return polished.trim() ? 'ok' : 'skipped'
}

function formatFromPath(path: string | undefined): NoteEntry['audioFormat'] {
  if (!path) return undefined
  if (/\.ogg$/i.test(path)) return 'ogg'
  if (/\.wav$/i.test(path)) return 'wav'
  return undefined
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * One stored row, repaired field by field. A hand-edited or older file must not
 * make the whole list unusable, so unknown fields are dropped and missing ones
 * get a harmless default instead of throwing.
 */
function normalizeNote(value: unknown): NoteEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null

  const transcript = typeof raw.transcript === 'string' ? raw.transcript : ''
  const polished = typeof raw.polished === 'string' ? raw.polished : ''
  const now = Date.now()
  const note: NoteEntry = {
    id,
    createdAt: finiteNumber(raw.createdAt, now),
    updatedAt: finiteNumber(raw.updatedAt, now),
    durationMs: Math.max(0, Math.round(finiteNumber(raw.durationMs, 0))),
    transcript,
    polished,
    polishStatus: readPolishStatus(raw.polishStatus, polished),
    tags: normalizeTags(raw.tags)
  }
  if (typeof raw.polishError === 'string' && raw.polishError) note.polishError = raw.polishError
  if (typeof raw.audioPath === 'string' && raw.audioPath) note.audioPath = raw.audioPath
  const format =
    raw.audioFormat === 'ogg' || raw.audioFormat === 'wav' ? raw.audioFormat : formatFromPath(note.audioPath)
  if (format) note.audioFormat = format
  if (typeof raw.audioBytes === 'number' && Number.isFinite(raw.audioBytes) && raw.audioBytes > 0) {
    note.audioBytes = Math.round(raw.audioBytes)
  }
  if (typeof raw.categoryId === 'string' && raw.categoryId) note.categoryId = raw.categoryId
  if (typeof raw.title === 'string' && raw.title.trim()) note.title = raw.title.trim().slice(0, 200)
  if (typeof raw.editedAt === 'number' && Number.isFinite(raw.editedAt)) note.editedAt = raw.editedAt
  // A file written by an older build has neither field: such a note has never
  // reached a server, and the first sync will push it.
  if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 0) {
    note.version = raw.version
  }
  if (raw.pending === true) note.pending = true
  if (raw.audioUploaded === true) note.audioUploaded = true
  return note
}

/** Tombstones as stored: unique ids, a usable version, newest first. */
function normalizeTombstones(value: unknown, live: Set<string>): NoteTombstone[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tombstones: NoteTombstone[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    // A tombstone for a note that still exists would delete it on the next pull.
    if (!id || seen.has(id) || live.has(id)) continue
    seen.add(id)
    tombstones.push({
      id,
      version: Number.isInteger(item.version) && Number(item.version) >= 0 ? Number(item.version) : 0,
      deletedAt: finiteNumber(item.deletedAt, Date.now())
    })
  }
  return tombstones
}

function normalizeStore(value: unknown): NoteStore {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const candidates = Array.isArray(source.notes) ? source.notes : []
  const notes: NoteEntry[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const note = normalizeNote(candidate)
    // A duplicate id would make `update` ambiguous; the first row owns the id.
    if (!note || seen.has(note.id)) continue
    seen.add(note.id)
    notes.push(note)
  }
  return {
    notes,
    categories: sanitizeCategories(source.categories),
    deleted: normalizeTombstones(source.deleted, new Set(notes.map((note) => note.id)))
  }
}

function cloneNote(note: NoteEntry): NoteEntry {
  return { ...note, tags: [...note.tags] }
}

/** A recording the server holds, as reported by a pull page. */
export interface RemoteAudio {
  id: string
  format: 'ogg' | 'wav'
  sha256: string
  bytes: number
}

/** One pulled row, read as defensively as a row off disk. */
function remoteNote(row: Record<string, unknown>, id: string, version: number): NoteEntry {
  const polished = typeof row.polished === 'string' ? row.polished : ''
  const now = Date.now()
  const note: NoteEntry = {
    id,
    createdAt: finiteNumber(row.createdAt, now),
    updatedAt: finiteNumber(row.updatedAt, now),
    durationMs: Math.max(0, Math.round(finiteNumber(row.durationMs, 0))),
    transcript: typeof row.transcript === 'string' ? row.transcript : '',
    polished,
    polishStatus: readPolishStatus(row.polishStatus, polished),
    tags: normalizeTags(row.tags),
    version,
    // The server's copy is by definition already there; no push is needed.
    pending: false
  }
  if (typeof row.polishError === 'string' && row.polishError) note.polishError = row.polishError
  if (typeof row.categoryId === 'string' && row.categoryId) note.categoryId = row.categoryId
  if (typeof row.title === 'string' && row.title.trim()) note.title = row.title.trim().slice(0, 200)
  if (typeof row.editedAt === 'number' && Number.isFinite(row.editedAt)) note.editedAt = row.editedAt
  return note
}

function emptyStore(): NoteStore {
  return { notes: [], categories: [], deleted: [] }
}

/** Bytes of every file under `dir`, recursively; unreadable paths count as 0. */
function totalBytes(dir: string): number {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += totalBytes(path)
    else if (entry.isFile()) {
      try {
        total += statSync(path).size
      } catch {
        // The file vanished between listing and stat: nothing to count.
      }
    }
  }
  return total
}

/**
 * Free bytes on the volume holding `dir`, or null when it cannot be verified.
 * `statfs` lies on some network shares, so a nonsensical answer counts as
 * unverifiable rather than as "plenty".
 */
function freeBytes(dir: string): number | null {
  try {
    const info = statfsSync(dir)
    const blocks = Number(info.bavail)
    const blockSize = Number(info.bsize)
    if (!Number.isFinite(blocks) || !Number.isFinite(blockSize) || blocks <= 0 || blockSize <= 0) return null
    return blocks * blockSize
  } catch {
    return null
  }
}

/** True when `child` sits strictly inside `parent` (same volume or not). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  if (!rel) return false
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** Windows paths are case-insensitive, so `D:\A` and `d:\a` are one directory. */
function isSamePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Backup folder name safe on Windows: no ':' or '.' from the ISO timestamp. */
function backupStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Note count in a database document, or null when it is not readable. */
function countNotes(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const notes = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).notes : undefined
    return Array.isArray(notes) ? notes.length : null
  } catch {
    return null
  }
}

/**
 * Encode for storage. Compression is a space optimisation only: every failure
 * mode (no ffmpeg, timeout, non-zero exit, too-short clip) keeps the WAV, because
 * a note that cannot be played is worse than a note that is 8× bigger.
 */
async function compressForStorage(
  wav: Uint8Array,
  log: (line: string) => void
): Promise<{ data: Uint8Array; format: 'ogg' | 'wav' }> {
  try {
    const outcome = await toOggOpus(wav, { bitrateKbps: AUDIO_BITRATE_KBPS })
    if (outcome.ok && outcome.audio.data.byteLength > 0) return { data: outcome.audio.data, format: 'ogg' }
    if (outcome.ok) log('[notes] 音频压缩返回了空文件，保存为 WAV')
    else {
      log(
        `[notes] 音频压缩不可用（${outcome.reason}${outcome.message ? `：${outcome.message}` : ''}），保存为 WAV`
      )
    }
  } catch (error) {
    log(`[notes] 音频压缩失败（${describeError(error)}），保存为 WAV`)
  }
  return { data: wav, format: 'wav' }
}

export class NotesStore {
  private readonly options: NotesStoreOptions
  private data: NoteStore = emptyStore()
  private loaded = false
  /**
   * Absolute path of the rescue copy when the document could not be parsed.
   * Exposed so the UI can tell the user their old notes were kept instead of
   * leaving them to wonder why the list is empty.
   */
  private damagedFile: string | null = null
  /**
   * Root chosen by a successful `migrate` or by `commitDir`, overriding
   * `settings.notesDir` until the caller's settings say the same thing. The store
   * cannot write settings (they belong to the app), so it records the decision
   * here and the caller persists it.
   */
  private dirOverride: string | null = null
  /**
   * Per-note run counter. Editing a note, repolishing it or deleting it bumps the
   * counter, and a background step whose token no longer matches drops its
   * result: a slow provider must never overwrite newer text.
   */
  private readonly runs = new Map<string, number>()

  constructor(options: NotesStoreOptions) {
    this.options = options
  }

  /** Read the database from disk. Call once at startup, before using the store. */
  async load(): Promise<void> {
    const root = this.root()
    try {
      mkdirSync(join(root, AUDIO_REL_DIR), { recursive: true })
    } catch (error) {
      // An unusable root must not stop the app from starting: the list stays
      // empty and every later save reports the same failure in the log.
      this.options.log(`[notes] 无法创建数据目录 ${root}：${describeError(error)}`)
    }
    this.data = this.readDatabase(join(root, DB_FILE))
    this.loaded = true
    this.options.log(`[notes] 已加载 ${this.data.notes.length} 条随记（${root}）`)
  }

  /** Snapshot for the renderer; the caller never gets the live objects. */
  list(): NoteStore {
    return {
      notes: this.data.notes.map(cloneNote),
      categories: this.data.categories.map((category) => ({ ...category }))
    }
  }

  /**
   * Store a recording and start transcribing it.
   *
   * The audio file is written before the entry exists: if the write fails nothing
   * is inserted, so the list can never name a recording that is not there. The
   * entry comes back immediately with `polishStatus:'pending'`; the transcript and
   * polish land later through `notify`.
   */
  async create(
    input: { pcm: Int16Array; durationMs: number; categoryId?: string; tags?: string[]; recovery?: boolean },
    signal?: AbortSignal,
    transcript?: string
  ): Promise<NoteEntry> {
    const pcm = input.pcm instanceof Int16Array ? input.pcm : new Int16Array(0)
    const spokenMs = pcmDurationMs(pcm)
    const durationMs = this.clampDuration(input.durationMs, spokenMs)
    const wav = encodeWav(pcm)

    const id = randomUUID()
    const stored = await compressForStorage(wav, this.options.log)
    signal?.throwIfAborted()
    const audioDir = join(this.root(), AUDIO_REL_DIR)
    const audioRel = `${AUDIO_REL_DIR}/${id}.${stored.format}`
    mkdirSync(audioDir, { recursive: true })
    writeFileSync(join(audioDir, `${id}.${stored.format}`), stored.data)

    const now = Date.now()
    const entry: NoteEntry = {
      id,
      createdAt: now,
      updatedAt: now,
      durationMs,
      transcript: transcript ?? '',
      polished: '',
      polishStatus: input.recovery ? 'failed' : 'pending',
      ...(input.recovery ? { polishError: mt('语音识别未完成，录音已保留，请重新转写') } : {}),
      audioPath: audioRel,
      audioFormat: stored.format,
      audioBytes: stored.data.byteLength,
      tags: normalizeTags(input.tags),
      // A new note is a local change by definition; the next sync pushes it.
      pending: true
    }
    const categoryId = this.knownCategory(input.categoryId)
    if (categoryId) entry.categoryId = categoryId

    this.data.notes.unshift(entry)
    try {
      this.save(true)
    } catch (error) {
      this.data.notes.splice(this.data.notes.indexOf(entry), 1)
      unlinkSync(join(this.root(), audioRel))
      throw error
    }
    this.options.log(
      `[notes] 新随记 ${id} 已保存（${stored.format}, ${Math.round(stored.data.byteLength / 1024)} KB, ${durationMs} ms）`
    )

    // Detached on purpose: `create` returns as soon as the note is safe on disk.
    if (!input.recovery) void this.run(id, wav, signal, transcript)
    return cloneNote(entry)
  }

  /** Create a text-only note without recording or invoking a model. */
  async createText(input: { text: string; categoryId?: string }): Promise<NoteEntry> {
    if (typeof input.text !== 'string') throw new Error(mt('随记内容必须是文字'))
    if (input.text.length > MAX_TEXT_CHARS) throw new Error(mt('文字过长，最多支持 {{n}} 个字符', { n: MAX_TEXT_CHARS }))
    const now = Date.now()
    const categoryId = this.knownCategory(input.categoryId)
    const entry: NoteEntry = {
      id: randomUUID(), createdAt: now, updatedAt: now, editedAt: now,
      transcript: input.text, polished: '', polishStatus: 'skipped',
      durationMs: 0, tags: [], pending: true,
      ...(categoryId ? { categoryId } : {})
    }
    this.data.notes.unshift(entry)
    try {
      this.save(true)
    } catch (error) {
      this.data.notes.splice(this.data.notes.indexOf(entry), 1)
      throw error
    }
    return cloneNote(entry)
  }

  /**
   * Patch the user-editable fields. `categoryId` set to an unknown or empty value
   * clears the category. Touching `transcript`/`polished` stamps `editedAt`, which
   * is what stops a late polish from replacing what the user typed.
   */
  async update(id: string, patch: NotePatch): Promise<NoteEntry | undefined> {
    const note = this.find(id)
    if (!note) return undefined
    const before = cloneNote(note)

    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, 200)
      if (title) note.title = title
      else delete note.title
    }

    let edited = false
    if (patch.transcript !== undefined && patch.transcript !== note.transcript) {
      note.transcript = patch.transcript
      edited = true
    }
    if (patch.polished !== undefined && patch.polished !== note.polished) {
      note.polished = patch.polished
      edited = true
    }
    if (patch.categoryId !== undefined) {
      const categoryId = this.knownCategory(patch.categoryId)
      if (categoryId) note.categoryId = categoryId
      else delete note.categoryId
    }
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags)

    const now = Math.max(Date.now(), note.updatedAt + 1)
    note.updatedAt = Math.max(now, note.updatedAt + 1)
    if (edited) note.editedAt = now
    // Any user edit is a change to push; the server compares `version` before it
    // takes it, so this flag never decides *whether* the server accepts it.
    note.pending = true
    try { this.save(true) }
    catch (error) { this.data.notes[this.data.notes.indexOf(note)] = before; throw error }
    return cloneNote(note)
  }

  /** Drop a note and its recording. A missing audio file is not an error. */
  async remove(id: string): Promise<void> {
    await this.applyBulk([id], { delete: true })
  }

  /**
   * One change across a selection: the sidebar's batch operations.
   *
   * Deliberately one `save()` and one broadcast for the whole selection. Looping
   * `update()` from the renderer would rewrite `notes.json` once per note and let
   * the list reload mid-batch, which looks like rows flickering away one by one.
   */
  async applyBulk(ids: string[], bulk: NoteBulk): Promise<{ matched: number; changed: number }> {
    const wanted = new Set(
      (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string' && !!id)
    )
    if (wanted.size === 0) return { matched: 0, changed: 0 }

    if (bulk?.delete) {
      const before = this.data.notes
      const deletedBefore = this.data.deleted?.slice()
      const removed = before.filter(note => wanted.has(note.id))
      if (removed.length > 0) {
        this.data.notes = before.filter(note => !wanted.has(note.id))
        for (const note of removed) this.tombstone(note)
        try { this.save(true) }
        catch (error) { this.data.notes = before; this.data.deleted = deletedBefore; throw error }
        // Only destroy recordings and invalidate jobs after deletion reaches disk.
        for (const note of removed) {
          this.bump(note.id)
          if (note.audioPath) this.unlinkAudio(join(this.root(), note.audioPath))
        }
        this.options.log(`[notes] 批量删除 ${removed.length} 条随记`)
      }
      return { matched: removed.length, changed: removed.length }
    }

    const wantsCategory = bulk?.categoryId !== undefined
    // `knownCategory` answers with the surviving id, or undefined when the bucket
    // is gone — which is exactly the "clear it" signal.
    const categoryId = wantsCategory && bulk.categoryId ? this.knownCategory(bulk.categoryId) : undefined
    const addTags = normalizeTags(bulk?.addTags)
    const dropTags = new Set(normalizeTags(bulk?.removeTags))
    const now = Date.now()
    let matched = 0
    let changed = 0
    const before = this.data.notes.map(note => wanted.has(note.id) ? cloneNote(note) : note)

    for (const note of this.data.notes) {
      if (!wanted.has(note.id)) continue
      matched += 1
      let touched = false
      if (wantsCategory) {
        // A category that no longer exists clears the field rather than storing a
        // dangling id, which is what a deleted category looks like after a reload.
        const next = categoryId
        if (next !== note.categoryId) {
          if (next) note.categoryId = next
          else delete note.categoryId
          touched = true
        }
      }
      if (addTags.length > 0) {
        const merged = normalizeTags([...note.tags, ...addTags])
        if (merged.length !== note.tags.length || merged.some((tag, i) => tag !== note.tags[i])) {
          note.tags = merged
          touched = true
        }
      }
      if (dropTags.size > 0) {
        const kept = note.tags.filter((tag) => !dropTags.has(tag))
        if (kept.length !== note.tags.length) {
          note.tags = kept
          touched = true
        }
      }
      if (!touched) continue
      note.updatedAt = Math.max(now, note.updatedAt + 1)
      note.pending = true
      changed += 1
    }

    if (changed > 0) {
      try { this.save(true) }
      catch (error) { this.data.notes = before; throw error }
      this.options.log(`[notes] 批量修改 ${changed} 条随记`)
    }
    return { matched, changed }
  }

  /**
   * Explicit user request to polish again: the only path allowed to replace text
   * the user edited, so it clears `editedAt` and waits for the result instead of
   * finishing in the background.
   */
  async repolish(id: string): Promise<NoteEntry | undefined> {
    const note = this.find(id)
    if (!note) return undefined
    const transcript = note.transcript
    if (!transcript.trim()) {
      // Nothing to polish: say so instead of running a request that cannot help.
      this.options.log(`[notes] 随记 ${id} 没有转写文本，无法润色`)
      note.polishStatus = 'failed'
      note.polishError = mt('没有可润色的转写文本')
      note.updatedAt = Math.max(Date.now(), note.updatedAt + 1)
      note.pending = true
      this.save()
      return cloneNote(note)
    }

    const token = this.bump(id)
    delete note.editedAt
    note.polishStatus = 'pending'
    delete note.polishError
    note.updatedAt = Math.max(Date.now(), note.updatedAt + 1)
    note.pending = true
    this.save()

    await this.polishStep(id, token, this.options.getSettings(), transcript)
    const updated = this.find(id)
    return updated ? cloneNote(updated) : undefined
  }

  /** Replace text only when decoding, ASR and optional polish all succeed. */
  async retranscribe(id: string, signal?: AbortSignal): Promise<NoteEntry | undefined> {
    const note = this.find(id)
    const file = this.audioPathOf(id)
    if (!note || !file) throw new Error(mt('此随记没有本地录音'))
    const token = this.bump(id)
    const original = { transcript: note.transcript, polished: note.polished, editedAt: note.editedAt }
    const unchanged = (): boolean => {
      const current = this.find(id)
      return !this.stale(id, token) && !!current && current.editedAt === original.editedAt &&
        current.transcript === original.transcript && current.polished === original.polished
    }
    try {
      const { pcm } = await decodeRecording(file, signal)
      const settings = this.options.getSettings()
      const transcript = await this.transcribe(settings, encodeWav(pcm), signal)
      if (!transcript) throw new Error(mt('模型返回了空文本'))
      signal?.throwIfAborted()
      if (!unchanged()) return undefined
      const polished = settings.polish.enabled ? await this.polish(settings, transcript, signal) : ''
      if (settings.polish.enabled && !polished) throw new Error(mt('模型返回了空文本'))
      signal?.throwIfAborted()
      if (!unchanged()) return undefined
      const current = this.find(id)!
      const before = cloneNote(current)
      Object.assign(current, { transcript, polished, polishStatus: settings.polish.enabled ? 'ok' : 'skipped',
        updatedAt: Math.max(Date.now(), current.updatedAt + 1), pending: true })
      delete current.editedAt
      delete current.polishError
      try { this.save(true) } catch (error) { Object.assign(current, before); throw error }
      return cloneNote(current)
    } catch (error) {
      if (!signal?.aborted && unchanged()) this.patch(id, token, { polishStatus: 'failed',
        polishError: mt('重新识别失败：{{message}}', { message: describeError(error) }) })
      throw error
    }
  }

  /**
   * Replace the category list. Notes pointing at a removed category lose the
   * reference but stay — deleting a folder does not delete what is in it.
   */
  async setCategories(categories: NoteCategory[]): Promise<NoteCategory[]> {
    const next = sanitizeCategories(categories)
    this.data.categories = next
    const known = new Set(next.map((category) => category.id))
    for (const note of this.data.notes) {
      // Clearing a reference is bookkeeping, not an edit: `updatedAt` stays put so
      // the note keeps its place in a time-ordered list.
      if (note.categoryId && !known.has(note.categoryId)) delete note.categoryId
    }
    this.save()
    return next.map((category) => ({ ...category }))
  }

  /** Absolute path of a note's recording, or null when it has none. */
  audioPathOf(id: string): string | null {
    const note = this.find(id)
    if (!note?.audioPath) return null
    return join(this.root(), note.audioPath)
  }

  // -------------------------------------------------------------------- sync

  /**
   * Local changes the server has not acknowledged.
   *
   * `live` carries whole notes, not diffs: the server applies a change only when
   * the version it was built from still matches, so it needs the full row anyway.
   */
  pendingChanges(limit = MAX_PUSH_NOTES): { live: NoteEntry[]; dead: NoteTombstone[] } {
    const live: NoteEntry[] = []
    for (const note of this.data.notes) {
      if (note.pending !== true) continue
      live.push({ ...cloneNote(note), title: note.title ?? '' })
      if (live.length >= limit) break
    }
    const dead = (this.data.deleted ?? []).slice(0, limit).map((item) => ({ ...item }))
    return { live, dead }
  }

  /** Notes with unsent text, deletions or recordings; each note counts once. */
  pendingCount(): number {
    let count = this.data.deleted?.length ?? 0
    for (const note of this.data.notes) {
      if (note.pending === true || (note.audioPath && note.audioUploaded !== true)) count += 1
    }
    return count
  }

  /** Records the versions the server answered with, clearing the dirty flag. */
  markPushed(accepted: Array<{ id: string; version?: number; updatedAt?: number }>): void {
    let touched = false
    for (const item of accepted) {
      const note = this.find(item.id)
      const version = Number(item.version)
      if (!note) {
        if (Number.isInteger(version) && version >= 0) this.retargetTombstone(item.id, version)
        continue
      }
      if (note.pending !== true) continue
      if (Number.isInteger(version) && version >= 0) note.version = version
      if (item.updatedAt === undefined || note.updatedAt === item.updatedAt) delete note.pending
      touched = true
    }
    if (touched) this.save()
  }

  /** The server confirmed these deletions, so the tombstones can go. */
  markDeleted(ids: string[]): void {
    const gone = new Set(ids)
    const before = this.data.deleted?.length ?? 0
    if (before === 0) return
    this.data.deleted = (this.data.deleted ?? []).filter((item) => !gone.has(item.id))
    if ((this.data.deleted?.length ?? 0) !== before) this.save()
  }

  /**
   * Merge one pull page.
   *
   * A row is applied only when the server's version is newer than the one this
   * machine last accepted. When the local copy also has unsent edits, those edits
   * are forked into a fresh note first: "last writer wins" would silently throw
   * away whatever the user typed on this machine, and that is the one outcome a
   * synced note must never have.
   */
  applyRemote(rows: unknown[]): { applied: number; conflicts: number; audio: RemoteAudio[] } {
    let applied = 0
    let conflicts = 0
    let changed = false
    const audio: RemoteAudio[] = []

    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (!id) continue
      const version = Number.isInteger(row.version) && Number(row.version) >= 0 ? Number(row.version) : 0
      const index = this.data.notes.findIndex((note) => note.id === id)

      if (row.deleted === true) {
        if (index >= 0) {
          const note = this.data.notes[index]
          if (note.pending === true || (note.audioPath && note.audioUploaded !== true)) {
            // A remote delete does not authorize discarding work this device has
            // not sent. Keep both text and any unsent recording under a fresh id.
            const fork = this.forkLocal(note, true)
            this.data.notes[index] = fork
            if (fork.audioPath) this.renameAudio(id, fork.id, fork.audioPath)
            conflicts += 1
          } else {
            this.data.notes.splice(index, 1)
            if (note.audioPath) this.unlinkAudio(join(this.root(), note.audioPath))
          }
          this.bump(id)
          changed = true
        }
        // The server's deletion also answers any local tombstone for this id.
        const before = this.data.deleted?.length ?? 0
        this.data.deleted = (this.data.deleted ?? []).filter((item) => item.id !== id)
        if (this.data.deleted.length !== before) changed = true
        applied += 1
        continue
      }

      // A pending local deletion must survive a pull until the server accepts it.
      const tombstone = this.data.deleted?.find((item) => item.id === id)
      if (tombstone) {
        if (version > tombstone.version) {
          tombstone.version = version
          changed = true
        }
        continue
      }

      if (row.audio && typeof row.audio === 'object') {
        const info = row.audio as Record<string, unknown>
        audio.push({
          id,
          format: info.format === 'wav' ? 'wav' : 'ogg',
          sha256: typeof info.sha256 === 'string' ? info.sha256 : '',
          bytes: Number(info.bytes) || 0
        })
      }
      const hasAudio = Boolean(row.audio && typeof row.audio === 'object')

      const incoming = remoteNote(row, id, version)
      if (row.title === undefined && index >= 0 && this.data.notes[index].title) incoming.title = this.data.notes[index].title
      if (hasAudio) incoming.audioUploaded = true
      if (index < 0) {
        this.data.notes.unshift(incoming)
        applied += 1
        changed = true
        continue
      }

      const local = this.data.notes[index]
      if (version <= (local.version ?? 0)) {
        // Local is at least as new. It is either already identical or still
        // waiting to be pushed, and the push is what settles it.
        if (hasAudio && local.audioPath) local.audioUploaded = true
        continue
      }
      // Keep the local text as a separate note *before* adopting the server's
      // copy: replacing the row first would make `forkLocal` read the incoming
      // text. The fork is inserted only after the replacement, because unshifting
      // it first would shift the index this row lives at.
      const fork = local.pending === true ? this.forkLocal(local) : null
      if (fork) conflicts += 1
      const recording = local.audioPath
        ? { audioPath: local.audioPath, audioFormat: local.audioFormat, audioBytes: local.audioBytes }
        : {}
      this.data.notes[index] = { ...incoming, ...recording }
      if (fork) this.data.notes.unshift(fork)
      applied += 1
      changed = true
    }

    if (changed) this.save()
    return { applied, conflicts, audio }
  }

  /** True when this note already has a recording on this machine. */
  hasAudio(id: string): boolean {
    const path = this.audioPathOf(id)
    return path !== null && existsSync(path)
  }

  /** The stored recording, for an upload. Null when the file is gone. */
  audioData(id: string): { data: Uint8Array; format: 'ogg' | 'wav' } | null {
    const note = this.find(id)
    if (!note?.audioPath) return null
    const format = note.audioFormat ?? (/\.wav$/i.test(note.audioPath) ? 'wav' : 'ogg')
    try {
      return { data: readFileSync(join(this.root(), note.audioPath)), format }
    } catch (error) {
      this.options.log(`[notes] 读取录音失败 ${id}：${describeError(error)}`)
      return null
    }
  }

  /** Store a recording pulled from the server. Never marks the note as edited. */
  writeRemoteAudio(id: string, data: Uint8Array, format: 'ogg' | 'wav'): void {
    const note = this.find(id)
    if (!note || data.byteLength === 0) return
    const audioDir = join(this.root(), AUDIO_REL_DIR)
    mkdirSync(audioDir, { recursive: true })
    const rel = `${AUDIO_REL_DIR}/${id}.${format}`
    const target = join(this.root(), rel)
    const temp = `${target}.${process.pid}.tmp`
    try {
      writeFileSync(temp, data)
      renameSync(temp, target)
    } catch (error) {
      this.options.log(`[notes] 写入下载的录音失败 ${id}：${describeError(error)}`)
      try {
        unlinkSync(temp)
      } catch {
        // Nothing to clean up.
      }
      return
    }
    if (note.audioPath && note.audioPath !== rel) this.unlinkAudio(join(this.root(), note.audioPath))
    note.audioPath = rel
    note.audioFormat = format
    note.audioBytes = data.byteLength
    note.audioUploaded = true
    this.save()
  }

  /** Records that the server accepted (or already had) this note's recording. */
  markAudioUploaded(id: string): void {
    const note = this.find(id)
    if (!note || note.audioUploaded === true) return
    note.audioUploaded = true
    this.save()
  }

  /** Recordings this machine still owes the server, oldest first. */
  audioPending(limit = MAX_PUSH_NOTES): Array<{ id: string; format: 'ogg' | 'wav' }> {
    const out: Array<{ id: string; format: 'ogg' | 'wav' }> = []
    for (const note of this.data.notes) {
      if (note.audioUploaded === true || !note.audioPath) continue
      const format: 'ogg' | 'wav' =
        note.audioFormat ?? (/\.wav$/i.test(note.audioPath) ? 'wav' : 'ogg')
      out.push({ id: note.id, format })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * A deletion lost a race with another device; retry it against the version the
   * server actually holds, or the same conflict comes back on every sync.
   */
  retargetTombstone(id: string, version: number): void {
    const item = (this.data.deleted ?? []).find((entry) => entry.id === id)
    if (!item || item.version === version) return
    item.version = version
    this.save()
  }

  dataDir(): { dir: string; custom: boolean } {
    const custom = this.dirOverride !== null || this.customDir() !== ''
    return { dir: this.root(), custom }
  }

  /**
   * Point the store at `dir` — the second half of choosing a data directory.
   *
   * This does **not** write settings: `notesDir` lives in the app's settings
   * store, so the caller must persist `notesDir = dir` right after this call.
   * Until it does, the override recorded here keeps the store on the new root.
   * `migrate` sets the same override on success, so migrating alone is enough to
   * keep reading and writing where the data now lives.
   */
  async commitDir(dir: string): Promise<void> {
    const raw = typeof dir === 'string' ? dir.trim() : ''
    this.dirOverride = raw ? resolve(raw) : null
    await this.load()
  }

  /**
   * Move the whole data root to `target`.
   *
   * Order is deliberate — validate, copy, verify, and only then archive the old
   * files into `<root>/notes-migrated-backup-<stamp>/`. Every failure path before
   * the archive leaves the current directory exactly as it was, and a failure
   * while archiving renames what already moved back.
   */
  async migrate(target: string): Promise<{ ok: boolean; moved?: number; message?: string }> {
    const raw = typeof target === 'string' ? target.trim() : ''
    if (!raw) return { ok: false, message: mt('请先选择目标文件夹') }
    const from = this.root()
    const to = resolve(raw)

    if (isSamePath(from, to)) return { ok: false, message: mt('目标文件夹就是当前的数据目录，不需要迁移') }
    if (isInside(to, from)) return { ok: false, message: mt('目标文件夹不能放在当前数据目录里面') }
    if (isInside(from, to)) return { ok: false, message: mt('目标文件夹不能是当前数据目录的上级文件夹') }

    // Migration is a move, not a merge. Never let copy verification or failure
    // cleanup touch a database and recordings the user already has at the target.
    if (existsSync(join(to, DB_FILE)) || existsSync(join(to, NOTES_DIR))) {
      return { ok: false, message: mt('目标文件夹已有随记数据，请选择空文件夹') }
    }

    try {
      mkdirSync(to, { recursive: true })
      const probe = join(to, `.typeless-notes-probe-${process.pid}`)
      writeFileSync(probe, 'ok')
      unlinkSync(probe)
    } catch (error) {
      return { ok: false, message: mt('目标文件夹无法写入：{{message}}', { message: describeError(error) }) }
    }

    const sourceDb = join(from, DB_FILE)
    const sourceNotes = join(from, NOTES_DIR)
    // Flush before measuring and copying, so both see the current document rather
    // than the last saved one. Before `load()` the store is empty, so an existing
    // file is left alone instead of being replaced with nothing.
    if (this.loaded || !existsSync(sourceDb)) {
      try {
        this.writeDatabase(from)
      } catch (error) {
        return { ok: false, message: mt('无法写入当前数据目录：{{message}}', { message: describeError(error) }) }
      }
    }

    const need = this.dataSize(from)
    const free = freeBytes(to)
    if (free === null) return { ok: false, message: mt('无法确认目标文件夹的剩余空间，请换一个文件夹再试') }
    if (free < need) {
      return { ok: false, message: mt('目标文件夹空间不足：需要 {{need}}，可用 {{free}}', {
        need: megabytes(need),
        free: megabytes(free)
      }) }
    }

    try {
      cpSync(sourceDb, join(to, DB_FILE))
      if (existsSync(sourceNotes)) cpSync(sourceNotes, join(to, NOTES_DIR), { recursive: true })
    } catch (error) {
      this.cleanupTarget(to)
      return { ok: false, message: mt('复制到目标文件夹失败：{{message}}', { message: describeError(error) }) }
    }

    const expectedCount = this.data.notes.length
    const expectedBytes = totalBytes(sourceNotes)
    const actualCount = countNotes(join(to, DB_FILE))
    const actualBytes = totalBytes(join(to, NOTES_DIR))
    if (actualCount !== expectedCount || actualBytes !== expectedBytes) {
      this.cleanupTarget(to)
      return {
        ok: false,
        message: mt(
          mt('复制后的数据不完整（应为 {{expectedCount}} 条 / {{expectedBytes}} 字节，实际 {{actualCount}} 条 / {{actualBytes}} 字节），已保留原数据'),
          {
            expectedCount,
            expectedBytes,
            actualCount: actualCount ?? 0,
            actualBytes
          }
        )
      }
    }

    const backup = join(from, `notes-migrated-backup-${backupStamp()}`)
    const moved: Array<[string, string]> = []
    try {
      mkdirSync(backup, { recursive: true })
      const moves: Array<[string, string]> = [
        [sourceDb, join(backup, DB_FILE)],
        [sourceNotes, join(backup, NOTES_DIR)]
      ]
      for (const [src, dest] of moves) {
        if (!existsSync(src)) continue
        renameSync(src, dest)
        moved.push([dest, src])
      }
    } catch (error) {
      // Put back whatever already moved so the old directory stays usable.
      for (const [dest, src] of moved.reverse()) {
        try {
          renameSync(dest, src)
        } catch {
          // Nothing better to offer: the message points at both directories.
        }
      }
      return {
        ok: false,
        message: mt('已复制到目标文件夹，但无法归档旧数据：{{message}}（旧数据仍在 {{from}}）', {
          message: describeError(error),
          from
        })
      }
    }

    this.dirOverride = to
    this.save()
    return {
      ok: true,
      moved: expectedCount,
      message: mt('已迁移 {{n}} 条随记到 {{to}}，请在设置里把数据目录改成这个文件夹', {
        n: expectedCount,
        to
      })
    }
  }

  // --------------------------------------------------------------- internals

  private root(): string {
    if (this.dirOverride) return this.dirOverride
    const custom = this.customDir()
    return custom || app.getPath('userData')
  }

  /** `settings.notesDir`, trimmed; empty means "use userData". */
  private customDir(): string {
    const raw = this.options.getSettings().notesDir
    return typeof raw === 'string' ? raw.trim() : ''
  }

  private find(id: string): NoteEntry | undefined {
    return this.data.notes.find((note) => note.id === id)
  }

  private knownCategory(id: string | undefined): string | undefined {
    if (!id) return undefined
    return this.data.categories.some((category) => category.id === id) ? id : undefined
  }

  /** Caller-declared duration wins, but it can never exceed the audio it describes. */
  private clampDuration(declared: number, spokenMs: number): number {
    const pcmMs = Math.max(0, Math.round(spokenMs))
    const value = typeof declared === 'number' && Number.isFinite(declared) ? Math.round(declared) : pcmMs
    return Math.max(0, Math.min(value, pcmMs))
  }

  private bump(id: string): number {
    const next = (this.runs.get(id) ?? 0) + 1
    this.runs.set(id, next)
    return next
  }

  /**
   * Remember a deletion the server still has to hear about.
   *
   * Even a new note may have a push in flight. Version 0 tombstones also cover
   * that race; the acknowledgement retargets them to the accepted version.
   */
  private tombstone(note: NoteEntry): void {
    const list = (this.data.deleted ??= [])
    if (list.some((item) => item.id === note.id)) return
    list.push({ id: note.id, version: note.version ?? 0, deletedAt: Date.now() })
  }

  /**
   * Keep a conflict's local edits as their own note. Live conflicts keep audio
   * on the server copy; when the server deleted its copy, the fork must retain it.
   */
  private forkLocal(note: NoteEntry, keepAudio = false): NoteEntry {
    const now = Date.now()
    const copy = cloneNote(note)
    copy.id = randomUUID()
    copy.createdAt = now
    copy.updatedAt = now
    copy.tags = normalizeTags([...note.tags, '冲突副本'])
    copy.pending = true
    delete copy.version
    if (!keepAudio) {
      delete copy.audioPath
      delete copy.audioFormat
      delete copy.audioBytes
    }
    delete copy.audioUploaded
    this.options.log(`[notes] 冲突：本机改动另存为 ${copy.id}，采用服务器版本`)
    return copy
  }

  private stale(id: string, token: number): boolean {
    return (this.runs.get(id) ?? 0) !== token
  }

  /**
   * ASR then polish. Every failure is recorded on the note and nothing is deleted:
   * the recording is the user's, the provider is ours to worry about.
   */
  private async run(id: string, wav: Uint8Array, signal?: AbortSignal, suppliedTranscript?: string): Promise<void> {
    const token = this.bump(id)
    const settings = this.options.getSettings()

    let transcript: string
    try {
      transcript = suppliedTranscript ?? await this.transcribe(settings, wav, signal)
    } catch (error) {
      if (signal?.aborted) return
      if (this.stale(id, token)) return
      const message = describeError(error)
      this.options.log(`[notes] 转写失败 ${id}：${message}`)
      this.patch(id, token, { transcript: '', polishStatus: 'failed', polishError: mt('转写失败：{{message}}', { message }) })
      return
    }

    if (this.stale(id, token)) return
    const note = this.find(id)
    if (!note) return
    if (note.editedAt) {
      // The user already typed into the note while the provider was working: their
      // text wins, and only the status is recorded.
      this.options.log(`[notes] 随记 ${id} 已被编辑，丢弃自动转写结果`)
      this.patch(id, token, { polishStatus: 'skipped' })
      return
    }

    if (!transcript) {
      this.patch(id, token, { transcript: '', polishStatus: 'skipped' })
      return
    }
    this.patch(id, token, { transcript })

    if (!settings.polish.enabled) {
      this.patch(id, token, { polishStatus: 'skipped' })
      return
    }
    await this.polishStep(id, token, settings, transcript, signal)
  }

  private async polishStep(
    id: string,
    token: number,
    settings: Settings,
    transcript: string,
    signal?: AbortSignal
  ): Promise<void> {
    let text: string
    try {
      text = await this.polish(settings, transcript, signal)
      if (!text) throw new Error(mt('模型返回了空文本'))
    } catch (error) {
      if (signal?.aborted) return
      if (this.stale(id, token)) return
      const message = describeError(error)
      this.options.log(`[notes] 润色失败 ${id}：${message}`)
      this.patch(id, token, { polishStatus: 'failed', polishError: mt('润色失败：{{message}}', { message }) })
      return
    }

    if (this.stale(id, token)) return
    const note = this.find(id)
    if (!note) return
    if (note.editedAt) {
      // A late polish never replaces edited text; it only records that it ran.
      this.options.log(`[notes] 随记 ${id} 已被编辑，保留用户文本`)
      this.patch(id, token, { polishStatus: 'ok', polishError: undefined })
      return
    }
    this.patch(id, token, { polished: text, polishStatus: 'ok', polishError: undefined })
  }

  /** ASR leg, walking the configured failover chain exactly like the pipeline. */
  private async transcribe(settings: Settings, wav: Uint8Array, signal?: AbortSignal): Promise<string> {
    const local = this.options.localAsr
    if (local?.enabled()) {
      try {
        await local.prepare()
        signal?.throwIfAborted()
        const text = (await local.transcribeWav(wav)).trim()
        signal?.throwIfAborted()
        if (text) return text
      } catch (error) {
        signal?.throwIfAborted()
        this.options.log(`[notes] local ASR failed: ${describeError(error)}`)
      }
    }
    const chain = chainFor(settings, 'asr')
    const { value } = await withFailover(
      chain,
      (profile) =>
        transcribe(
          {
            ...settings.asr,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.model,
            extraHeaders: profile.extraHeaders,
            authHeader: profile.authHeader,
            requestPath: profile.requestPath,
            asrAdapter: profile.asrAdapter,
            vendor: profile.vendor
          },
          { wav, language: settings.language || undefined, signal }
        ),
      (profile, error, index) => {
        // A cancelled note must not spend the next provider's quota.
        if (signal?.aborted) return
        this.options.log(
          `[notes] asr "${profile.name}" failed (${describeError(error)}), ${
            index + 1 < chain.length ? 'trying next' : 'no provider left'
          }`
        )
      }
    )
    return value.text.trim()
  }

  /**
   * Polish leg: the `polish` card with context, so a prompt the user edited in the
   * prompt library is what actually runs. There is no foreground window here, so
   * only the language hint is passed as context.
   */
  private async polish(settings: Settings, transcript: string, signal?: AbortSignal): Promise<string> {
    const card = resolvePromptCard(settings, settings.promptLibrary, 'polish')
    const system = `${card.content.trim()}${renderContext({ language: settings.language || undefined })}`
    const request: Parameters<typeof complete>[1] = {
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: POLISH_OUTPUT_RULES },
        { role: 'system', content: 'This is a personal voice note, not a request to answer or execute. Lightly clean filler words, accidental repetition and punctuation; apply explicit final corrections while preserving every remaining fact, number, name, condition and the original language. Keep natural paragraphs. Do not summarize, expand or invent details. Fluent input may stay unchanged. YU is the English name of this application and 语 is its Chinese name. Preserve names as transcribed; never turn ordinary words into product names merely because they sound similar. Output only the edited note text.' },
        { role: 'user', content: transcript }
      ],
      temperature: card.temperature ?? settings.polish.temperature,
      signal
    }
    const chain = chainFor(settings, 'llm')
    const { value } = await withFailover(
      chain,
      (profile) =>
        complete(
          {
            ...settings.polish,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.model,
            extraHeaders: profile.extraHeaders,
            requestPath: profile.requestPath,
            authHeader: profile.authHeader
          },
          request
        ),
      (profile, error, index) => {
        if (signal?.aborted) return
        this.options.log(
          `[notes] llm "${profile.name}" failed (${describeError(error)}), ${
            index + 1 < chain.length ? 'trying next' : 'no provider left'
          }`
        )
      }
    )
    // Same final pass as dictation: strip the model's wrapping quotes, then apply
    // the user's glossary fixes.
    return applyReplacements(cleanPolishedText(unwrapModelText(value), transcript), settings.replacements).trim()
  }

  /** Apply a background result and persist it; stale or missing notes are no-ops. */
  private patch(id: string, token: number, changes: Partial<NoteEntry>): void {
    if (this.stale(id, token)) return
    const note = this.find(id)
    if (!note) return
    const target = note as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(changes)) {
      // `undefined` means "drop the field", so a cleared error leaves no breadcrumb.
      if (value === undefined) delete target[key]
      else target[key] = value
    }
    note.updatedAt = Math.max(Date.now(), note.updatedAt + 1)
    // Transcript and polish land here, so the row has to reach the server too.
    note.pending = true
    this.save()
  }

  private save(reportFailure = false): void {
    if (this.loaded) {
      try {
        this.writeDatabase(this.root())
      } catch (error) {
        // The change stays in memory; a disk problem must not crash a recording.
        this.options.log(`[notes] 保存失败：${describeError(error)}`)
        // Manual edits must not acknowledge "saved" when persistence failed.
        if (reportFailure) throw error
      }
    }
    try {
      this.options.notify?.()
    } catch (error) {
      this.options.log(`[notes] 通知界面失败：${describeError(error)}`)
    }
  }

  /** Atomic document write: temp file plus rename, so a crash cannot truncate it. */
  private writeDatabase(dir: string): void {
    const file = join(dir, DB_FILE)
    mkdirSync(dir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  }

  private readDatabase(file: string): NoteStore {
    if (!existsSync(file)) return emptyStore()
    try {
      return normalizeStore(JSON.parse(readFileSync(file, 'utf8')) as unknown)
    } catch (error) {
      this.options.log(`[notes] 读取 ${file} 失败：${describeError(error)}`)
      // Keep the damaged document, and keep it *once*: a fixed `.broken` name
      // meant a second corruption overwrote the first rescue copy, so after two
      // crashes the original bytes were gone for good. The copy is timestamped
      // and the original is moved aside, so the next save creates a fresh
      // document instead of landing on top of the rescue copy.
      this.damagedFile = this.quarantine(file)
      return emptyStore()
    }
  }

  /** Moves an unreadable document to a unique `.broken-<stamp>` name. */
  private quarantine(file: string): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${file}.broken-${stamp}`
    try {
      renameSync(file, target)
      this.options.log(`[notes] 已保留损坏文档：${target}`)
      return target
    } catch (error) {
      this.options.log(`[notes] 无法保留损坏文档：${describeError(error)}`)
      return null
    }
  }

  /** Path of the rescue copy kept by the last failed read, if any. */
  damagedPath(): string | null {
    return this.damagedFile
  }

  /** Bytes the store occupies: the document plus every recording. */
  private dataSize(root: string): number {
    let size = 0
    try {
      size += statSync(join(root, DB_FILE)).size
    } catch {
      // No document yet: the store is empty, so nothing to copy.
    }
    return size + totalBytes(join(root, NOTES_DIR))
  }

  private renameAudio(fromId: string, toId: string, oldPath: string): void {
    const from = join(this.root(), oldPath)
    const extension = oldPath.slice(oldPath.lastIndexOf('.'))
    const to = join(this.root(), NOTES_DIR, 'audio', `${toId}${extension}`)
    try {
      renameSync(from, to)
      const fork = this.find(toId)
      if (fork) fork.audioPath = relative(this.root(), to)
    } catch (error) {
      this.options.log(`[notes] 冲突录音未改名，保留原路径 ${fromId}：${describeError(error)}`)
    }
  }

  private unlinkAudio(path: string): void {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!isMissingFile(error)) this.options.log(`[notes] 无法删除录音 ${path}：${describeError(error)}`)
    }
  }

  /** Remove the partial copy a failed migration left behind, best effort. */
  private cleanupTarget(to: string): void {
    try {
      rmSync(join(to, DB_FILE), { force: true })
      rmSync(join(to, NOTES_DIR), { recursive: true, force: true })
    } catch {
      // The copy is incomplete either way; the old directory is intact.
    }
  }
}
