import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asrLatencyFor,
  asrSampleCount,
  asrUnavailableReason,
  markAsrProfileUnavailable,
  orderAsrProfiles,
  recordAsrLatency,
  resetAsrLatency
} from './latency'

// Sampling policy: a profile needs three successful takes before its timing is
// trusted, because a cold socket or a first model load is a once-off. Until
// then nothing is reordered and the user's chain order stands.

function profile(id: string): { id: string } {
  return { id }
}

afterEach(() => resetAsrLatency())

describe('recordAsrLatency', () => {
  it('needs three successful takes before a number is trusted', () => {
    recordAsrLatency('p1', 900)
    expect(asrSampleCount('p1')).toBe(1)
    expect(asrLatencyFor('p1')).toBeNull()
    recordAsrLatency('p1', 900)
    expect(asrLatencyFor('p1')).toBeNull()
    recordAsrLatency('p1', 900)
    expect(asrSampleCount('p1')).toBe(3)
    expect(asrLatencyFor('p1')).toBe(900)
  })

  it('is an exponential moving average, so one slow take does not erase the history', () => {
    for (const ms of [1000, 1000, 1000]) recordAsrLatency('p1', ms)
    expect(asrLatencyFor('p1')).toBe(1000)
    recordAsrLatency('p1', 2000)
    // 1000 + 0.4 * (2000 - 1000)
    expect(asrLatencyFor('p1')).toBe(1400)
    recordAsrLatency('p1', 2000)
    expect(asrLatencyFor('p1')).toBeCloseTo(1640, 5)
  })

  it('ignores a sample it cannot attribute or trust', () => {
    recordAsrLatency('', 1000)
    recordAsrLatency('   ', 1000)
    recordAsrLatency('p1', Number.NaN)
    recordAsrLatency('p1', 0)
    recordAsrLatency('p1', -5)
    expect(asrSampleCount('p1')).toBe(0)
    expect(asrLatencyFor('p1')).toBeNull()
  })

  it('accepts a numeric id as a string and clamps a runaway sample', () => {
    recordAsrLatency(7 as unknown as string, 300)
    expect(asrLatencyFor('7')).toBeNull()
    recordAsrLatency('7', 300)
    recordAsrLatency('7', 300)
    expect(asrLatencyFor('7')).toBe(300)
    // A "take" of an hour is a hang, not a measurement.
    for (let i = 0; i < 20; i++) recordAsrLatency('slow', 3_600_000)
    expect(asrLatencyFor('slow')).toBeLessThanOrEqual(120_000)
  })
})

describe('orderAsrProfiles', () => {
  it('leaves the chain exactly as configured while nothing is measured', () => {
    const chain = [profile('a'), profile('b'), profile('c')]
    expect(orderAsrProfiles(chain).map((p) => p.id)).toEqual(['a', 'b', 'c'])
    // Two samples is still not a measurement.
    recordAsrLatency('c', 100)
    recordAsrLatency('c', 100)
    expect(orderAsrProfiles(chain).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('puts measured profiles first, fastest first, and keeps the rest in chain order', () => {
    for (const ms of [1200, 1200, 1200]) recordAsrLatency('slow', ms)
    for (const ms of [400, 400, 400]) recordAsrLatency('fast', ms)
    const chain = [profile('slow'), profile('unknown-1'), profile('fast'), profile('unknown-2')]
    expect(orderAsrProfiles(chain).map((p) => p.id)).toEqual(['fast', 'slow', 'unknown-1', 'unknown-2'])
  })

  it('is stable for equal measurements: ties keep the user order', () => {
    for (const id of ['a', 'b']) {
      for (const ms of [500, 500, 500]) recordAsrLatency(id, ms)
    }
    expect(orderAsrProfiles([profile('a'), profile('b')]).map((p) => p.id)).toEqual(['a', 'b'])
    expect(orderAsrProfiles([profile('b'), profile('a')]).map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('never mutates the input and survives the degenerate cases', () => {
    for (const ms of [800, 800, 800]) recordAsrLatency('z', ms)
    const chain = [profile('a'), profile('z')]
    const copy = [...chain]
    orderAsrProfiles(chain)
    expect(chain).toEqual(copy)
    expect(orderAsrProfiles([])).toEqual([])
    expect(orderAsrProfiles([profile('only')])).toEqual([profile('only')])
  })

  it('forgets everything on reset', () => {
    for (const ms of [100, 100, 100]) recordAsrLatency('p1', ms)
    expect(asrLatencyFor('p1')).toBe(100)
    resetAsrLatency()
    expect(asrLatencyFor('p1')).toBeNull()
    expect(asrSampleCount('p1')).toBe(0)
  })
})

// A quota or auth answer is not a latency problem: the profile is benched for a
// while and the chain tries it last, so the take does not pay for it first.
describe('benched profiles', () => {
  it('keeps a benched profile in the chain but last', () => {
    resetAsrLatency()
    const profiles = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    markAsrProfileUnavailable('a', 'AllocationQuota.FreeTierOnly')
    expect(orderAsrProfiles(profiles).map((profile) => profile.id)).toEqual(['b', 'c', 'a'])
    expect(asrUnavailableReason('a')).toContain('AllocationQuota')
    expect(asrUnavailableReason('b')).toBeNull()
  })

  it('forgets the bench when its time is up', () => {
    vi.useFakeTimers()
    try {
      resetAsrLatency()
      markAsrProfileUnavailable('a', 'invalid api key', 1000)
      expect(asrUnavailableReason('a')).toBeTruthy()
      vi.advanceTimersByTime(1001)
      expect(asrUnavailableReason('a')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
