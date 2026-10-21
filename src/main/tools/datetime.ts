/**
 * `get_datetime`: the clock the model does not have.
 *
 * "今天/明天/后天" is the one thing a language model cannot infer from a
 * transcript, and getting it wrong poisons every relative date in the answer.
 * Everything here goes through `Intl.DateTimeFormat#formatToParts`, so there is
 * no timezone database to maintain and no dependency to add.
 */
import { mt } from '@shared/mainI18n'


const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export interface DateTimeInfo {
  ok: boolean
  /** IANA zone actually used (the request's, or the machine's). */
  timezone: string
  /** Local wall clock in that zone: `2026-10-19 15:04:05`. */
  now: string
  /** Same instant, UTC, unambiguous: `2026-10-19T07:04:05.000Z`. */
  iso: string
  weekday: string
  /** `YYYY-MM-DD` for the requested day offset. */
  date: string
  today: string
  tomorrow: string
  dayAfterTomorrow: string
  offsetDays: number
  error?: string
}

export interface DateTimeOptions {
  timezone?: string
  offsetDays?: number
  /** Injected in tests so `today` is deterministic. */
  now?: Date
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: string
  minute: string
  second: string
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === type)
  return found ? found.value : ''
}

/** Wall clock of `instant` in `timeZone`, read through Intl. */
function readWallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant)
  return {
    year: Number(partValue(parts, 'year')),
    month: Number(partValue(parts, 'month')),
    day: Number(partValue(parts, 'day')),
    hour: partValue(parts, 'hour').padStart(2, '0'),
    minute: partValue(parts, 'minute').padStart(2, '0'),
    second: partValue(parts, 'second').padStart(2, '0')
  }
}

/** `YYYY-MM-DD` shifted by whole days, anchored on the zone's calendar date. */
function shiftDate(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const moved = new Date(utc + days * 86_400_000)
  // Out-of-range arithmetic yields Invalid Date, whose getters print NaN. Fall
  // back to the unshifted date rather than reporting "NaN-NaN-NaN".
  if (Number.isNaN(moved.getTime())) return date
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`
}

function weekdayOf(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return ''
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return WEEKDAYS[utc.getUTCDay()] ?? ''
}

export function getDateTime(options: DateTimeOptions = {}): DateTimeInfo {
  const requested = (options.timezone ?? '').trim()
  const fallbackZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const timezone = requested || fallbackZone
  // Bounded: the offset comes from the model, and a value like 1e15 made the
  // calendar arithmetic overflow into Invalid Date.
  const rawOffset = Number.isFinite(options.offsetDays) ? Math.trunc(Number(options.offsetDays)) : 0
  const offsetDays = Math.max(-3650, Math.min(3650, rawOffset))
  const now = options.now ?? new Date()

  let wall: WallClock
  try {
    wall = readWallClock(now, timezone)
  } catch {
    return {
      ok: false,
      timezone,
      now: '',
      iso: '',
      weekday: '',
      date: '',
      today: '',
      tomorrow: '',
      dayAfterTomorrow: '',
      offsetDays,
      error: mt('无效的时区：{{zone}}', { zone: timezone })
    }
  }
  if (!Number.isFinite(wall.year) || !Number.isFinite(wall.month) || !Number.isFinite(wall.day)) {
    return {
      ok: false,
      timezone,
      now: '',
      iso: '',
      weekday: '',
      date: '',
      today: '',
      tomorrow: '',
      dayAfterTomorrow: '',
      offsetDays,
      error: mt('无法读取系统时间')
    }
  }

  const today = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
  const date = shiftDate(today, offsetDays)
  return {
    ok: true,
    timezone,
    now: `${today} ${wall.hour}:${wall.minute}:${wall.second}`,
    iso: now.toISOString(),
    weekday: weekdayOf(date),
    date,
    today,
    tomorrow: shiftDate(today, 1),
    dayAfterTomorrow: shiftDate(today, 2),
    offsetDays
  }
}
