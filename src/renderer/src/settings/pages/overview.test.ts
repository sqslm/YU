import { describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import type { HistoryEntry } from '@shared/types'
import { statsFromEntries } from '@shared/stats'
import {
  bucketDays,
  bucketFromStats,
  heatFromStats,
  streakFromStats,
  todayFromStats,
  clock,
  dayIndex,
  dayKey,
  heatLevel,
  heatWeeks,
  isUsageEntry,
  monthLabels,
  shortClock,
  startOfDay,
  streakDays,
  todayStats
} from './overview'

function entry(at: number, chars: number, ms: number): HistoryEntry {
  return {
    id: `id-${at}`,
    createdAt: at,
    mode: 'dictation',
    transcript: '字'.repeat(chars),
    final: '字'.repeat(chars),
    durationMs: ms,
    app: 'Notepad'
  }
}

const NOON = new Date(2026, 9, 19, 12, 0, 0).getTime()

describe('clock formatting', () => {
  it('renders m:ss and pads seconds', () => {
    expect(clock(206000)).toBe('3:26')
    expect(clock(5000)).toBe('0:05')
    expect(clock(0)).toBe('0:00')
  })

  it('renders one decimal seconds', () => {
    expect(shortClock(1200)).toBe('1.2 秒')
    expect(shortClock(34300)).toBe('34.3 秒')
  })
})

describe('todayStats', () => {
  it('only counts entries from the same local day', () => {
    const items = [
      entry(new Date(2026, 9, 19, 9, 0).getTime(), 10, 2000),
      entry(new Date(2026, 9, 19, 10, 0).getTime(), 30, 4000),
      entry(new Date(2026, 9, 18, 23, 0).getTime(), 100, 60000)
    ]
    const stats = todayStats(items, NOON)
    expect(stats.segments).toBe(2)
    expect(stats.chars).toBe(40)
    expect(stats.spoken).toBe(6000)
    expect(stats.average).toBe(3000)
  })

  it('returns zero average when there is nothing today', () => {
    expect(todayStats([], NOON)).toMatchObject({ segments: 0, chars: 0, average: 0 })
  })
})

describe('bucketDays', () => {
  it('builds one bucket per day, oldest first, and drops older entries', () => {
    const items = [
      entry(new Date(2026, 9, 19, 8, 0).getTime(), 5, 1000),
      entry(new Date(2026, 9, 17, 8, 0).getTime(), 7, 3000),
      entry(new Date(2026, 8, 1, 8, 0).getTime(), 9, 9000)
    ]
    const days = bucketDays(items, 7, NOON)
    expect(days).toHaveLength(7)
    expect(days[6].start).toBe(startOfDay(NOON))
    expect(days[6].count).toBe(1)
    expect(days[6].chars).toBe(5)
    expect(days[4].ms).toBe(3000)
    expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(2)
  })

  it('carries the real date, because seven weekday labels repeat', () => {
    const days = bucketDays([], 7, NOON)
    // The hover card names the day; "三" alone does not say which Wednesday.
    expect(days[6].key).toBe('2026-10-19')
    expect(days[0].key).toBe('2026-10-13')
    expect(days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.key))).toBe(true)
  })

  it('supports the 30-day window and weekday labels', () => {
    const days = bucketDays([], 30, NOON)
    expect(days).toHaveLength(30)
    // 2026-10-19 is a Monday.
    expect(days[29].label).toBe('一')
    expect(days[28].label).toBe('日')
  })
})

describe('dayKey', () => {
  it('uses a padded, 1-based month so tooltips say October, not "9"', () => {
    expect(dayKey(new Date(2026, 9, 19).getTime())).toBe('2026-10-19')
    expect(dayKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05')
  })
})

describe('heatWeeks', () => {
  const today = new Date(2026, 9, 19, 11, 0) // 2026-10-19, a Monday

  it('ends with the week that contains today, not with December 31st', () => {
    const { weeks, endKey } = heatWeeks([], today)
    expect(weeks).toHaveLength(52)
    // 2026-10-19 is a Monday, so the last column is exactly this week.
    expect(weeks[51][0].key).toBe('2026-10-19')
    expect(endKey).toBe('2026-10-25')
    expect(weeks.every((week) => week.every((cell) => cell.inRange))).toBe(true)
  })

  it('counts active days inside the window and ignores older entries', () => {
    const items = [
      entry(new Date(2026, 9, 19, 9, 0).getTime(), 1, 1),
      entry(new Date(2026, 9, 19, 10, 0).getTime(), 1, 1),
      entry(new Date(2024, 9, 19, 10, 0).getTime(), 1, 1)
    ]
    const heat = heatWeeks(items, today)
    expect(heat.activeDays).toBe(1)
    expect(heat.max).toBe(2)
    const cell = heat.weeks.flat().find((item) => item.key === '2026-10-19')
    expect(cell?.count).toBe(2)
  })
})

describe('monthLabels', () => {
  const today = new Date(2026, 9, 19, 11, 0)

  it('always labels the current month, even when it crowds its neighbour', () => {
    const { weeks } = heatWeeks([], today)
    const labels = monthLabels(weeks, today)
    const current = labels.filter((item) => item.current)
    expect(current).toHaveLength(1)
    expect(current[0].label).toBe(i18n.t('10月'))
  })

  it('drops labels that would overlap in 11px columns', () => {
    const { weeks } = heatWeeks([], today)
    const labels = monthLabels(weeks, today)
    for (let i = 1; i < labels.length; i += 1) {
      expect(labels[i].col - labels[i - 1].col).toBeGreaterThanOrEqual(2)
    }
  })

  it('never repeats a month name inside the 53-week window', () => {
    const { weeks } = heatWeeks([], today)
    const labels = monthLabels(weeks, today).map((item) => item.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.filter((label) => label === i18n.t('10月'))).toHaveLength(1)
  })

  it('keeps November even though October crowds it', () => {
    const { weeks } = heatWeeks([], today)
    const labels = monthLabels(weeks, today).map((item) => item.label)
    expect(labels).toContain(i18n.t('11月'))
    expect(labels).toContain(i18n.t('12月'))
  })

  it('pulls the last caption inwards so it is not clipped', () => {
    const { weeks } = heatWeeks([], today)
    const labels = monthLabels(weeks, today)
    const last = labels[labels.length - 1]
    expect(last.col).toBeLessThanOrEqual(weeks.length - 2)
  })
})

describe('heatLevel', () => {
  it('is zero for empty days and saturates at four', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 10)).toBe(1)
    expect(heatLevel(10, 10)).toBe(4)
  })
})

describe('isUsageEntry', () => {
  it('drops failed, empty and cancelled takes, keeps completed and pre-status entries', () => {
    expect(isUsageEntry(entry(NOON, 1, 1))).toBe(true)
    expect(isUsageEntry({ ...entry(NOON, 1, 1), status: 'completed' })).toBe(true)
    expect(isUsageEntry({ ...entry(NOON, 1, 1), status: 'dismissed' })).toBe(false)
    expect(isUsageEntry({ ...entry(NOON, 1, 1), status: 'empty' })).toBe(false)
    expect(isUsageEntry({ ...entry(NOON, 1, 1), status: 'error' })).toBe(false)
  })
})

describe('dayIndex', () => {
  it('increments by one across month and year boundaries', () => {
    const oct31 = new Date(2026, 9, 31, 23, 30).getTime()
    const nov1 = new Date(2026, 10, 1, 0, 30).getTime()
    expect(dayIndex(nov1) - dayIndex(oct31)).toBe(1)
    const dec31 = new Date(2026, 11, 31, 20, 0).getTime()
    const jan1 = new Date(2027, 0, 1, 1, 0).getTime()
    expect(dayIndex(jan1) - dayIndex(dec31)).toBe(1)
  })

  it('uses local calendar days, so two takes in one day share an index', () => {
    const morning = new Date(2026, 9, 19, 0, 5).getTime()
    const evening = new Date(2026, 9, 19, 23, 55).getTime()
    expect(dayIndex(morning)).toBe(dayIndex(evening))
  })
})

describe('streakDays', () => {
  // NOON is 2026-10-19 12:00 local.
  const day = (dayOfMonth: number, month = 10): number =>
    new Date(2026, month - 1, dayOfMonth, 9, 0).getTime()

  it('counts an unbroken run that reaches today', () => {
    const streak = streakDays([entry(day(19), 1, 1000), entry(day(18), 1, 1000), entry(day(17), 1, 1000)], NOON)
    expect(streak).toMatchObject({ current: 3, longest: 3, todayActive: true, activeDays: 3 })
  })

  it('stays alive when today is empty but yesterday is not', () => {
    const streak = streakDays([entry(day(18), 1, 1000), entry(day(17), 1, 1000)], NOON)
    expect(streak.current).toBe(2)
    expect(streak.todayActive).toBe(false)
  })

  it('drops to zero after a two-day gap but keeps the historical longest', () => {
    const items = [11, 12, 13, 14, 15].map((d) => entry(day(d), 1, 1000))
    const streak = streakDays(items, NOON)
    expect(streak.current).toBe(0)
    expect(streak.longest).toBe(5)
    expect(streak.activeDays).toBe(5)
    expect(streak.lastActiveAt).toBe(day(15))
  })

  it('counts one day once and finds the longest run separately from today', () => {
    const items = [
      entry(day(19, 10), 1, 1000),
      entry(new Date(2026, 9, 19, 18, 0).getTime(), 1, 1000),
      entry(day(18, 10), 1, 1000),
      entry(day(2, 10), 1, 1000),
      entry(day(1, 10), 1, 1000),
      entry(day(30, 9), 1, 1000)
    ]
    const streak = streakDays(items, NOON)
    expect(streak.current).toBe(2)
    expect(streak.longest).toBe(3)
    expect(streak.activeDays).toBe(5)
  })

  it('does not count a day whose only take failed or came back empty', () => {
    const items = [
      { ...entry(day(19), 1, 1000), status: 'error' as const },
      { ...entry(day(18), 1, 1000), status: 'empty' as const },
      entry(day(17), 1, 1000)
    ]
    const streak = streakDays(items, NOON)
    expect(streak.current).toBe(0)
    expect(streak.longest).toBe(1)
    expect(streak.activeDays).toBe(1)
    expect(streak.lastActiveAt).toBe(day(17))
  })

  it('crosses a month boundary without breaking the run', () => {
    const items = [entry(day(1, 11), 1, 1000), entry(day(31, 10), 1, 1000), entry(day(30, 10), 1, 1000)]
    const streak = streakDays(items, day(1, 11))
    expect(streak.current).toBe(3)
    expect(streak.longest).toBe(3)
  })

  it('is all zeros for an empty history', () => {
    expect(streakDays([], NOON)).toEqual({
      current: 0,
      longest: 0,
      todayActive: false,
      activeDays: 0,
      lastActiveAt: null
    })
  })
})

describe('lifetime rollup parity', () => {
  const rows = [
    entry(NOON, 10, 4000),
    entry(NOON + 60000, 4, 2000),
    entry(NOON - 86400000, 3, 1000)
  ]

  it('draws the same page from the rollup as from the rows', () => {
    const stats = statsFromEntries(rows)

    expect(todayFromStats(stats, NOON)).toEqual({
      chars: 14,
      spoken: 6000,
      segments: 2,
      average: 3000,
      pace: 140
    })
    expect(bucketFromStats(stats, 7, NOON)).toEqual(bucketDays(rows, 7, NOON))
    expect(heatFromStats(stats, new Date(NOON))).toEqual(heatWeeks(rows, new Date(NOON)))
    expect(streakFromStats(stats, NOON)).toEqual(streakDays(rows, NOON))
  })

  it('keeps every figure after the rows are deleted', () => {
    const stats = statsFromEntries(rows)

    // 清空历史 removes the rows; the rollup is all the page has left.
    expect(todayFromStats(stats, NOON).chars).toBe(14)
    expect(bucketFromStats(stats, 7, NOON).reduce((sum, day) => sum + day.count, 0)).toBe(3)
    expect(heatFromStats(stats, new Date(NOON)).activeDays).toBe(2)
    expect(streakFromStats(stats, NOON).current).toBe(2)
  })
})
