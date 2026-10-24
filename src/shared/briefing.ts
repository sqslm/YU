/** Daily briefing: pure local text assembly, no model call, no i18n indirection. */

/** A silence window in local wall-clock `HH:mm`; a start past the end wraps midnight. */
export interface BriefingQuietHours {
  enabled: boolean
  start: string
  end: string
}

export interface BriefingSettings {
  enabled: boolean
  time: string
  speak: boolean
  notify: boolean
  skipEmpty: boolean
  quietHours: BriefingQuietHours
}

/**
 * On by default: a notification at 03:00 is an interruption, not a briefing, and
 * the whole window is one toggle away from off.
 */
export const DEFAULT_QUIET_HOURS: BriefingQuietHours = { enabled: true, start: '22:00', end: '07:30' }

export const DEFAULT_BRIEFING_SETTINGS: BriefingSettings = {
  enabled: false,
  time: '08:00',
  speak: false,
  notify: true,
  skipEmpty: true,
  quietHours: { ...DEFAULT_QUIET_HOURS }
}

/** Minutes after local midnight, or `null` when the value is not a usable clock. */
function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function clockOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

export function normalizeBriefingTime(value: unknown): string {
  // Settings are user-editable and survive migrations, so a single unusable clock
  // string must degrade to the default instead of disabling the whole scheduler.
  const minutes = parseClock(value)
  return minutes === null ? DEFAULT_BRIEFING_SETTINGS.time : clockOf(minutes)
}

function normalizeQuietHours(input: unknown): BriefingQuietHours {
  const raw = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const clockTime = (key: 'start' | 'end'): string => {
    const minutes = parseClock(raw[key])
    // An unusable window clock falls back to the group default, not to
    // `normalizeBriefingTime`'s 08:00: start 22:00 → end 08:00 would mute most of
    // the day and quietly starve the user of briefings.
    return minutes === null ? DEFAULT_QUIET_HOURS[key] : clockOf(minutes)
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_QUIET_HOURS.enabled,
    start: clockTime('start'),
    end: clockTime('end')
  }
}

export function normalizeBriefingSettings(input: unknown): BriefingSettings {
  const raw = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const flag = (key: 'enabled' | 'speak' | 'notify' | 'skipEmpty'): boolean =>
    typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_BRIEFING_SETTINGS[key]
  // A settings file written before quiet hours existed simply lacks the group: that
  // is a missing field to backfill, never a reason to declare the group corrupt.
  return {
    enabled: flag('enabled'),
    time: normalizeBriefingTime(raw.time),
    speak: flag('speak'),
    notify: flag('notify'),
    skipEmpty: flag('skipEmpty'),
    quietHours: normalizeQuietHours(raw.quietHours)
  }
}

/** Reads a stored window clock defensively; a hand-edited file can still hold junk. */
function quietMinutes(value: string, fallback: string): number {
  return parseClock(value) ?? parseClock(fallback) ?? 0
}

/**
 * True when `at` falls inside the configured silence window.
 *
 * `enabled: false` is the user's hard opt-out. `start === end` is ambiguous (a
 * zero-length window or a whole day of silence), so it resolves to "not quiet":
 * muting every briefing forever because of one repeated value would be worse.
 */
export function isWithinQuietHours(settings: BriefingSettings, at: number): boolean {
  const quiet = settings.quietHours
  if (!quiet || quiet.enabled !== true) return false
  const start = quietMinutes(quiet.start, DEFAULT_QUIET_HOURS.start)
  const end = quietMinutes(quiet.end, DEFAULT_QUIET_HOURS.end)
  if (start === end) return false
  const date = new Date(at)
  const minute = date.getHours() * 60 + date.getMinutes()
  // A window whose start is later than its end wraps midnight (22:00 → 07:30).
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/**
 * The first moment after `at` that is outside the silence window, or `at` itself
 * when it is already allowed.
 */
export function nextAllowedAt(settings: BriefingSettings, at: number): number {
  if (!isWithinQuietHours(settings, at)) return at
  const end = quietMinutes(settings.quietHours.end, DEFAULT_QUIET_HOURS.end)
  const date = new Date(at)
  const hour = Math.floor(end / 60)
  const minute = end % 60
  const sameDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime()
  // Only inside a window that crossed midnight can the end clock still be ahead of
  // `at`; otherwise this silence ends tomorrow morning.
  if (sameDay > at) return sameDay
  // Date(year, month, day + 1) rolls month and year boundaries correctly.
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, hour, minute).getTime()
}

/** One delivered briefing, kept so the latest copy survives a restart. */
export interface BriefingRecord {
  dayKey: string
  title: string
  body: string
  createdAt: number
}

/** Two weeks of briefings: enough to look back, small enough to stay a tiny file. */
export const MAX_BRIEFING_HISTORY = 14

/**
 * Appends `incoming` to the stored records.
 *
 * A day appears at most once: a retry or a time change can deliver twice, and two
 * copies of the same day would stack up in the history list.
 */
export function appendBriefingHistory(records: readonly BriefingRecord[], incoming: BriefingRecord, limit: number = MAX_BRIEFING_HISTORY): BriefingRecord[] {
  if (limit <= 0) return []
  const kept = records.filter(record => record.dayKey !== incoming.dayKey)
  // Ordered by `createdAt` so "keep the newest `limit` days" is a plain slice; a
  // replaced day lands at the end because its record is the fresh one.
  const merged = [...kept, incoming].sort((a, b) => a.createdAt - b.createdAt)
  return merged.length > limit ? merged.slice(merged.length - limit) : merged
}

export interface BriefingEvent { id: string; title: string; start: number; end: number; allDay: boolean }

export interface BriefingTask {
  id: string
  title: string
  dueAt: number | null
  level?: 'normal' | 'strong'
  /** Local union on purpose: the reminders store owns its own type and is not imported here. */
  priority?: 'low' | 'normal' | 'high'
  overdue?: boolean
}
export interface BriefingStats { entries: number; characters: number; durationMs: number }

/** Everything the caller has already projected; this module never reads a store. */
export interface BriefingData {
  now: number
  language: 'zh' | 'en'
  events: BriefingEvent[]
  tasks: BriefingTask[]
  overdue: BriefingTask[]
  tomorrow: BriefingEvent[]
  stats?: BriefingStats
}

export interface Briefing {
  title: string
  body: string
  sections: string[]
  empty: boolean
  language: 'zh' | 'en'
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Lower rank sorts first. A task without a priority is an ordinary one. */
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const

function priorityRank(task: BriefingTask): number {
  return PRIORITY_RANK[task.priority ?? 'normal'] ?? PRIORITY_RANK.normal
}

/** High → normal → low, and the earliest due time first within one priority. */
function byPriority(tasks: BriefingTask[]): BriefingTask[] {
  return [...tasks].sort((a, b) =>
    priorityRank(a) - priorityRank(b) ||
    (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local day bucket. UTC math would fold the whole briefing onto the wrong date. */
export function briefingDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function composeBriefing(data: BriefingData): Briefing {
  // The result lands as one note or one notification, so every line comes from the
  // caller's `language`; half-translated output would read as a bug.
  const zh = data.language === 'zh'
  const now = new Date(data.now)
  const title = zh
    ? `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 今日简报`
    : `${MONTHS_EN[now.getMonth()]} ${now.getDate()} · Daily briefing`
  const sections: string[] = []
  const add = (heading: string, lines: string[]): void => {
    if (lines.length) sections.push(`${heading}\n${lines.join('\n')}`)
  }
  const span = (event: BriefingEvent): string => event.allDay ? (zh ? '全天' : 'All day') : `${clock(event.start)}–${clock(event.end)}`
  const eventLines = (events: BriefingEvent[]): string[] =>
    [...events].sort((a, b) => a.start - b.start).map(event => `- ${span(event)} ${event.title}`)
  // Tomorrow is a preview: only the start time matters, the end is not worth a range.
  const previewLines = (events: BriefingEvent[]): string[] =>
    [...events].sort((a, b) => a.start - b.start).map(event =>
      `- ${event.allDay ? (zh ? '全天' : 'All day') : clock(event.start)} ${event.title}`)
  // Both task sections are ordered the same way, so "what to do next" reads off the
  // top of the note without the reader comparing priorities by hand.
  const dueLines = (tasks: BriefingTask[]): string[] =>
    byPriority(tasks).map(task => task.dueAt === null ? `- ${task.title}` : `- ${clock(task.dueAt)} ${task.title}`)
  const dayLabel = (at: number): string => {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
    if (briefingDayKey(at) === briefingDayKey(yesterday)) return zh ? '昨天' : 'Yesterday'
    if (briefingDayKey(at) === briefingDayKey(data.now)) return zh ? '今天' : 'Today'
    const date = new Date(at)
    return zh ? `${date.getMonth() + 1} 月 ${date.getDate()} 日` : `${MONTHS_EN[date.getMonth()]} ${date.getDate()}`
  }
  const overdueSuffix = zh ? '（已逾期）' : ' (overdue)'
  const overdueLines = byPriority(data.overdue).map(task => task.dueAt === null
    ? `- ${task.title}${overdueSuffix}`
    : `- ${dayLabel(task.dueAt)} ${clock(task.dueAt)} ${task.title}${overdueSuffix}`)
  const stats = data.stats
  const recapLines = stats && stats.entries > 0
    ? [zh ? `昨天听写 ${stats.entries} 条、共 ${stats.characters} 字。` : `Yesterday: ${stats.entries} notes, ${stats.characters} characters.`]
    : []

  add(zh ? '今天' : 'Today', eventLines(data.events))
  add(zh ? '待办' : 'To do', dueLines(data.tasks))
  add(zh ? '已经过期' : 'Overdue', overdueLines)
  add(zh ? '明天' : 'Tomorrow', previewLines(data.tomorrow))
  add(zh ? '回顾' : 'Recap', recapLines)

  const empty = sections.length === 0
  return {
    title,
    body: empty ? (zh ? '今天没有安排。' : 'Nothing scheduled for today.') : sections.join('\n\n'),
    sections,
    empty,
    language: data.language
  }
}

/** The next HH:mm strictly after `now`, in local wall-clock time. */
export function nextBriefingAt(now: number, time: string): number {
  const [hour, minute] = normalizeBriefingTime(time).split(':').map(Number)
  const current = new Date(now)
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute).getTime()
  // Date(year, month, day + 1) rolls month and year boundaries correctly.
  if (today > now) return today
  return new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, hour, minute).getTime()
}
