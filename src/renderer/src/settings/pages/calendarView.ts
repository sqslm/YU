/**
 * Pure view helpers for the hub's 日程 page.
 *
 * Nothing here touches React, `window` or `Date.now()`-dependent state it cannot
 * receive as an argument: the month grid, the day buckets, the dot set and the
 * heading text are all computed from their inputs, so the page stays a thin shell
 * and every rule below is testable in a plain node environment.
 *
 * The one thing worth knowing before reading: a *day key* is the local calendar
 * date (`YYYY-MM-DD`, see `localDayKey` in `@shared/calendar`), never a UTC one.
 * The user typed "10 月 25 日" and expects that cell to hold the event, whatever
 * the offset is.
 */
import type { CalendarEvent } from '@shared/calendar'
import { localDayKey, sortEvents, startOfLocalDay } from '@shared/calendar'

export type UiLanguage = 'zh' | 'en'

const DAY_MS = 24 * 60 * 60_000

/** The grid is always 6 rows: 31 days plus up to 6 leading blanks needs 6 weeks. */
export const GRID_ROWS = 6
export const GRID_COLUMNS = 7

/** JS puts Sunday at 0; a Chinese calendar puts it last, so Monday is index 0. */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7
}

/**
 * Six weeks of local midnights, Monday first, with the neighbouring months'
 * days as leading and trailing filler.
 *
 * `month` is 1–12, the number the user reads in the toolbar — not the 0-based
 * `Date.getMonth()` — because every caller here is rendering a label with it.
 */
export function monthGrid(year: number, month: number): number[][] {
  const first = new Date(year, month - 1, 1)
  const leading = mondayIndex(first)
  const rows: number[][] = []
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const cells: number[] = []
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      // Day arithmetic on local components, never `base + n * DAY_MS`: a day with a
      // DST switch is not 24 hours long and the cell must stay on local midnight.
      cells.push(new Date(year, month - 1, 1 - leading + row * GRID_COLUMNS + column).getTime())
    }
    rows.push(cells)
  }
  return rows
}

/** Parses a day key back into local midnight; `null` when the key is malformed. */
export function dayStart(dayKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return null
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  // Rejects 2026-02-31, which `new Date` would happily roll into March.
  return localDayKey(at.getTime()) === dayKey ? at.getTime() : null
}

/** Moves a day key by whole days; the keyboard handlers and the arrows both need it. */
export function shiftDayKey(dayKey: string, days: number): string {
  const start = dayStart(dayKey)
  if (start === null) return dayKey
  const date = new Date(start)
  date.setDate(date.getDate() + days)
  return localDayKey(date.getTime())
}

export function dayKeyOf(epoch: number): string {
  return localDayKey(epoch)
}

/**
 * Cancelled rows sink to the bottom of their day: the plan the user is still
 * keeping is what the list has to lead with, and a cancellation is history.
 */
function sortDayEvents(rows: readonly CalendarEvent[]): CalendarEvent[] {
  return [...rows].sort(
    (left, right) =>
      (left.status === 'cancelled' ? 1 : 0) - (right.status === 'cancelled' ? 1 : 0)
      || left.start - right.start
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)
  )
}

/** Events bucketed by `localDayKey(start)`, each bucket sorted by `sortDayEvents`. */
export function groupByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const days = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const key = localDayKey(event.start)
    const bucket = days.get(key)
    if (bucket) bucket.push(event)
    else days.set(key, [event])
  }
  for (const [key, bucket] of days) days.set(key, sortDayEvents(bucket))
  return days
}

/**
 * Days that deserve a dot under their number.
 *
 * A cancelled-only day stays blank: advertising it would make the month look
 * busier than the day list, which shows the same row greyed out. `limit` is the
 * number of dots one cell can draw, so counting stops there — the caller cannot
 * show more, and a 40-event day is not worth 40 counts.
 */
export function dotDays(events: readonly CalendarEvent[], limit = 3): Set<string> {
  const seen = new Map<string, number>()
  for (const event of events) {
    if (event.status !== 'confirmed') continue
    const key = localDayKey(event.start)
    const count = seen.get(key) ?? 0
    if (count >= Math.max(1, limit)) continue
    seen.set(key, count + 1)
  }
  return new Set(seen.keys())
}

/** Whole days between a day key and the local day of `now`; DST-safe via rounding. */
function dayDelta(dayKey: string, now: number): number {
  const start = dayStart(dayKey)
  if (start === null) return Number.NaN
  return Math.round((start - startOfLocalDay(now)) / DAY_MS)
}

function relativePrefix(dayKey: string, language: UiLanguage, now: number): string {
  const delta = dayDelta(dayKey, now)
  if (delta === 0) return language === 'en' ? 'Today' : '今天'
  if (delta === 1) return language === 'en' ? 'Tomorrow' : '明天'
  if (delta === -1) return language === 'en' ? 'Yesterday' : '昨天'
  return ''
}

/**
 * Heading for one day, e.g. `今天 · 10 月 25 日 周日` / `Today · Sun, Oct 25`.
 *
 * The relative prefix is what makes the list readable at a glance; the absolute
 * date stays because "明天" alone is ambiguous once the page sits open overnight.
 */
export function formatDayHeading(dayKey: string, language: UiLanguage, now: number = Date.now()): string {
  const start = dayStart(dayKey)
  if (start === null) return dayKey
  const date = new Date(start)
  const locale = language === 'en' ? 'en-US' : 'zh-CN'
  const label = language === 'en'
    ? new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(date)
    // Composed by hand: zh-CN renders `10月25日周日` and the reading needs the spaces.
    : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)}`
  const prefix = relativePrefix(dayKey, language, now)
  return prefix ? `${prefix} · ${label}` : label
}

/** Re-exported so the page and its tests share one ordering rule with the store. */
export { sortEvents }
