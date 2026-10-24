/**
 * Two-way reminder/task sync against the self-hosted server.
 *
 * The protocol is the one the notes sync already uses: a monotonically growing
 * `seq` as the pull cursor, tombstones instead of deletes, and one batch push per
 * pass. The reminder has one extra wrinkle — the server stores the client row
 * verbatim in a `data` column, because a reminder carries a recurrence rule, a
 * deadline, a snooze and a delivery stamp that the sync must not reinterpret.
 * Reading `data` back means a row that lands on another machine looks exactly like
 * the row that left this one, instead of degrades to "a title and a time".
 *
 * Conflict rule: **the server wins, the local row is kept as a copy.** Same
 * bargain as the calendar: a task the user wrote on a plane is still a task they
 * wrote, so it becomes a second row rather than silently disappearing.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mt } from '@shared/mainI18n'
import type { Reminder, ReminderLevel, ReminderRecurrence, ReminderStatus, TodoPriority } from '@shared/reminders'
import { isTodoPriority } from '@shared/reminders'

/** Matches the server's MAX_PUSH so one pass never builds a batch it would refuse. */
const PAGE = 200
const MAX_PAGES = 50
/** The server rejects a longer title outright; truncating beats failing the batch. */
const MAX_TITLE = 300

const LEVELS: readonly ReminderLevel[] = ['normal', 'strong']
const STATUSES: readonly ReminderStatus[] = ['pending', 'due', 'completed', 'cancelled']

export interface ReminderChange {
  id: string
  title: string
  dueAt: number | null
  level: ReminderLevel
  priority: TodoPriority
  deadlineAt: number | null
  recurrence: ReminderRecurrence | null
  status: ReminderStatus
  updatedAt: number
  /** The row as this machine knows it, so the other machine reads it back whole. */
  data?: Record<string, unknown> | null
  deletedAt?: number
}

export interface ReminderPushResult {
  applied?: string[]
  duplicates?: string[]
  conflicts?: Array<{ id?: string; error?: string }>
  cursor?: number
}

export interface ReminderPage {
  cursor: number
  reminders: unknown[]
  hasMore: boolean
}

/** The transport this module needs from `CloudClient`; declared here to avoid a cycle. */
export interface ReminderRemote {
  pushReminders(changes: unknown[]): Promise<{ status: number; payload: ReminderPushResult }>
  pullReminders(since: number, limit: number): Promise<ReminderPage>
}

/**
 * The slice of `ReminderStore` this module needs.
 *
 * `put` is the one addition: `save()` refuses a row whose time is already past
 * ("请选择将来的提醒时间"), and a remote row can legitimately be overdue when the
 * machine wakes up, so merging it through `save()` would drop exactly the tasks
 * the user most needs to see.
 */
export interface ReminderSyncStore {
  list(): Reminder[]
  remove(id: string): void
  put(row: Reminder): void
}

export interface ReminderSyncOptions {
  store: ReminderSyncStore
  /** Where the cursor and the confirmed signatures live. One file per resource. */
  file: string
  log: (line: string) => void
  now?: () => number
}

interface ReminderSyncState {
  /** Server `seq` of the newest reminder row this machine has pulled. */
  cursor: number
  /** id → content signature the server has confirmed. */
  pushed: Record<string, string>
  /** ids seen locally on the last scan, so a disappearance can become a tombstone. */
  shown: string[]
  /** ids deleted locally that the server has not acknowledged yet → deletedAt. */
  tombstones: Record<string, number>
}

function emptyState(): ReminderSyncState {
  return { cursor: 0, pushed: {}, shown: [], tombstones: {} }
}

/**
 * The user-owned content of a task, as one comparable string.
 *
 * Alerting state is deliberately left out: `deliveredAt`, `snoozedUntil`, `missedAt`
 * and `updatedAt` change while the user edits nothing, so counting them would push
 * every task on every pass. `status` stays in, because completing a task on the
 * phone is exactly the change the laptop has to hear about.
 */
function signature(row: Reminder): string {
  return JSON.stringify([
    row.title,
    row.description ?? null,
    row.dueAt,
    row.deadlineAt ?? null,
    row.priority,
    row.level,
    row.recurrence ?? null,
    row.status,
    row.source,
    row.noteId ?? null
  ])
}

function toChange(row: Reminder): ReminderChange {
  return {
    id: row.id,
    title: row.title.slice(0, MAX_TITLE),
    dueAt: row.dueAt,
    level: row.level,
    priority: row.priority,
    deadlineAt: row.deadlineAt,
    recurrence: row.recurrence,
    status: row.status,
    updatedAt: row.updatedAt,
    // The whole row: the receiving machine reads it back without guessing which
    // fields were worth keeping.
    data: row as unknown as Record<string, unknown>
  }
}

/** A 404 means this server predates the reminder routes; retrying cannot help. */
function isUnsupported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && Number((err as { status?: unknown }).status) === 404
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asStamp(value: unknown, fallback: number): number {
  const stamp = Number(value)
  return Number.isFinite(stamp) ? stamp : fallback
}

function asOptionalStamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const stamp = Number(value)
  return Number.isFinite(stamp) ? stamp : undefined
}

/** A recurrence rule crosses the wire as JSON; anything unshaped is dropped. */
function asRecurrence(value: unknown): ReminderRecurrence | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (raw.frequency !== 'daily' && raw.frequency !== 'weekly') return null
  const hour = Number(raw.hour)
  const minute = Number(raw.minute)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  const weekdays = Array.isArray(raw.weekdays)
    ? raw.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    : undefined
  return { frequency: raw.frequency, hour, minute, ...(weekdays ? { weekdays } : {}) }
}

/** One change plus the signature it was built from, so acceptance can be recorded. */
interface ScanEntry {
  id: string
  signature: string
  change: ReminderChange
  /** Set for a tombstone: the stamp the server should keep. */
  tombstone?: number
}

export class RemindersSync {
  private state: ReminderSyncState
  /** Server URL that answered 404 for the reminder routes, so we stop asking it. */
  private unsupportedServer = ''

  constructor(private readonly options: ReminderSyncOptions) {
    this.state = this.readState()
  }

  /** How many rows the next pass would push, for the status view. */
  pendingCount(): number {
    const rows = this.options.store.list()
    const live = new Set(rows.map((row) => row.id))
    const pending = new Set<string>()
    for (const row of rows) if (this.state.pushed[row.id] !== signature(row)) pending.add(row.id)
    for (const id of Object.keys(this.state.tombstones)) if (!live.has(id)) pending.add(id)
    // A deletion is not a tombstone until `scan()` has seen it, but the counter is
    // read by the UI between passes, so it has to predict that transition itself.
    for (const id of this.state.shown) {
      if (!live.has(id) && this.state.pushed[id] !== undefined) pending.add(id)
    }
    return pending.size
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private readState(): ReminderSyncState {
    if (!existsSync(this.options.file)) return emptyState()
    try {
      const parsed = JSON.parse(readFileSync(this.options.file, 'utf8')) as Partial<ReminderSyncState>
      return {
        cursor: Number(parsed.cursor) > 0 ? Math.trunc(Number(parsed.cursor)) : 0,
        pushed: parsed.pushed && typeof parsed.pushed === 'object' ? parsed.pushed : {},
        shown: Array.isArray(parsed.shown) ? parsed.shown.filter((id): id is string => typeof id === 'string') : [],
        tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : {}
      }
    } catch (err) {
      // A damaged file costs one re-push, which the server answers as duplicates.
      this.options.log(mt('提醒同步状态无法读取，已从零开始：{{reason}}', { reason: describe(err) }))
      return emptyState()
    }
  }

  private writeState(): void {
    const temp = `${this.options.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temp, this.options.file)
    } catch (err) {
      this.options.log(mt('提醒同步状态无法写入：{{reason}}', { reason: describe(err) }))
    }
  }

  /**
   * One push+pull pass.
   *
   * Push first: a row the server has never seen has to exist before its deletion
   * can mean anything. A 404 is remembered and skipped (an older server); any
   * other error is rethrown so the engine can surface it as `lastError`.
   */
  async run(remote: ReminderRemote, serverUrl: string): Promise<{ pushed: number; pulled: number }> {
    if (serverUrl && this.unsupportedServer === serverUrl) return { pushed: 0, pulled: 0 }
    try {
      const pushed = await this.push(remote)
      const pulled = await this.pull(remote)
      return { pushed, pulled }
    } catch (err) {
      if (isUnsupported(err)) {
        this.unsupportedServer = serverUrl
        this.options.log(mt('当前服务器不支持提醒同步，已跳过'))
        return { pushed: 0, pulled: 0 }
      }
      throw err
    }
  }

  /** Sends what changed locally; returns how many rows the server accepted. */
  private async push(remote: ReminderRemote): Promise<number> {
    const entries = this.scan()
    if (entries.length === 0) return 0
    let accepted = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const slice = entries.slice(page * PAGE, (page + 1) * PAGE)
      if (slice.length === 0) break
      const result = await remote.pushReminders(slice.map((entry) => entry.change))
      const payload: ReminderPushResult = result.payload ?? {}
      const done = new Set([...(payload.applied ?? []), ...(payload.duplicates ?? [])])
      for (const entry of slice) {
        if (!done.has(entry.id)) continue
        if (entry.tombstone !== undefined) delete this.state.tombstones[entry.id]
        else this.state.pushed[entry.id] = entry.signature
        accepted += 1
      }
      // 409 means the id belongs to another account. Nothing to merge, nothing to
      // retry, so it is recorded as delivered rather than failing every pass.
      for (const conflict of payload.conflicts ?? []) {
        const id = String(conflict.id ?? '')
        if (!id) continue
        this.options.log(mt('提醒 {{id}} 被服务器拒绝：{{reason}}', { id, reason: conflict.error ?? 'conflict' }))
        const entry = slice.find((item) => item.id === id)
        if (entry?.tombstone !== undefined) delete this.state.tombstones[id]
        else if (entry) this.state.pushed[id] = entry.signature
        accepted += 1
      }
      this.writeState()
      if (slice.length < PAGE) break
    }
    return accepted
  }

  /** Merges everything the server changed since the cursor. */
  private async pull(remote: ReminderRemote): Promise<number> {
    let cursor = this.state.cursor
    let applied = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await remote.pullReminders(cursor, PAGE)
      const rows = Array.isArray(result.reminders) ? result.reminders : []
      // One store read per page rather than per row: `list()` opens and sorts the
      // whole table, and a page carries 200 rows.
      const local = new Map(this.options.store.list().map((row) => [row.id, row]))
      for (const row of rows) if (this.applyRemoteRow(row, local)) applied += 1
      const next = Number(result.cursor)
      // Never backwards: a server that answers with an older cursor (a restored
      // backup) must not make us replay a tombstone over a newer local edit.
      if (Number.isFinite(next) && next > cursor) cursor = next
      this.state.cursor = cursor
      this.writeState()
      if (!result.hasMore || rows.length === 0) break
    }
    return applied
  }

  /**
   * One remote row in.
   *
   * Returns whether the local table actually changed, so the log line counts edits
   * rather than echoes of our own push.
   */
  private applyRemoteRow(row: unknown, local: Map<string, Reminder>): boolean {
    const raw = asRecord(row)
    if (!raw) return false
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!id) return false
    const existing = local.get(id)
    const deleted = raw.deleted === true || Number(raw.deletedAt) > 0

    if (deleted) {
      if (!existing) {
        this.forget(id)
        return false
      }
      if (this.isDirty(existing)) this.keepCopy(existing, local)
      this.options.store.remove(id)
      local.delete(id)
      this.forget(id)
      return true
    }

    const remote = this.readRow(raw, existing)
    if (!remote) {
      this.options.log(mt('收到一条无法解析的提醒，已跳过'))
      return false
    }
    const remoteSignature = signature(remote)
    if (existing && signature(existing) === remoteSignature) {
      this.state.pushed[id] = remoteSignature
      return false
    }
    // Only content the server has never confirmed is worth a copy. The push runs
    // before the pull, so a row it delivered is already on the server and an
    // incoming row for the same id is simply newer — adopting it loses nothing.
    // What is left is content this machine could not deliver (a state file it read
    // back blank, a batch the server did not take).
    if (existing && this.isDirty(existing)) this.keepCopy(existing, local)
    this.options.store.put(remote)
    local.set(id, remote)
    this.state.pushed[id] = remoteSignature
    return true
  }

  /**
   * A server row as a local `Reminder`.
   *
   * Columns win where the two disagree: they are the ones a tombstone clears and
   * the ones a future server version can filter on. `data` fills in everything the
   * schema does not carry (description, source, snooze, delivery stamp).
   */
  private readRow(raw: Record<string, unknown>, existing: Reminder | undefined): Reminder | null {
    const id = String(raw.id)
    const data = asRecord(raw.data) ?? {}
    const title = typeof data.title === 'string' && data.title ? data.title : String(raw.title ?? '')
    if (!title) return null
    const at = this.now()
    const dueAt = raw.dueAt === null || raw.dueAt === undefined ? null : asStamp(raw.dueAt, 0)
    const deadlineAt = raw.deadlineAt === null || raw.deadlineAt === undefined ? null : asStamp(raw.deadlineAt, 0)
    const level = LEVELS.includes(data.level as ReminderLevel) ? (data.level as ReminderLevel) : (raw.level === 'strong' ? 'strong' : 'normal')
    const priority = isTodoPriority(data.priority)
      ? data.priority
      : isTodoPriority(raw.priority)
        ? raw.priority
        : 'normal'
    const status = STATUSES.includes(raw.status as ReminderStatus)
      ? (raw.status as ReminderStatus)
      : STATUSES.includes(data.status as ReminderStatus)
        ? (data.status as ReminderStatus)
        : 'pending'
    const source = data.source === 'voice' || data.source === 'note' ? data.source : 'manual'
    return {
      id,
      title,
      dueAt,
      deadlineAt,
      level,
      priority,
      status,
      recurrence: asRecurrence(raw.recurrence) ?? asRecurrence(data.recurrence),
      source,
      ...(typeof data.description === 'string' && data.description ? { description: data.description } : {}),
      ...(typeof data.noteId === 'string' && data.noteId ? { noteId: data.noteId } : {}),
      ...(typeof data.timeExpression === 'string' && data.timeExpression
        ? { timeExpression: data.timeExpression }
        : {}),
      ...(asOptionalStamp(data.snoozedUntil) !== undefined ? { snoozedUntil: Number(data.snoozedUntil) } : {}),
      ...(asOptionalStamp(data.lastCompletedAt) !== undefined
        ? { lastCompletedAt: Number(data.lastCompletedAt) }
        : {}),
      ...(asOptionalStamp(data.missedAt) !== undefined ? { missedAt: Number(data.missedAt) } : {}),
      ...(asOptionalStamp(data.missedAcknowledgedAt) !== undefined
        ? { missedAcknowledgedAt: Number(data.missedAcknowledgedAt) }
        : {}),
      createdAt: asStamp(data.createdAt, existing?.createdAt ?? at),
      updatedAt: asStamp(raw.updatedAt, at),
      deliveredAt: asOptionalStamp(data.deliveredAt) ?? existing?.deliveredAt ?? null
    }
  }

  private isDirty(row: Reminder): boolean {
    return this.state.pushed[row.id] !== signature(row)
  }

  /**
   * Keeps the local version of a clashing row by saving it as a second task.
   *
   * `put` rather than `save`: the copy inherits a time that may already be past,
   * and `save` would refuse it — which is how a conflict would swallow the user's
   * work instead of preserving it.
   */
  private keepCopy(row: Reminder, local: Map<string, Reminder>): void {
    const copy: Reminder = {
      ...row,
      id: randomUUID(),
      title: mt('{{title}}（冲突副本）', { title: row.title.slice(0, 280) })
    }
    try {
      this.options.store.put(copy)
      local.set(copy.id, copy)
      this.options.log(mt('提醒《{{title}}》被其他设备修改，本机改动已另存', { title: row.title }))
    } catch (err) {
      this.options.log(mt('提醒《{{title}}》的本机改动无法另存：{{reason}}', {
        title: row.title,
        reason: describe(err)
      }))
    }
  }

  /** Drops the bookkeeping for an id that no longer exists on either side. */
  private forget(id: string): void {
    delete this.state.pushed[id]
    delete this.state.tombstones[id]
    this.state.shown = this.state.shown.filter((item) => item !== id)
  }

  /**
   * Everything to push: changed rows, plus tombstones for rows that vanished.
   *
   * A disappearance only counts as a deletion if the server had seen the row;
   * otherwise the user created and removed it between two passes and no one else
   * needs to hear about it.
   */
  private scan(): ScanEntry[] {
    const rows = this.options.store.list()
    const live = new Map(rows.map((row) => [row.id, row]))
    const now = this.now()
    for (const id of this.state.shown) {
      if (live.has(id)) continue
      if (this.state.pushed[id] === undefined) continue
      this.state.tombstones[id] = now
      delete this.state.pushed[id]
    }
    this.state.shown = rows.map((row) => row.id)

    const entries: ScanEntry[] = []
    for (const row of rows) {
      const sig = signature(row)
      if (this.state.pushed[row.id] === sig) continue
      entries.push({ id: row.id, signature: sig, change: toChange(row) })
    }
    for (const [id, deletedAt] of Object.entries(this.state.tombstones)) {
      entries.push({
        id,
        signature: '',
        tombstone: deletedAt,
        change: {
          id,
          title: '',
          dueAt: null,
          level: 'normal',
          priority: 'normal',
          deadlineAt: null,
          recurrence: null,
          status: 'cancelled',
          updatedAt: deletedAt,
          data: null,
          deletedAt
        }
      })
    }
    return entries
  }
}
