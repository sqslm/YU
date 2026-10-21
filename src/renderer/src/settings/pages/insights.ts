/**
 * Vendor-style usage insights for the hub home page (REQ-07 / ACC-07b).
 *
 * Everything is derived from the stored history and stays a pure function so
 * the numbers behind the four insight cards can be tested without a renderer.
 *
 * Three decisions are worth spelling out because they change the numbers:
 *
 * - The speaking rate is a *weighted* average: total units over total measured
 *   duration, not the mean of the per-entry rates. Averaging per-entry rates
 *   lets a one-second "好" (≈60 units/min of noise) outweigh a five-minute
 *   paragraph.
 * - Only takes that produced text and lasted at least a second are measured.
 *   A take with no text contributes no units, and letting its duration into the
 *   denominator would drag the rate towards zero.
 * - Failed and empty takes are dropped everywhere, and the cumulative 字/时长
 *   pair only counts records that produced text, so the two figures always
 *   describe the same set of takes.
 */
import i18n from '../../i18n'
import type { HistoryEntry } from '@shared/types'
import { TYPING_WPM, speakingWpm } from '@shared/count'
import { statsFromEntries, type StatsFile } from '@shared/stats'
import { streakFromStats, type StreakInfo } from './overview'

/**
 * App labels that are our own windows, not somewhere the user typed.
 *
 * A dictation that landed in the hub or the answer card says nothing about where
 * the user works — it is the app talking to itself. The reference product excludes
 * its own windows for the same reason (`is_own_application` in its context capture).
 */
const NOT_AN_APP = new Set(['typeless', 'typeless rebuild', 'typeless rebuild.exe'])

export interface AppUsage {
  /** Display label of the foreground app, with a `.exe` suffix stripped. */
  name: string
  /** How many records landed in that app. */
  count: number
  /** Share of the app-bearing records, 0..1. */
  share: number
}

export interface UsageInsights {
  /** Entries seen in the history store. */
  total: number
  /** Records that produced text — the base of the cumulative pair. */
  records: number
  /** Entries that entered the rate/saving sample. */
  measured: number
  /** 累计口述字数: CJK characters plus latin words. */
  units: number
  /** 累计字符数 (code points), for the "字符" reading. */
  chars: number
  /** 累计口述时长 in ms. */
  spokenMs: number
  /** Weighted speaking rate in units per minute. */
  wpm: number
  /** 累计节省时间 in ms versus typing at `typingWpm`. */
  savedMs: number
  /** Typing speed the saved figure assumes. */
  typingWpm: number
  /** Top apps by record count, sorted and capped. */
  apps: AppUsage[]
  /** Consecutive-day streak, see `streakDays`. */
  streak: StreakInfo
}

export interface InsightOptions {
  now?: number
  /** How many apps the 热门场景 row keeps. */
  topApps?: number
  /** Typing rate the "saved time" figure compares against. */
  typingWpm?: number
}

/** Shortest take worth a rate lives in `@shared/stats`, next to the rollup. */

/**
 * Aggregate the whole history into the four insight cards plus the app
 * breakdown and the streak. Missing fields degrade to zero, never to NaN.
 *
 * The cumulative pair (字 / 时长) is measured over the same population: records
 * that were not errors and that actually produced text. A cancelled take is
 * stored with empty text (see `pipeline.cancel`), so letting its duration in
 * would report "spoken 5 minutes, dictated 0 字".
 *
 * The arithmetic is the shared rollup's: this sums the same counters the main
 * process persists, so the numbers do not move when the rows behind them are
 * deleted.
 */
export function usageInsights(
  entries: HistoryEntry[],
  options: InsightOptions = {}
): UsageInsights {
  const { typingWpm = TYPING_WPM } = options
  const stats = statsFromEntries(entries, typingWpm)
  return { ...insightsFromStats(stats, options), total: entries.length }
}

/** The same cards, read straight from the lifetime rollup. */
export function insightsFromStats(stats: StatsFile, options: InsightOptions = {}): UsageInsights {
  const { now = Date.now(), topApps = 5, typingWpm = TYPING_WPM } = options

  let records = 0
  let units = 0
  let chars = 0
  let spokenMs = 0
  let measured = 0
  let measuredUnits = 0
  let measuredMs = 0
  let savedMs = 0

  for (const cell of Object.values(stats.days)) {
    records += cell.records
    units += cell.units
    chars += cell.chars
    spokenMs += cell.usedMs
    measured += cell.measured
    measuredUnits += cell.measuredUnits
    measuredMs += cell.measuredMs
    savedMs += cell.savedMs
  }

  const appEntries = Object.entries(stats.apps).filter(
    ([name]) => !NOT_AN_APP.has(name.trim().toLowerCase())
  )
  const appTotal = appEntries.reduce((sum, [, count]) => sum + count, 0)
  const ranked: AppUsage[] = appEntries
    .map(([name, count]) => ({ name, count, share: appTotal > 0 ? count / appTotal : 0 }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name < b.name ? -1 : 1))
    .slice(0, Math.max(0, topApps))

  return {
    total: stats.records,
    records,
    measured,
    units,
    chars,
    spokenMs,
    wpm: speakingWpm(measuredUnits, measuredMs),
    savedMs,
    typingWpm,
    apps: ranked,
    streak: streakFromStats(stats, now)
  }
}

/** `1234` → `1,234`, the grouping the vendor dashboard uses. */
export function group(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Cumulative duration as a readable label; `—` when there is nothing yet. */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  // Seconds are decided before rounding to whole minutes: 45 s rounds to "1 分钟"
  // and would claim a minute of dictation that never happened.
  if (ms < 60_000) return i18n.t('{{n}} 秒', { n: Math.max(1, Math.round(ms / 1000)) })
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return i18n.t('{{n}} 分钟', { n: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? i18n.t('{{n}} 小时', { n: hours })
    : i18n.t('{{h}} 小时 {{m}} 分', { h: hours, m: rest })
}

/**
 * Value/unit pair for the "saved time" card: the number stays at display size
 * and the unit goes into the caption, so "节省 18 分钟" reads as one phrase.
 */
export function savedLabel(ms: number): { value: string; unit: string } {
  if (!Number.isFinite(ms) || ms <= 0) return { value: '—', unit: i18n.t('分钟') }
  if (ms < 60_000)
    return { value: group(Math.max(1, Math.round(ms / 1000))), unit: i18n.t('秒') }
  const minutes = Math.round(ms / 60_000)
  if (minutes < 600) return { value: group(minutes), unit: i18n.t('分钟') }
  return { value: (minutes / 60).toFixed(1), unit: i18n.t('小时') }
}

/** Weighted rate, `—` while nothing has been measured. */
export function wpmLabel(wpm: number): string {
  return Number.isFinite(wpm) && wpm > 0 ? group(wpm) : '—'
}

/** One line under the streak card explaining what the number means today. */
export function streakHint(streak: StreakInfo): string {
  if (streak.current > 0 && streak.todayActive) return i18n.t('今天已经口述过，明天再说一句就接上。')
  if (streak.current > 0) return i18n.t('今天还没有口述，说一句就能续上这段连续记录。')
  if (streak.lastActiveAt === null) return i18n.t('还没有记录，按住快捷键说第一句话。')
  const date = new Date(streak.lastActiveAt)
  return i18n.t('上次口述是 {{m}} 月 {{d}} 日，今天说一句就能重新开始。', {
    m: date.getMonth() + 1,
    d: date.getDate()
  })
}
