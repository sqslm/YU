/**
 * Pure view helpers for the hub's 简报 page.
 *
 * Same contract as `calendarView`: nothing here reads `Date.now()`, `i18n` or
 * `window` unless it is handed in, so the page stays a thin shell and every rule
 * below is testable in a plain node environment.
 *
 * A *day key* is the local calendar date (`YYYY-MM-DD`), never a UTC one — the
 * briefing scheduler buckets by local day, and a briefing generated at 08:00 must
 * be filed under that morning, not under yesterday in a negative offset.
 */
import type { BriefingRecord, BriefingSettings } from '@shared/briefing'
import { MAX_BRIEFING_HISTORY, normalizeBriefingTime } from '@shared/briefing'
import { dayStart, type UiLanguage } from './calendarView'

const DAY_MS = 24 * 60 * 60_000
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localMidnight(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whole days between a day key and the local day of `now`; DST-safe via rounding. */
function dayDelta(dayKey: string, now: number): number {
  const start = dayStart(dayKey)
  if (start === null) return Number.NaN
  return Math.round((start - localMidnight(now)) / DAY_MS)
}

/**
 * Heading for one briefing day, e.g. `今天 · 10 月 25 日 周日` / `Tue, Oct 20`.
 *
 * The relative prefix is what makes the history list readable at a glance; the
 * absolute date stays because "昨天" alone is ambiguous once the page sits open
 * overnight. A malformed key is shown as-is instead of guessed at.
 */
export function formatBriefingDay(dayKey: string, language: UiLanguage, now: number = Date.now()): string {
  const start = dayStart(dayKey)
  if (start === null) return dayKey
  const date = new Date(start)
  const label = language === 'en'
    ? `${WEEKDAY_EN[date.getDay()]}, ${MONTH_EN[date.getMonth()]} ${date.getDate()}`
    // Composed by hand: zh-CN renders `10月25日周日` and the reading needs the spaces.
    : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAY_ZH[date.getDay()]}`
  const delta = dayDelta(dayKey, now)
  if (delta === 0) return `${language === 'en' ? 'Today' : '今天'} · ${label}`
  if (delta === -1) return `${language === 'en' ? 'Yesterday' : '昨天'} · ${label}`
  return label
}

/** One day's briefing as the history list draws it: the newest record for that day. */
export interface BriefingDayGroup {
  dayKey: string
  title: string
  body: string
  createdAt: number
}

/**
 * Newest day first, one row per day.
 *
 * A day can be delivered twice (manual retry, or a time change), so the newer
 * record wins: showing both copies would read as two briefings for one morning.
 * Junk records are dropped rather than rendered as a blank row.
 */
export function groupHistory(records: readonly BriefingRecord[], limit: number = MAX_BRIEFING_HISTORY): BriefingDayGroup[] {
  const newest = new Map<string, BriefingDayGroup>()
  for (const record of records ?? []) {
    if (!record || typeof record.dayKey !== 'string' || record.dayKey === '') continue
    const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : 0
    const current = newest.get(record.dayKey)
    if (current && current.createdAt >= createdAt) continue
    newest.set(record.dayKey, {
      dayKey: record.dayKey,
      title: typeof record.title === 'string' ? record.title : '',
      body: typeof record.body === 'string' ? record.body : '',
      createdAt
    })
  }
  // Day keys are `YYYY-MM-DD`, so a plain string compare is a date compare.
  const rows = [...newest.values()].sort((a, b) => b.dayKey.localeCompare(a.dayKey) || b.createdAt - a.createdAt)
  return limit > 0 ? rows.slice(0, limit) : []
}

/** True when nothing worth listing was delivered yet — the page shows one hint instead. */
export function isEmptyHistory(records: readonly BriefingRecord[] | null | undefined): boolean {
  return groupHistory(records ?? [], Number.POSITIVE_INFINITY).length === 0
}

/**
 * `每天 08:00 · 免打扰 22:00–07:30` — the page's read-only summary.
 *
 * A disabled window still shows its clocks' absence explicitly ("免打扰已关闭")
 * instead of hiding the line: the reader has to know why no briefing arrived at
 * 03:00, and "nothing here" is not an answer.
 */
export function quietSummary(settings: BriefingSettings, language: UiLanguage): string {
  const time = normalizeBriefingTime(settings.time)
  const quiet = settings.quietHours
  const daily = language === 'en' ? `Daily ${time}` : `每天 ${time}`
  if (!quiet || quiet.enabled !== true) return `${daily} · ${language === 'en' ? 'Quiet hours off' : '免打扰已关闭'}`
  return `${daily} · ${language === 'en' ? 'Quiet' : '免打扰'} ${quiet.start}–${quiet.end}`
}

/** The one-line state hint next to 立即生成; a disabled briefing says where to fix it. */
export function briefingHint(settings: BriefingSettings, language: UiLanguage): string {
  const time = normalizeBriefingTime(settings.time)
  if (language === 'en') return settings.enabled ? `Generates itself every day at ${time}` : 'Off. Turn it on in Settings when you want it.'
  return settings.enabled ? `每天 ${time} 自动生成` : '简报已关闭，到点在设置里打开'
}

/** `10 月 25 日 08:00` / `Oct 25, 08:00`; an unusable timestamp renders as nothing. */
export function formatGeneratedAt(createdAt: number, language: UiLanguage): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return ''
  const date = new Date(createdAt)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return language === 'en'
    ? `${MONTH_EN[date.getMonth()]} ${date.getDate()}, ${clock}`
    : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`
}

/**
 * Body text as renderable lines.
 *
 * Blank runs collapse to one empty line: both the template and the model leave
 * stray double breaks, and a wall of gaps reads as a rendering bug. Leading and
 * trailing blanks are dropped so the card has no dead space at either edge.
 */
export function bodyLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      if (lines.length === 0 || lines[lines.length - 1] === '') continue
      lines.push('')
      continue
    }
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
