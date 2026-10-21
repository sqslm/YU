/**
 * Lifetime usage totals, kept apart from the history rows they describe.
 *
 * The hub used to derive every figure on the 概览 page from the history file,
 * so "清空历史" wiped the bar chart, the year heat map and the insight cards
 * along with the rows the user meant to delete. Those figures are not history:
 * they are a rollup of how much was dictated. This module is that rollup, and
 * it is written once per take and never trimmed or cleared.
 *
 * Both sides use it: the main process accumulates it (`src/main/stats.ts`)
 * and the renderer aggregates it, so the numbers stay identical whether the
 * rows behind them still exist or not.
 */
import { mt } from './mainI18n'

import { TYPING_WPM, countText, timeSavedMs } from './count'
import type { HistoryEntry } from './types'

/** Shortest take worth a speaking rate; below a second the ratio is noise. */
export const MIN_TAKE_MS = 1000

/**
 * Labels that describe a language instead of an app. They leak into the history
 * when the foreground window title was a language name, and a 热门场景 chip that
 * reads "中文" tells the user nothing.
 */
const NOT_AN_APP = new Set([
  'zh',
  'en',
  'ja',
  'ko',
  'zh-cn',
  'zh-tw',
  'en-us',
  mt('中文'),
  mt('英文'),
  mt('日语'),
  mt('韩语'),
  'english',
  'chinese',
  'japanese',
  'korean'
])

/** Separators window titles use between the document and the app name. */
const TITLE_SEPARATORS = /\s+[—–·|]\s+|\s+-\s+/

/** One local calendar day of activity. Every figure is additive across days. */
export interface DayTotals {
  /** Rows stored that day: what the bar chart and the heat map plot. */
  entries: number
  /** Sum of `final.length`, the 字数 the chart and the first card show. */
  len: number
  /** Sum of `durationMs`, the 时长 they show. */
  ms: number
  /** Rows that were real dictation (status is neither `error` nor `empty`). */
  used: number
  /** Rows that produced text: the base of the cumulative 字/时长 pair. */
  records: number
  /** Duration of those rows, what 累计口述时长 sums. */
  usedMs: number
  /** Code points of those rows. */
  chars: number
  /** CJK characters plus latin words, see `countText`. */
  units: number
  /** Rows long enough to enter the speaking-rate sample. */
  measured: number
  /** Units of those rows. */
  measuredUnits: number
  /** Duration of those rows. */
  measuredMs: number
  /** Time saved versus typing, accumulated per row (the formula is not linear). */
  savedMs: number
}

/** `YYYY-MM-DD` in local time → that day's totals. */
export type DayTotalsMap = Record<string, DayTotals>

export interface StatsFile {
  version: 1
  /** Usable rows ever seen, including the ones the history has since dropped. */
  records: number
  /** Newest usable row timestamp, so the streak anchor survives a clear. */
  lastAt: number
  days: DayTotalsMap
  /** App label → number of usable rows, for 热门场景. */
  apps: Record<string, number>
}

export function emptyDayTotals(): DayTotals {
  return {
    entries: 0,
    len: 0,
    ms: 0,
    used: 0,
    records: 0,
    usedMs: 0,
    chars: 0,
    units: 0,
    measured: 0,
    measuredUnits: 0,
    measuredMs: 0,
    savedMs: 0
  }
}

export function emptyStats(): StatsFile {
  return { version: 1, records: 0, lastAt: 0, days: {}, apps: {} }
}

/** Local `YYYY-MM-DD`; duplicated from the overview helpers to keep this file standalone. */
export function statsDayKey(ts: number): string {
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Whether a row represents real dictation. A failed take (`error`) or one that
 * produced nothing (`empty`) is not usage; rows written before the field
 * existed have no `status` and still count as completed.
 */
export function isUsageEntry(item: Pick<HistoryEntry, 'status'>): boolean {
  return item.status !== 'error' && item.status !== 'empty'
}

/**
 * The app a record belongs to.
 *
 * The history stores the *window title* in `app`, which for a document window is
 * "与 Typeless 的差距 — DeepSeek Harness": the app name is the trailing segment,
 * not the leading one. Chips therefore take the last segment and fall back to the
 * whole title only when it has no separator.
 */
export function appLabel(item: Pick<HistoryEntry, 'app'>): string {
  const raw = (item.app ?? '').trim()
  if (!raw) return ''
  const parts = raw
    .split(TITLE_SEPARATORS)
    .map((part) => part.trim())
    .filter(Boolean)
  const tail = (parts.length > 1 ? parts[parts.length - 1] : raw).replace(/\.exe$/i, '').trim()
  if (tail.length < 2 || NOT_AN_APP.has(tail.toLowerCase())) return ''
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail
}

/**
 * What one row adds to the rollup. Returned as a value instead of written into
 * the file so the arithmetic is testable on its own.
 */
export function contributionOf(
  item: HistoryEntry,
  typingWpm: number = TYPING_WPM
): { day: string; totals: DayTotals; app: string | null } {
  const totals = emptyDayTotals()
  // `final` is what the user kept; `transcript` is the fallback for rows whose
  // cleanup step never ran.
  const counted = countText(item.final || item.transcript || '')
  const duration = Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs || 0) : 0

  totals.entries = 1
  totals.len = item.final?.length ?? 0
  totals.ms = duration

  const usable = isUsageEntry(item)
  if (usable) totals.used = 1

  const app = appLabel(item)
  const scene = usable && app && counted.units > 0 ? app : null

  if (usable && counted.units > 0) {
    totals.records = 1
    totals.usedMs = duration
    totals.units = counted.units
    totals.chars = counted.chars
    if (duration >= MIN_TAKE_MS) {
      totals.measured = 1
      totals.measuredUnits = counted.units
      totals.measuredMs = duration
      totals.savedMs = timeSavedMs(counted.units, duration, typingWpm)
    }
  }

  return { day: statsDayKey(item.createdAt), totals, app: scene }
}

function addInto(target: DayTotals, delta: DayTotals): void {
  target.entries += delta.entries
  target.len += delta.len
  target.ms += delta.ms
  target.used += delta.used
  target.records += delta.records
  target.usedMs += delta.usedMs
  target.chars += delta.chars
  target.units += delta.units
  target.measured += delta.measured
  target.measuredUnits += delta.measuredUnits
  target.measuredMs += delta.measuredMs
  target.savedMs += delta.savedMs
}

/**
 * Adds one history row to the file in place. Called once per stored take, so a
 * rewrite of the same row (retry, audio update) must not be counted twice —
 * callers pass only freshly stored rows.
 */
export function addToStats(stats: StatsFile, item: HistoryEntry, typingWpm = TYPING_WPM): StatsFile {
  const { day, totals, app } = contributionOf(item, typingWpm)
  const bucket = stats.days[day] ?? emptyDayTotals()
  addInto(bucket, totals)
  stats.days[day] = bucket
  if (totals.records > 0) stats.records += 1
  if (app) stats.apps[app] = (stats.apps[app] ?? 0) + 1
  if (isUsageEntry(item) && item.createdAt > stats.lastAt) stats.lastAt = item.createdAt
  return stats
}

/**
 * Rebuilds the whole rollup from history rows. Used when the file is missing —
 * an upgrade must not start the charts at zero — and by tests that compare the
 * accumulated file against the entries it came from.
 */
export function statsFromEntries(
  entries: HistoryEntry[],
  typingWpm = TYPING_WPM
): StatsFile {
  const stats = emptyStats()
  for (const item of entries) addToStats(stats, item, typingWpm)
  return stats
}

function number(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

/** Reads a persisted file, dropping anything a hand-edited one may hold. */
export function sanitizeStats(raw: unknown): StatsFile {
  const stats = emptyStats()
  if (!raw || typeof raw !== 'object') return stats
  const record = raw as Record<string, unknown>

  const days = record.days
  if (days && typeof days === 'object') {
    for (const [key, value] of Object.entries(days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      if (!value || typeof value !== 'object') continue
      const cell = value as Record<string, unknown>
      const totals = emptyDayTotals()
      totals.entries = number(cell.entries)
      totals.len = number(cell.len)
      totals.ms = number(cell.ms)
      totals.used = number(cell.used)
      totals.records = number(cell.records)
      totals.usedMs = number(cell.usedMs)
      totals.chars = number(cell.chars)
      totals.units = number(cell.units)
      totals.measured = number(cell.measured)
      totals.measuredUnits = number(cell.measuredUnits)
      totals.measuredMs = number(cell.measuredMs)
      totals.savedMs = number(cell.savedMs)
      if (totals.entries > 0) stats.days[key] = totals
    }
  }

  const apps = record.apps
  if (apps && typeof apps === 'object') {
    for (const [name, value] of Object.entries(apps as Record<string, unknown>)) {
      const count = number(value)
      if (count > 0 && name.trim()) stats.apps[name.slice(0, 40)] = count
    }
  }

  stats.records = number(record.records)
  stats.lastAt = number(record.lastAt)
  return stats
}
