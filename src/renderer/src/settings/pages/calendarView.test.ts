import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '@shared/calendar'
import { localDayKey } from '@shared/calendar'
import { dayKeyOf, dayStart, dotDays, formatDayHeading, groupByDay, monthGrid, shiftDayKey, sortEvents } from './calendarView'

/** Fixed "now" so the relative prefixes never depend on the machine clock. */
const NOW = new Date(2026, 9, 25, 10, 30).getTime()

const at = (month: number, day: number, hour = 9, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()

const event = (id: string, start: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: id,
  start,
  end: start + 60 * 60_000,
  allDay: false,
  location: undefined,
  notes: undefined,
  leadMinutes: null,
  status: 'confirmed',
  source: 'manual',
  uid: undefined,
  notifiedAt: undefined,
  createdAt: start,
  updatedAt: start,
  ...extra
})

const keys = (grid: number[][]): string[] => grid.flat().map(cell => localDayKey(cell))

describe('monthGrid', () => {
  it('pads October 2026 with the three September days before Thursday the 1st', () => {
    // 2026-10-01 is a Thursday, so Monday-first needs Mon 28 – Wed 30 as filler.
    const grid = monthGrid(2026, 10)
    expect(grid[0]!.slice(0, 4).map(cell => localDayKey(cell))).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'])
    expect(grid[0]![4]).toBe(at(10, 2, 0))
  })

  it('is always six rows of seven distinct local midnights, one day apart', () => {
    const grid = monthGrid(2026, 10)
    expect(grid).toHaveLength(6)
    grid.forEach(row => expect(row).toHaveLength(7))
    const flat = grid.flat()
    expect(new Set(flat).size).toBe(42)
    flat.forEach(cell => expect(new Date(cell).getHours()).toBe(0))
    for (let index = 1; index < flat.length; index += 1) {
      expect(shiftDayKey(localDayKey(flat[index - 1]!), 1)).toBe(localDayKey(flat[index]!))
    }
  })

  it('starts every row on a Monday and starts a Monday month on its 1st', () => {
    // 2026-06-01 is a Monday: no leading filler at all.
    const monday = monthGrid(2026, 6)
    expect(new Date(monday[0]![0]!).getDay()).toBe(1)
    expect(localDayKey(monday[0]![0]!)).toBe('2026-06-01')
    monthGrid(2026, 10).forEach(row => expect(new Date(row[0]!).getDay()).toBe(1))
    monthGrid(2026, 10).forEach(row => expect(new Date(row[6]!).getDay()).toBe(0))
  })

  it('keeps the leap day of February 2028 and skips it in a common year', () => {
    expect(keys(monthGrid(2028, 2))).toContain('2028-02-29')
    expect(keys(monthGrid(2027, 2))).not.toContain('2027-02-29')
    // The trailing filler of a 29-day February starts on 2028-03-01 at the latest.
    expect(keys(monthGrid(2028, 2)).filter(key => key.startsWith('2028-02')).length).toBe(29)
  })
})

describe('day keys', () => {
  it('formats the local calendar date with padded month and day', () => {
    expect(dayKeyOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
    expect(dayKeyOf(at(10, 25))).toBe('2026-10-25')
  })

  it('round-trips a key to local midnight and rejects impossible dates', () => {
    expect(dayStart('2026-10-25')).toBe(at(10, 25, 0))
    expect(dayStart('2026-02-31')).toBeNull()
    expect(dayStart('25/10/2026')).toBeNull()
  })

  it('shifts across month and year boundaries by whole local days', () => {
    expect(shiftDayKey('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDayKey('2026-10-25', 7)).toBe('2026-11-01')
    expect(shiftDayKey('nonsense', 1)).toBe('nonsense')
  })
})

describe('groupByDay', () => {
  it('buckets on the start day and sorts each bucket by start', () => {
    const rows = [event('late', at(10, 25, 16)), event('early', at(10, 25, 8)), event('next', at(10, 26, 9))]
    const days = groupByDay(rows)
    expect([...days.keys()]).toEqual(['2026-10-25', '2026-10-26'])
    expect(days.get('2026-10-25')!.map(row => row.id)).toEqual(['early', 'late'])
    expect(days.get('2026-10-26')!.map(row => row.id)).toEqual(['next'])
  })

  it('keeps cancelled rows but sinks them under the day they belong to', () => {
    const rows = [
      event('cancelled-early', at(10, 25, 8), { status: 'cancelled' }),
      event('live-late', at(10, 25, 17)),
      event('live-early', at(10, 25, 9))
    ]
    const day = groupByDay(rows).get('2026-10-25')!
    expect(day.map(row => row.id)).toEqual(['live-early', 'live-late', 'cancelled-early'])
  })

  it('returns an empty map for no events and does not mutate the input', () => {
    expect(groupByDay([]).size).toBe(0)
    const rows = [event('b', at(10, 25, 12)), event('a', at(10, 25, 9))]
    const snapshot = rows.map(row => row.id)
    groupByDay(rows)
    expect(rows.map(row => row.id)).toEqual(snapshot)
  })
})

describe('dotDays', () => {
  it('marks a day once no matter how many events it holds', () => {
    const rows = [event('a', at(10, 25, 9)), event('b', at(10, 25, 11)), event('c', at(10, 26, 9))]
    expect(dotDays(rows)).toEqual(new Set(['2026-10-25', '2026-10-26']))
  })

  it('leaves a day blank when every row on it was cancelled', () => {
    const rows = [event('gone', at(10, 25, 9), { status: 'cancelled' }), event('live', at(10, 27, 9))]
    expect(dotDays(rows)).toEqual(new Set(['2026-10-27']))
    expect(dotDays([]).size).toBe(0)
  })
})

describe('formatDayHeading', () => {
  it('prefixes today in Chinese and keeps the absolute date', () => {
    const heading = formatDayHeading('2026-10-25', 'zh', NOW)
    expect(heading.startsWith('今天 · ')).toBe(true)
    expect(heading).toContain('10 月 25 日')
    expect(heading).toContain('周日')
  })

  it('prefixes tomorrow in English and keeps the short date', () => {
    const heading = formatDayHeading('2026-10-26', 'en', NOW)
    expect(heading.startsWith('Tomorrow · ')).toBe(true)
    expect(heading).toContain('Mon')
    expect(heading).toContain('Oct 26')
  })

  it('uses the past prefix for yesterday and no prefix for further days', () => {
    expect(formatDayHeading('2026-10-24', 'zh', NOW).startsWith('昨天 · ')).toBe(true)
    expect(formatDayHeading('2026-10-20', 'zh', NOW)).toBe('10 月 20 日 周二')
    expect(formatDayHeading('2027-01-03', 'en', NOW)).toBe('Sun, Jan 3')
  })

  it('falls back to the raw key when the day is malformed', () => {
    expect(formatDayHeading('2026-10-99', 'zh', NOW)).toBe('2026-10-99')
  })
})

describe('sortEvents', () => {
  it('orders by start and keeps cancelled rows in place', () => {
    const rows = [event('third', at(10, 25, 18)), event('first', at(10, 25, 8), { status: 'cancelled' }), event('second', at(10, 25, 12))]
    expect(sortEvents(rows).map(row => row.id)).toEqual(['first', 'second', 'third'])
    expect(rows.map(row => row.id)).toEqual(['third', 'first', 'second'])
  })
})
