/**
 * Local schedule storage (`<userData>/calendar.json`).
 *
 * JSON, not SQLite, unlike `reminders.ts`: a schedule is small (hundreds of rows,
 * never millions), the user is expected to open and edit the file by hand, and
 * "把整个日程导出/备份" has to be one file. SQLite would buy us query speed we do
 * not need and cost us all three of those.
 *
 * Persistence follows `settings.ts`: write a sibling temp file, then `renameSync`,
 * so a crash mid-write leaves the previous document intact rather than half a
 * JSON object. A file we cannot parse is moved aside, never overwritten — it may
 * be the only copy of the user's schedule.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { mt } from '@shared/mainI18n'
import {
  DEFAULT_EVENT_LEAD_MINUTES,
  MAX_EVENTS,
  MAX_EVENT_LEAD_MINUTES,
  activeEvents,
  isCalendarRange,
  normalizeEventInput,
  overlaps,
  parseIcs,
  rangeFor,
  sortEvents,
  toIcs,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarRange,
  type EventStatus
} from '@shared/calendar'

const VERSION = 1
/** Re-arm at least this often: a long one-shot timer drifts by whole sleeps on Windows. */
const POLL_MS = 30_000
/** Past this, delivering "10 分钟后开始" is noise; the user can see the event started. */
const GRACE_MS = 5 * 60_000

interface CalendarFile {
  version: number
  events: CalendarEvent[]
}

/** Cheap structural check: a row that fails this makes the whole document suspect. */
function isStoredEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<CalendarEvent>
  return typeof row.id === 'string' && row.id.length > 0
    && typeof row.title === 'string'
    && Number.isFinite(row.start) && Number.isFinite(row.end)
    && typeof row.allDay === 'boolean'
    && Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt)
    && (row.status === 'confirmed' || row.status === 'cancelled')
    && (row.source === 'voice' || row.source === 'manual' || row.source === 'import')
}

/**
 * Identity the store mints for an imported event whose feed carries no `UID`.
 *
 * An event without a UID has no identity of its own, so "no uid" made every
 * refresh of the same feed look like a brand-new event: the calendar grew by one
 * row per pass until it hit MAX_EVENTS, and every duplicate fired its own
 * reminder. A hash of what the feed delivered is stable while that content is
 * stable — which is the deduplication the UID would have provided. The prefix
 * keeps a real UID from ever colliding with a minted one, and lets the merge tell
 * a row it owns from one the user created.
 */
const SYNTHETIC_UID_PREFIX = 'yu-fp:'

function fingerprintOf(input: { title: string; start: number; allDay?: boolean }): string {
  const payload = `${input.title}|${input.start}|${input.allDay === true ? 'all-day' : 'timed'}`
  return `${SYNTHETIC_UID_PREFIX}${createHash('sha1').update(payload).digest('hex')}`
}

function isSyntheticUid(uid: string | undefined): boolean {
  return typeof uid === 'string' && uid.startsWith(SYNTHETIC_UID_PREFIX)
}

export class CalendarStore {
  private events: CalendarEvent[] = []
  /** Path of the preserved unreadable document, when the last load found one. */
  private damagedCopy: string | undefined

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.load()
  }

  /** Where an unparseable file was moved to, so the UI can tell the user nothing was lost. */
  get damagedFile(): string | undefined {
    return this.damagedCopy
  }

  list(): CalendarEvent[] {
    return sortEvents(this.events)
  }

  active(): CalendarEvent[] {
    return activeEvents(this.list())
  }

  get(id: string): CalendarEvent | undefined {
    return this.events.find(row => row.id === id)
  }

  /**
   * Creates or edits one row.
   *
   * `options.fromSource` marks a write that came from a subscription feed rather
   * than from the user. A feed is allowed to move an event into `cancelled` (the
   * organiser withdrew it) but never to move it back out: a cancellation the user
   * made by voice or by hand is their decision, and a later confirmed copy of the
   * same uid must not resurrect it.
   */
  save(
    input: CalendarEventInput,
    id?: string,
    options: { fromSource?: boolean } = {}
  ): CalendarEvent {
    const existing = id ? this.get(id) : undefined
    if (id && !existing) throw new Error(mt('日程不存在'))
    const normalized = normalizeEventInput(input, this.now())
    if (!existing && this.events.length >= MAX_EVENTS) {
      throw new Error(mt('日程数量已达上限（{{count}} 条），请先取消不再需要的日程', { count: MAX_EVENTS }))
    }
    const at = this.now()
    // Moving an event must re-arm its reminder: keeping the old stamp would silence
    // the new time forever, which is the worst possible failure for a reminder.
    const rescheduled = existing !== undefined && existing.start !== normalized.start
    // Only the source's own rows may be cancelled by the source; a local row keeps
    // whatever the user decided, even if a feed happens to carry the same uid.
    const sourceCancels = options.fromSource === true
      && normalized.status === 'cancelled'
      && (existing === undefined || existing.source === 'import')
    const event: CalendarEvent = {
      id: existing?.id ?? randomUUID(),
      title: normalized.title,
      ...(normalized.notes === undefined ? {} : { notes: normalized.notes }),
      start: normalized.start,
      end: normalized.end,
      // normalizeEventInput always fills this in; the type keeps the input side optional.
      allDay: normalized.allDay === true,
      ...(normalized.location === undefined ? {} : { location: normalized.location }),
      ...(normalized.leadMinutes === undefined ? {} : { leadMinutes: normalized.leadMinutes }),
      // An edit keeps the origin it came from: an imported event stays recognisable after cleanup.
      source: existing?.source ?? normalized.source ?? 'voice',
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      // Editing a cancelled entry must not silently resurrect it; `action('restore')` does that.
      // The same rule makes an import unable to undo a local cancellation by changing the time.
      status: sourceCancels ? 'cancelled' : existing?.status ?? normalized.status ?? 'confirmed',
      ...((normalized.uid ?? existing?.uid) === undefined ? {} : { uid: normalized.uid ?? existing?.uid }),
      ...(existing?.notifiedAt === undefined || rescheduled ? {} : { notifiedAt: existing.notifiedAt })
    }
    this.flush(existing ? this.events.map(row => row.id === event.id ? event : row) : [...this.events, event])
    return event
  }

  action(id: string, action: 'cancel' | 'restore'): CalendarEvent {
    const row = this.get(id)
    if (!row) throw new Error(mt('日程不存在'))
    const status: EventStatus = action === 'cancel' ? 'cancelled' : 'confirmed'
    // Idempotent on purpose: a menu click and a voice command may both fire.
    if (row.status === status) return row
    const updated: CalendarEvent = { ...row, status, updatedAt: this.now() }
    this.flush(this.events.map(item => item.id === id ? updated : item))
    return updated
  }

  /**
   * Marks the pre-event reminder for this row as delivered.
   *
   * Touches only `notifiedAt` — not `updatedAt` — because a fired reminder is not a
   * user edit and must not reorder or relabel the row in the list. Ids that no
   * longer exist are ignored: the timer can race a `remove` in the same tick, and
   * that race must never break the scheduling chain.
   */
  markNotified(id: string, at: number): void {
    const row = this.get(id)
    if (!row || row.notifiedAt === at) return
    const updated: CalendarEvent = { ...row, notifiedAt: at }
    this.flush(this.events.map(item => item.id === id ? updated : item))
  }

  /**
   * Writes a row exactly as given, for remote rows and conflict copies.
   *
   * `save()` is the user-facing door: it mints ids, re-derives status and refuses
   * to move an event into the past. A row arriving from another device or from a
   * conflict copy has already been decided, so it needs the raw door — clamping it
   * through `save()` would silently change what the other device shows.
   */
  put(row: CalendarEvent): void {
    const exists = this.events.some(item => item.id === row.id)
    this.flush(exists ? this.events.map(item => item.id === row.id ? row : item) : [...this.events, row])
  }

  remove(id: string): void {
    const kept = this.events.filter(row => row.id !== id)
    if (kept.length !== this.events.length) this.flush(kept)
  }

  range(from: number, until: number): CalendarEvent[] {
    return this.list().filter(row => overlaps(row, from, until))
  }

  onDay(day: CalendarRange | string): CalendarEvent[] {
    if (isCalendarRange(day)) {
      const { from, until } = rangeFor(day, this.now())
      return this.range(from, until)
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!match) throw new Error(mt('日期格式无效'))
    const from = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime()
    // A day is not always 86_400_000 ms across a DST change, so step by local date.
    const next = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1, 0, 0, 0, 0).getTime()
    return this.range(from, next)
  }

  /**
   * Merges an ICS document into the store.
   *
   * Deduplication is by identity, because that is what two calendar apps share:
   * re-importing the same file must update rows rather than double them. A feed
   * that carries `UID` supplies the identity; one that does not gets a
   * fingerprint of the event's content, because "no uid" used to mean "a new
   * event on every refresh". Everything else already in the store (reminder
   * lead, location) is left alone — but the feed is authoritative about one
   * thing, `STATUS:CANCELLED`, so that has to be handed to `save`.
   */
  importIcs(text: string): { added: number; updated: number; skipped: number } {
    const inputs = parseIcs(text)
    // Exact identity first. A minted uid that no longer matches — the feed retitled
    // the event, so its fingerprint changed — then falls back to the slot it came
    // from: same start, same all-day flag, still an import row. Rows the user
    // created are never adopted by a feed, so a hand-made event cannot be
    // overwritten by a coincidence.
    const claimed = new Set<string>()
    const matchOne = (input: CalendarEventInput, identity: string): CalendarEvent | undefined => {
      const exact = this.events.find(row => !claimed.has(row.id) && row.uid === identity)
      if (exact) {
        claimed.add(exact.id)
        return exact
      }
      if (input.uid) return undefined
      const drifted = this.events.find(row =>
        !claimed.has(row.id)
        && row.source === 'import'
        && isSyntheticUid(row.uid)
        && row.start === input.start
        && row.allDay === input.allDay
      )
      if (drifted) claimed.add(drifted.id)
      return drifted
    }
    const pairs = inputs.map((input) => {
      const identity = input.uid ?? fingerprintOf(input)
      return { input, identity, existing: matchOne(input, identity) }
    })
    // Checked before the first write: a half-imported file is worse than a refused one.
    const additions = pairs.filter(pair => pair.existing === undefined).length
    if (this.events.length + additions > MAX_EVENTS) {
      throw new Error(mt('日程数量已达上限（{{count}} 条），请先取消不再需要的日程', { count: MAX_EVENTS }))
    }
    let added = 0
    let updated = 0
    for (const { input, identity, existing } of pairs) {
      if (existing) {
        this.save({
          title: input.title,
          notes: input.notes,
          start: input.start,
          end: input.end,
          allDay: input.allDay,
          location: existing.location,
          leadMinutes: existing.leadMinutes,
          source: existing.source,
          uid: identity,
          // A withdrawn meeting has to be able to stop looking confirmed; `save`
          // refuses the reverse (a confirmed copy cannot revive a cancellation).
          status: input.status
        }, existing.id, { fromSource: true })
        updated++
        continue
      }
      this.save({ ...input, source: 'import', uid: identity }, undefined, { fromSource: true })
      added++
    }
    return { added, updated, skipped: Math.max(0, countEventBlocks(text) - inputs.length) }
  }

  exportIcs(): string {
    return toIcs(this.active(), this.now())
  }

  /** Publish changes only after the atomic disk write succeeds. */
  flush(events: CalendarEvent[] = this.events): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    const payload: CalendarFile = { version: VERSION, events: sortEvents(events) }
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temp, this.file)
    this.events = events
  }

  private load(): void {
    this.events = []
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CalendarFile>
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events) || !parsed.events.every(isStoredEvent)) {
        throw new Error('unexpected calendar document shape')
      }
      this.events = parsed.events
    } catch (error) {
      // The file vanished between the exists check and the read: that is an empty
      // calendar, not a damaged one worth quarantining.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      this.quarantine(error)
    }
  }

  /** Moves an unparseable file aside instead of overwriting bytes we cannot read. */
  private quarantine(error: unknown): void {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
    const directory = dirname(this.file)
    const broken = join(directory, `${basename(this.file).replace(/\.json$/i, '')}.broken-${stamp}.json`)
    try {
      renameSync(this.file, broken)
      this.damagedCopy = broken
      console.error(`[calendar] damaged file kept at ${broken}`)
    } catch (renameError) {
      // A locked or read-only file still must not stop the app from starting.
      console.error('[calendar] cannot keep damaged calendar file:', renameError, error)
    }
    this.events = []
  }
}

/** BEGIN:VEVENT lines, so `importIcs` can report entries it had to skip. */
function countEventBlocks(text: string): number {
  let count = 0
  for (const line of String(text ?? '').split(/\r\n|\n|\r/)) if (/^BEGIN:VEVENT$/i.test(line.trim())) count++
  return count
}

export interface CalendarSchedulerDeps {
  store: CalendarStore
  settings: () => { defaultLeadMinutes: number } | { calendar?: { enabled: boolean; defaultLeadMinutes: number } }
  now?: () => number
  deliver: (event: CalendarEvent, at: number) => void
  log: (line: string) => void
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** An all-day event has no clock of its own, so its reminder hangs off this hour. */
const ALL_DAY_REMINDER_HOUR = 9

/**
 * Where the event "happens" as far as a reminder is concerned.
 *
 * An all-day row stores local midnight — subtracting a lead from that fired at 23:50
 * the night before, and the "already started" guard below would also have treated a
 * 09:00 reminder as stale two hours into the day. Both use this anchor instead.
 */
function reminderAnchor(event: Pick<CalendarEvent, 'start' | 'allDay'>): number {
  return event.allDay ? new Date(event.start).setHours(ALL_DAY_REMINDER_HOUR, 0, 0, 0) : event.start
}

/**
 * When this event's pre-reminder is due, or null when the event must stay silent.
 *
 * `leadMinutes: null` is the user's explicit "不提醒" and outranks the setting; a
 * lead longer than a day is clamped because a warning that fires before the event
 * was even created cannot be honoured. All-day rows hang off `reminderAnchor`, so a
 * 09:00 reminder still counts as "not started yet".
 */
function triggerFor(event: Pick<CalendarEvent, 'start' | 'allDay' | 'leadMinutes'>, defaultLeadMinutes: number): number | null {
  if (event.leadMinutes === null) return null
  const lead = typeof event.leadMinutes === 'number' && Number.isFinite(event.leadMinutes)
    ? event.leadMinutes
    : defaultLeadMinutes
  const minutes = Math.min(MAX_EVENT_LEAD_MINUTES, Math.max(0, lead))
  return reminderAnchor(event) - minutes * 60_000
}

/**
 * The "15 分钟后开会" reminder: one timer, rebuilt from the current clock on every
 * tick, exactly like `ReminderScheduler` and `briefing.ts`.
 *
 * Why re-arm instead of one long timer: Windows suspends timers while the machine
 * sleeps, so a 6-hour `setTimeout` fires hours late. A tick at most 30 seconds out
 * is cheap (a handful of rows) and self-corrects after sleep, clock changes and
 * timezone changes.
 *
 * `deliver` throwing is a normal case (the notification window is gone, the tray is
 * being torn down): it is logged and `notifiedAt` stays unset so the next tick
 * retries. A failed reminder must never kill the chain, or every later event in
 * the day goes silent too.
 */
export class CalendarScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: CalendarSchedulerDeps) {
    this.now = deps.now ?? Date.now
    // A custom `setTimer` must be paired with its own `clearTimer`; the defaults are the globals.
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.check()
  }

  stop(): void {
    this.running = false
    this.disarm()
  }

  check(): void {
    const now = this.now()
    const defaults = this.leadDefaults()
    let next = now + POLL_MS
    if (defaults.enabled) {
      for (const event of this.deps.store.active()) {
        const trigger = triggerFor(event, defaults.defaultLeadMinutes)
        if (trigger === null) continue
        // Long past its start: the user would be told about something that already
        // began, so the reminder is dropped rather than replayed.
        if (reminderAnchor(event) <= now - GRACE_MS) continue
        if (event.notifiedAt !== undefined) continue
        if (trigger > now) {
          next = Math.min(next, trigger)
          continue
        }
        try {
          this.deps.deliver(event, trigger)
          this.deps.store.markNotified(event.id, trigger)
        } catch (error) {
          // Deliberately no `markNotified`: the next tick retries the same event.
          this.deps.log(`[calendar] reminder for ${event.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    this.arm(next - now)
  }

  /** The nearest trigger that has not fired yet, for the diagnostics panel. */
  status(): { nextAt: number | null } {
    const defaults = this.leadDefaults()
    if (!defaults.enabled) return { nextAt: null }
    const now = this.now()
    let nextAt: number | null = null
    for (const event of this.deps.store.active()) {
      if (event.notifiedAt !== undefined || reminderAnchor(event) <= now - GRACE_MS) continue
      const trigger = triggerFor(event, defaults.defaultLeadMinutes)
      if (trigger === null) continue
      if (nextAt === null || trigger < nextAt) nextAt = trigger
    }
    return { nextAt }
  }

  private arm(delay: number): void {
    this.disarm()
    if (!this.running) return
    const handle = this.setTimer(() => {
      this.timer = null
      // A callback queued before stop() must not restart the chain.
      if (!this.running) return
      this.check()
    }, Math.max(1, Math.min(delay, POLL_MS)))
    this.timer = handle
    // Never hold the process open for a reminder.
    handle.unref?.()
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  /** Accepts both `{ defaultLeadMinutes }` and `{ calendar: {...} }`, the two shapes settings uses. */
  private leadDefaults(): { enabled: boolean; defaultLeadMinutes: number } {
    const value = this.deps.settings() as {
      defaultLeadMinutes?: number
      calendar?: { enabled?: boolean; defaultLeadMinutes?: number }
    }
    const nested = value?.calendar
    const lead = nested?.defaultLeadMinutes ?? value?.defaultLeadMinutes
    return {
      enabled: nested?.enabled ?? true,
      defaultLeadMinutes: typeof lead === 'number' && Number.isFinite(lead) ? lead : DEFAULT_EVENT_LEAD_MINUTES
    }
  }
}
