/**
 * Pure aggregation helpers for the overview page. Kept out of the component so
 * the bucketing (day windows, week alignment, heat levels) is testable.
 */
import i18n from '../../i18n'
import type { HistoryEntry } from '@shared/types'
import { contributionOf, statsDayKey, type StatsFile } from '@shared/stats'
import { isUsageEntry } from '@shared/stats'
import { speakingWpm } from '@shared/count'

export interface DayBucket {
  /** Weekday label used under the bar chart: 一…日 */
  label: string
  start: number
  /**
   * Local `YYYY-MM-DD`. The hover card names the actual day: seven weekday
   * labels repeat, and "三" alone does not say *which* Wednesday the bar is.
   */
  key: string
  count: number
  chars: number
  ms: number
}

export const WEEKDAY = ['一', '二', '三', '四', '五', '六', '日']
export const MONTHS = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月'
]

/** "3:26" — the overview shows minutes:seconds rather than "3.4 min". */
export function clock(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function shortClock(ms: number): string {
  return i18n.t('{{n}} 秒', { n: (ms / 1000).toFixed(1) })
}

export function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function dayKey(ts: number): string {
  const date = new Date(ts)
  // Local Y-M-D with a 1-based month: the 0-based month leaked into the
  // heat-map tooltips ("2026-9-19" while it was October 19th).
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Today's totals, used by the four stat cards. */
export function todayStats(entries: HistoryEntry[], now = Date.now()): {
  items: HistoryEntry[]
  chars: number
  spoken: number
  segments: number
  average: number
} {
  const from = startOfDay(now)
  const items = entries.filter((item) => item.createdAt >= from)
  const chars = items.reduce((sum, item) => sum + (item.final?.length ?? 0), 0)
  const spoken = items.reduce((sum, item) => sum + (item.durationMs || 0), 0)
  return {
    items,
    chars,
    spoken,
    segments: items.length,
    average: items.length > 0 ? spoken / items.length : 0
  }
}

/**
 * Local midnight `days` before `base`.
 *
 * Calendar arithmetic, not `base - days * 86_400_000`: on a DST changeover that
 * subtraction lands at 23:00 or 01:00 and the bar for that day silently went to
 * zero, because no entry's midnight matched the bucket's start.
 */
function startOfDayBefore(base: number, days: number): number {
  const date = new Date(base)
  date.setDate(date.getDate() - days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** One bucket per day for the last `range` days (oldest first). */
export function bucketDays(entries: HistoryEntry[], range: number, now = Date.now()): DayBucket[] {
  const base = startOfDay(now)
  const days: DayBucket[] = []
  for (let i = range - 1; i >= 0; i -= 1) {
    const start = startOfDayBefore(base, i)
    days.push({
      label: i18n.t(WEEKDAY[(new Date(start).getDay() + 6) % 7]),
      start,
      key: dayKey(start),
      count: 0,
      chars: 0,
      ms: 0
    })
  }
  const index = new Map(days.map((day) => [day.start, day]))
  for (const item of entries) {
    const bucket = index.get(startOfDay(item.createdAt))
    if (!bucket) continue
    bucket.count += 1
    const { totals } = contributionOf(item)
    bucket.chars += totals.units
    bucket.ms += totals.usedMs
  }
  return days
}

/**
 * Today's figures from the lifetime rollup — the same four numbers `todayStats`
 * produces, still available after the rows for today are gone.
 */
export function todayFromStats(
  stats: StatsFile,
  now = Date.now()
): { chars: number; spoken: number; segments: number; average: number; pace: number } {
  const cell = stats.days[statsDayKey(now)]
  if (!cell) return { chars: 0, spoken: 0, segments: 0, average: 0, pace: 0 }
  return {
    chars: cell.units,
    spoken: cell.usedMs,
    segments: cell.records,
    average: cell.records > 0 ? cell.usedMs / cell.records : 0,
    pace: speakingWpm(cell.inputUnits ?? 0, cell.inputMs ?? 0)
  }
}

/** `bucketDays` fed by the rollup. Day keys are local dates on both sides. */
export function bucketFromStats(stats: StatsFile, range: number, now = Date.now()): DayBucket[] {
  return bucketDays([], range, now).map((day) => {
    const cell = stats.days[day.key]
    return cell
      ? { ...day, count: cell.entries, chars: cell.units, ms: cell.usedMs }
      : day
  })
}

export interface HeatCell {
  key: string
  count: number
  /** False for the padding days before/after the 52-week window. */
  inRange: boolean
}

const HEAT_WEEKS = 52

/**
 * Week columns (Monday-first) for the trailing 52 weeks ending with the week
 * that contains `today`. A calendar-year grid used to be rendered, which made
 * the newest column land somewhere in the middle of the card and the last
 * month label read "9月" while the clock said October — the window has to end
 * at today, not at 31 December.
 */
export function heatWeeks(
  entries: HistoryEntry[],
  today: Date = new Date()
): { weeks: HeatCell[][]; activeDays: number; max: number; startKey: string; endKey: string } {
  const counts = new Map<string, number>()
  for (const item of entries) {
    const key = dayKey(item.createdAt)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return heatFromCounts(counts, today)
}

/**
 * The same grid fed by the lifetime rollup instead of the history rows, so the
 * heat map still shows a year of activity after 清空历史.
 */
export function heatFromStats(
  stats: StatsFile,
  today: Date = new Date()
): { weeks: HeatCell[][]; activeDays: number; max: number; startKey: string; endKey: string } {
  const counts = new Map<string, number>()
  for (const [key, cell] of Object.entries(stats.days)) {
    if (cell.entries > 0) counts.set(key, cell.entries)
  }
  return heatFromCounts(counts, today)
}

function heatFromCounts(
  counts: Map<string, number>,
  today: Date
): { weeks: HeatCell[][]; activeDays: number; max: number; startKey: string; endKey: string } {
  const start = new Date(startOfDay(today.getTime()))
  const offset = (start.getDay() + 6) % 7
  const first = new Date(start)
  first.setDate(first.getDate() - offset - (HEAT_WEEKS - 1) * 7)
  const last = new Date(first)
  last.setDate(last.getDate() + HEAT_WEEKS * 7 - 1)

  const startKey = dayKey(first.getTime())
  const endKey = dayKey(last.getTime())

  let activeDays = 0
  for (const [key, count] of counts) {
    if (count > 0 && key >= startKey && key <= endKey) activeDays += 1
  }

  const weeks: HeatCell[][] = []
  const cursor = new Date(first)
  for (let w = 0; w < HEAT_WEEKS; w += 1) {
    const week: HeatCell[] = []
    for (let i = 0; i < 7; i += 1) {
      const key = dayKey(cursor.getTime())
      week.push({ key, count: counts.get(key) ?? 0, inRange: true })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return {
    weeks,
    activeDays,
    // Measured over the drawn window only: a record from outside it must not
    // brighten the whole map.
    max: Math.max(1, ...weeks.flat().map((cell) => cell.count)),
    startKey,
    endKey
  }
}

/**
 * First column of every month that appears in the window, so the axis under
 * the heatmap can be labelled. `current` marks the month of `today`, which is
 * the one the reader is looking for ("it says September but it is October").
 */
export function monthLabels(
  weeks: HeatCell[][],
  today: Date = new Date(),
  months: string[] = MONTHS
): Array<{ label: string; col: number; current: boolean }> {
  const seen = new Set<string>()
  const out: Array<{ label: string; col: number; current: boolean }> = []
  const todayMonth = `${today.getFullYear()}-${today.getMonth() + 1}`
  weeks.forEach((week, col) => {
    for (const cell of week) {
      if (!cell.inRange) continue
      const [y, m] = cell.key.split('-')
      const id = `${Number(y)}-${Number(m)}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        label: i18n.t(months[Number(m) - 1] ?? ''),
        col,
        current: id === todayMonth
      })
    }
  })

  // A 53-week window opens in the tail of an earlier month, so the same month
  // number can show up twice (Oct 2025 … Oct 2026). Two identical captions look
  // like a bug, so keep the most recent occurrence of each name.
  const byName = new Set<string>()
  const unique = [...out].reverse().filter((item) => {
    if (byName.has(item.label)) return false
    byName.add(item.label)
    return true
  })
  unique.reverse()

  // 11px cells + 2px gap = 13px pitch; a "10月" caption is ~18px, so labels
  // must be at least two columns apart to stay legible. The current month wins
  // over its left neighbour when they would collide, because that is the one
  // the reader is looking for.
  const MIN_GAP = 2
  const kept: typeof out = []
  for (const item of unique) {
    const prev = kept[kept.length - 1]
    if (prev && item.col - prev.col < MIN_GAP) {
      if (item.current && !prev.current) kept[kept.length - 1] = item
      continue
    }
    kept.push(item)
  }

  // The container clips at the right edge; nudge the last caption inwards so
  // "10月" is not half cut off.
  const last = kept[kept.length - 1]
  if (last && weeks.length > 0 && last.col > weeks.length - 2) {
    last.col = Math.max(0, weeks.length - 2)
  }
  return kept
}

/** 0 = empty, 1..4 = increasing intensity. */
export function heatLevel(count: number, max: number): number {
  if (count <= 0) return 0
  return Math.min(4, 1 + Math.floor((count / Math.max(1, max)) * 3))
}

/**
 * Whether an entry represents real dictation. A failed take (`error`) or a
 * take that produced nothing (`empty`) is not usage, so the streak and the
 * cumulative insight figures skip it; entries written before the field
 * existed have no `status` and still count as completed.
 */
/**
 * Whether an entry represents real dictation. Lives in `@shared/stats` so the
 * main process counts the rollup with the same rule the renderer reads it with.
 */
export { isUsageEntry } from '@shared/stats'

/**
 * Local calendar day as an integer. Day arithmetic must not go through
 * `ms ± 86400000`: across a DST switch that lands on the same calendar day and
 * would break a streak. Parsing the `dayKey` parts into UTC midnight does not.
 */
export function dayIndex(ts: number): number {
  const [year, month, day] = dayKey(ts).split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000)
}

export interface StreakInfo {
  /** Unbroken run that still touches today or yesterday; 0 once both are empty. */
  current: number
  /** Longest unbroken run anywhere in the stored history. */
  longest: number
  /** Whether today itself already has a record. */
  todayActive: boolean
  /** Distinct days carrying at least one record. */
  activeDays: number
  /** Newest record timestamp, or null when nothing was ever recorded. */
  lastActiveAt: number | null
}

/**
 * Consecutive days with at least one record, the "连续 N 天" the hub shows.
 *
 * A streak is only alive while it still touches today or yesterday: if today
 * is empty the run is measured from yesterday, and a two-day gap resets it to
 * zero (that is what the vendor's streak counter does — it never keeps a
 * number for a week you already skipped). The longest run is measured over
 * every recorded day, independently of where the current run stands.
 */
export function streakDays(entries: HistoryEntry[], now = Date.now()): StreakInfo {
  const days = new Set<number>()
  let lastActiveAt: number | null = null
  for (const item of entries) {
    if (!isUsageEntry(item)) continue
    days.add(dayIndex(item.createdAt))
    if (lastActiveAt === null || item.createdAt > lastActiveAt) lastActiveAt = item.createdAt
  }
  return streakFromDays(days, lastActiveAt, now)
}

/**
 * The same streak fed by the lifetime rollup, so a wipe does not report "还没有
 * 记录" on a machine that dictated for a month.
 */
export function streakFromStats(stats: StatsFile, now = Date.now()): StreakInfo {
  const days = new Set<number>()
  for (const [key, cell] of Object.entries(stats.days)) {
    if (cell.used > 0) days.add(dayIndexOfKey(key))
  }
  return streakFromDays(days, stats.lastAt > 0 ? stats.lastAt : null, now)
}

/** `YYYY-MM-DD` → the same integer `dayIndex` produces for a timestamp. */
export function dayIndexOfKey(key: string): number {
  const [year, month, day] = key.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000)
}

function streakFromDays(days: Set<number>, lastActiveAt: number | null, now: number): StreakInfo {
  const today = dayIndex(now)
  const todayActive = days.has(today)

  // Walking backwards from the anchor is cheaper than sorting when only the
  // current run is needed; the longest run needs the sort below anyway.
  let current = 0
  let cursor: number | null = todayActive ? today : days.has(today - 1) ? today - 1 : null
  while (cursor !== null && days.has(cursor)) {
    current += 1
    cursor -= 1
  }

  let longest = 0
  let run = 0
  let previous: number | null = null
  for (const day of [...days].sort((a, b) => a - b)) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    previous = day
  }

  return { current, longest, todayActive, activeDays: days.size, lastActiveAt }
}
