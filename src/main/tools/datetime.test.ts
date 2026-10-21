import { describe, expect, it } from 'vitest'
import { getDateTime } from './datetime'

/**
 * "今天/明天/后天" is the one input the model cannot recover from the transcript,
 * so these cases fix the clock and pin the calendar arithmetic — including the
 * two places it usually breaks: the zone boundary and the year rollover.
 */
describe('getDateTime', () => {
  const noon = new Date('2026-10-19T04:00:00.000Z')

  it('reads the wall clock of the requested zone', () => {
    const info = getDateTime({ timezone: 'Asia/Shanghai', now: noon })
    expect(info.ok).toBe(true)
    expect(info.today).toBe('2026-10-19')
    expect(info.now).toBe('2026-10-19 12:00:00')
    expect(info.iso).toBe('2026-10-19T04:00:00.000Z')
  })

  it('labels the weekday without depending on the locale', () => {
    const info = getDateTime({ timezone: 'Asia/Shanghai', now: noon })
    expect(info.weekday).toBe('星期一')
  })

  it('gives today, tomorrow and the day after', () => {
    const info = getDateTime({ timezone: 'Asia/Shanghai', now: noon })
    expect(info.today).toBe('2026-10-19')
    expect(info.tomorrow).toBe('2026-10-20')
    expect(info.dayAfterTomorrow).toBe('2026-10-21')
    expect(info.offsetDays).toBe(0)
  })

  it('shifts the date and the weekday for offsetDays', () => {
    const info = getDateTime({ timezone: 'Asia/Shanghai', offsetDays: 1, now: noon })
    expect(info.date).toBe('2026-10-20')
    expect(info.weekday).toBe('星期二')
    // today/tomorrow stay anchored on "now", not on the offset.
    expect(info.today).toBe('2026-10-19')
  })

  it('uses the zone to decide which calendar day it is', () => {
    const lateUtc = new Date('2026-10-19T20:30:00.000Z')
    expect(getDateTime({ timezone: 'Asia/Shanghai', now: lateUtc }).today).toBe('2026-10-20')
    expect(getDateTime({ timezone: 'UTC', now: lateUtc }).today).toBe('2026-10-19')
  })

  it('rolls over the month and the year', () => {
    const endOfYear = new Date('2026-12-31T12:00:00.000Z')
    const info = getDateTime({ timezone: 'UTC', now: endOfYear })
    expect(info.today).toBe('2026-12-31')
    expect(info.tomorrow).toBe('2027-01-01')
    expect(info.dayAfterTomorrow).toBe('2027-01-02')
  })

  it('falls back to the machine zone when none is given', () => {
    const info = getDateTime({ now: noon })
    expect(info.ok).toBe(true)
    expect(info.timezone).toBeTruthy()
    expect(info.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('reports an invalid zone instead of throwing', () => {
    const info = getDateTime({ timezone: 'Mars/Olympus', now: noon })
    expect(info.ok).toBe(false)
    expect(info.error).toContain('无效的时区')
  })

  it('tolerates a non-finite offset', () => {
    const info = getDateTime({ timezone: 'UTC', offsetDays: Number.NaN, now: noon })
    expect(info.ok).toBe(true)
    expect(info.date).toBe(info.today)
  })
})
