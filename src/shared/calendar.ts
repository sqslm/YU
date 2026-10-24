/**
 * The local-calendar contract shared by the main process, the renderer and the
 * voice pipeline.
 *
 * Everything here is data plus pure helpers: no `fs`, no `electron`, no network.
 * The store lives in `main/calendar.ts`, the UI only ever sees these shapes.
 *
 * Two decisions are baked into this file and are worth knowing before changing it:
 *
 * 1. Time is stored as epoch milliseconds and interpreted in the *local* zone.
 *    A schedule that says "10:00 开会" must still read 10:00 after a flight, so a
 *    stored event is never converted to UTC.
 * 2. ICS is the interchange format, not the storage format. Dates written by
 *    `toIcs` are floating local times (no `Z`) because Outlook and Google then
 *    show them at whatever clock the reader is on — the intuitive reading of a
 *    calendar entry the user typed in their own zone.
 */
import { mt } from './mainI18n'

export const MAX_EVENT_TITLE = 200
export const MAX_EVENT_NOTES = 2000
export const MAX_EVENTS = 2000
export const MAX_EVENT_LEAD_MINUTES = 1440
export const DEFAULT_EVENT_LEAD_MINUTES = 10

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const CRLF = '\r\n'
/** RFC 5545 caps a physical line at 75 octets; 73 leaves room for the fold marker. */
const FOLD_OCTETS = 73

export type EventStatus = 'confirmed' | 'cancelled'

export interface CalendarSettings {
  enabled: boolean
  defaultLeadMinutes: number
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = { enabled: true, defaultLeadMinutes: DEFAULT_EVENT_LEAD_MINUTES }

export interface CalendarEvent {
  id: string
  title: string
  notes?: string
  start: number
  end: number
  allDay: boolean
  location?: string
  /** null = 明确不提醒；undefined = 用设置里的默认值 */
  leadMinutes?: number | null
  source: 'voice' | 'manual' | 'import'
  createdAt: number
  updatedAt: number
  status: EventStatus
  /** ICS 的 UID，用于导入去重 */
  uid?: string
  /** 提前提醒已投递的时刻（= 计划触发时刻），用于去重；改期时会被清掉 */
  notifiedAt?: number
}

export interface CalendarEventInput {
  title: string
  notes?: string
  start: number
  end: number
  allDay?: boolean
  location?: string
  leadMinutes?: number | null
  source?: 'voice' | 'manual' | 'import'
  uid?: string
  /** 导入时携带：ICS 里被取消的事件落库后仍是 cancelled，而不是复活成普通事件 */
  status?: EventStatus
}

export type CalendarRange = 'today' | 'tomorrow' | 'week' | 'upcoming' | 'yesterday' | 'month'

const RANGES: readonly CalendarRange[] = ['today', 'tomorrow', 'yesterday', 'week', 'upcoming', 'month']

export function isCalendarRange(value: string): value is CalendarRange {
  return (RANGES as readonly string[]).includes(value)
}

/**
 * Local midnight of `at`.
 *
 * `setHours` rather than modulo arithmetic: a day is not always 86_400_000 ms in
 * a zone with daylight saving, and the calendar day the user sees is what the
 * ranges must follow.
 */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Day arithmetic on local components, for the same DST reason as `startOfLocalDay`. */
function shiftDays(at: number, days: number): number {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function rangeFor(range: CalendarRange, now: number): { from: number; until: number } {
  const today = startOfLocalDay(now)
  switch (range) {
    case 'today':
      return { from: today, until: shiftDays(today, 1) }
    case 'tomorrow':
      return { from: shiftDays(today, 1), until: shiftDays(today, 2) }
    case 'yesterday':
      return { from: shiftDays(today, -1), until: today }
    case 'week': {
      // Monday-first: getDay() puts Sunday at 0, so Sunday lands on offset 6.
      const offset = (new Date(today).getDay() + 6) % 7
      return { from: shiftDays(today, -offset), until: shiftDays(today, 7 - offset) }
    }
    case 'upcoming':
      return { from: now, until: now + 7 * DAY }
    // The whole grid the month view paints, which starts on the Monday before the
    // 1st and ends after the last week: a dot for the 1st has to be visible while
    // the user is looking at the trailing days of the previous month.
    case 'month': {
      const cursor = new Date(today)
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
      const offset = (first.getDay() + 6) % 7
      const from = shiftDays(first.getTime(), -offset)
      return { from, until: shiftDays(from, 42) }
    }
  }
}

/** Half-open intervals, so a multi-day event is found by every day it touches. */
export function overlaps(event: Pick<CalendarEvent, 'start' | 'end'>, from: number, until: number): boolean {
  return event.start < until && event.end > from
}

export function activeEvents(rows: readonly CalendarEvent[]): CalendarEvent[] {
  return rows.filter(row => row.status === 'confirmed')
}

/** New array, start ascending; `createdAt` keeps the order stable for same-start rows. */
export function sortEvents(rows: readonly CalendarEvent[]): CalendarEvent[] {
  return [...rows].sort((left, right) =>
    left.start - right.start || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}

export function localDayKey(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatEventTime(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>, language: 'zh' | 'en'): string {
  if (event.allDay) return language === 'zh' ? mt('全天') : 'All day'
  const clock = (at: number): string => {
    const date = new Date(at)
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
  // En dash, not a hyphen: the two endpoints read as one range, like every OS calendar.
  return `${clock(event.start)}–${clock(event.end)}`
}

/**
 * Coerces whatever a model, a form or an ICS file produced into a storable event.
 *
 * Runs before any write: a title of only spaces, a backwards range or a lead time
 * of three days are all normal model output, and none of them may reach the file.
 */
export function normalizeEventInput(input: CalendarEventInput, now: number): CalendarEventInput {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Error(mt('请提供日程标题'))
  const allDay = Boolean(input.allDay)
  let start = Number.isFinite(input.start) ? input.start : now
  if (allDay) start = startOfLocalDay(start)
  let end = Number.isFinite(input.end) ? input.end : start + (allDay ? DAY : HOUR)
  // An all-day event is exactly one local day; a stray end from a parser cannot widen it.
  if (allDay) end = start + DAY
  if (end <= start) end = start + (allDay ? DAY : HOUR)
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, MAX_EVENT_NOTES) : undefined
  const location = typeof input.location === 'string' && input.location.trim() ? input.location.trim() : undefined
  const uid = typeof input.uid === 'string' && input.uid.trim() ? input.uid.trim() : undefined
  let leadMinutes: number | null | undefined
  if (input.leadMinutes === null) leadMinutes = null
  else if (typeof input.leadMinutes === 'number' && Number.isFinite(input.leadMinutes)) {
    leadMinutes = Math.min(MAX_EVENT_LEAD_MINUTES, Math.max(0, Math.round(input.leadMinutes)))
  }
  return {
    title: title.slice(0, MAX_EVENT_TITLE),
    ...(notes === undefined ? {} : { notes }),
    start,
    end,
    allDay,
    ...(location === undefined ? {} : { location }),
    ...(leadMinutes === undefined ? {} : { leadMinutes }),
    source: input.source ?? 'voice',
    ...(uid === undefined ? {} : { uid }),
    // Cancellation arrives only from an importer; a form or a model never sets it.
    ...(input.status === undefined ? {} : { status: input.status })
  }
}

function escapeText(value: string): string {
  // Backslash first: the escapes we insert below must not be escaped again.
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_all, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char)
}

function utcStamp(at: number): string {
  const date = new Date(at)
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`
    + `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
}

/** Floating local time — deliberately no `Z`, see the file header. */
function localStamp(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function dateStamp(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

/** UTF-8 length of one code point; `Buffer` is unavailable to the renderer build. */
function octetsOf(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

function utf8Length(text: string): number {
  let total = 0
  for (const char of text) total += octetsOf(char.codePointAt(0) ?? 0)
  return total
}

/**
 * RFC 5545 folding by UTF-8 octets.
 *
 * Iterating code points (not bytes, not `slice`) is what keeps a Chinese title
 * from being cut in half: the tail of a split surrogate pair is not valid UTF-8
 * and the receiving calendar would drop the whole property.
 */
function foldLine(line: string): string {
  if (utf8Length(line) <= FOLD_OCTETS) return line
  const parts: string[] = []
  let current = ''
  let octets = 0
  for (const char of line) {
    const size = octetsOf(char.codePointAt(0) ?? 0)
    if (octets + size > FOLD_OCTETS) {
      parts.push(current)
      // The leading space of a continuation line counts towards the octet budget.
      current = ' '
      octets = 1
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join(CRLF)
}

/**
 * Renders events as an ICS document.
 *
 * Cancelled rows are included with `STATUS:CANCELLED` on purpose: exporting the
 * user's own calendar must be able to retract an event in the calendar it was
 * imported into. `CalendarStore.exportIcs` decides what the user gets.
 */
export function toIcs(rows: readonly CalendarEvent[], now: number = Date.now()): string {
  const stamp = utcStamp(now)
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//YU//Calendar//ZH', 'CALSCALE:GREGORIAN']
  for (const event of rows) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${event.uid ?? event.id}`)
    lines.push(`DTSTAMP:${stamp}`)
    if (event.allDay) {
      // DTEND of an all-day event is the exclusive next midnight, never start + 0.
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(event.start)}`)
      lines.push(`DTEND;VALUE=DATE:${dateStamp(event.end)}`)
    } else {
      lines.push(`DTSTART:${localStamp(event.start)}`)
      lines.push(`DTEND:${localStamp(event.end)}`)
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`)
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`)
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
    if (event.status === 'cancelled') lines.push('STATUS:CANCELLED')
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`
}

interface IcsProperty {
  name: string
  params: Record<string, string>
  value: string
}

/** Unfolds continuation lines first: every later step works on whole logical lines. */
function logicalLines(text: string): string[] {
  const out: string[] = []
  for (const raw of String(text ?? '').split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) out[out.length - 1] += raw.slice(1)
    else if (raw.trim()) out.push(raw)
  }
  return out
}

function parseProperty(line: string): IcsProperty | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  const [name, ...rest] = head.split(';')
  const params: Record<string, string> = {}
  for (const item of rest) {
    const equals = item.indexOf('=')
    if (equals <= 0) continue
    // TZID may be quoted; only the VALUE=DATE / TZID= key matters to us.
    params[item.slice(0, equals).trim().toUpperCase()] = item.slice(equals + 1).trim().replace(/^"|"$/g, '')
  }
  return { name: name.trim().toUpperCase(), params, value: line.slice(colon + 1) }
}

function parseIcsDate(value: string, params: Record<string, string>): { at: number; allDay: boolean } | null {
  const raw = value.trim()
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(raw)
  if (!match) return null
  const [, year, month, day, hours, minutes, seconds, zulu] = match
  const numbers = [Number(year), Number(month) - 1, Number(day)]
  if (!hours || params.VALUE === 'DATE') {
    const at = new Date(numbers[0], numbers[1], numbers[2], 0, 0, 0, 0).getTime()
    return { at, allDay: true }
  }
  const clock = [Number(hours), Number(minutes ?? 0), Number(seconds ?? 0)]
  const at = zulu
    ? Date.UTC(numbers[0], numbers[1], numbers[2], clock[0], clock[1], clock[2])
    : new Date(numbers[0], numbers[1], numbers[2], clock[0], clock[1], clock[2], 0).getTime()
  return { at, allDay: false }
}

function eventFromProperties(props: Record<string, IcsProperty>): CalendarEventInput | null {
  const start = props.DTSTART ? parseIcsDate(props.DTSTART.value, props.DTSTART.params) : null
  // No DTSTART means we cannot place the event on any day; the caller counts it as skipped.
  if (!start) return null
  const allDay = start.allDay
  const end = props.DTEND ? parseIcsDate(props.DTEND.value, props.DTEND.params) : null
  const until = end && end.at > start.at ? end.at : start.at + (allDay ? DAY : HOUR)
  const title = props.SUMMARY ? unescapeText(props.SUMMARY.value).trim() : ''
  const notes = props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : undefined
  const location = props.LOCATION ? unescapeText(props.LOCATION.value).trim() : undefined
  const uid = props.UID && props.UID.value.trim() ? props.UID.value.trim() : undefined
  // A cancelled block is still a real entry: the store keeps it as cancelled so an
  // imported retraction can silence (or delete) the copy it was exported from.
  const cancelled = props.STATUS !== undefined && props.STATUS.value.trim().toUpperCase() === 'CANCELLED'
  return {
    // Some calendars emit untitled blocks for busy time; a nameless row is worse than a placeholder.
    title: title || mt('未命名日程'),
    ...(notes ? { notes } : {}),
    start: start.at,
    end: allDay ? start.at + DAY : until,
    allDay,
    ...(location ? { location } : {}),
    source: 'import',
    ...(uid === undefined ? {} : { uid }),
    ...(cancelled ? { status: 'cancelled' as const } : {})
  }
}

/**
 * Tolerant ICS reader: CRLF or LF, folded lines, parameters, UTC or floating time.
 *
 * Deliberately partial. Recurrence (RRULE), alarms (VALARM) and timezone
 * definitions (VTIMEZONE) are ignored — this app stores one-off events, and the
 * caller keeps its own reminder lead instead of importing VALARM.
 *
 * `STATUS:CANCELLED` events are returned too, marked with `status:'cancelled'`;
 * deciding whether that means "update to cancelled" or "leave the local row
 * alone" belongs to the store, which knows whether it already has the event.
 */
export function parseIcs(text: string): CalendarEventInput[] {
  const out: CalendarEventInput[] = []
  let current: Record<string, IcsProperty> | null = null
  for (const line of logicalLines(text)) {
    const property = parseProperty(line)
    if (!property) continue
    if (property.name === 'BEGIN' && property.value.trim().toUpperCase() === 'VEVENT') {
      current = {}
      continue
    }
    if (property.name === 'END' && property.value.trim().toUpperCase() === 'VEVENT') {
      const input = current ? eventFromProperties(current) : null
      if (input) out.push(input)
      current = null
      continue
    }
    // First occurrence wins: a duplicate DESCRIPTION from a bad exporter cannot double the notes.
    if (current && !(property.name in current)) current[property.name] = property
  }
  return out
}
