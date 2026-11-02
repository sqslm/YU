import { describe, expect, it } from 'vitest'
import { hitClock } from './searchHitTime'

const now = new Date(2026, 10, 2, 20, 30).getTime()

describe('hitClock', () => {
  it('shows the time of day for today', () => {
    expect(hitClock(new Date(2026, 10, 2, 7, 5).getTime(), now)).toBe('07:05')
    expect(hitClock(new Date(2026, 10, 2, 19, 47).getTime(), now)).toBe('19:47')
  })

  it('shows month and day for an earlier day in the same year', () => {
    expect(hitClock(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('10-27')
    expect(hitClock(new Date(2026, 0, 1, 0, 0).getTime(), now)).toBe('01-01')
  })

  it('spells out the year when it differs', () => {
    expect(hitClock(new Date(2025, 11, 31, 12, 0).getTime(), now)).toBe('2025-12-31')
  })

  it('renders nothing for a missing or unusable timestamp', () => {
    expect(hitClock(0, now)).toBe('')
    expect(hitClock(Number.NaN, now)).toBe('')
    expect(hitClock(-5, now)).toBe('')
  })
})
