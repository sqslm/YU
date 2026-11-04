import { describe, expect, it } from 'vitest'
import { BUSY_LOOP_SOURCE, cpuMsFromTicks, perSecond } from './cpu.mjs'

describe('cpuMsFromTicks', () => {
  // The regression the review found: 10,000,000 ticks is one second of CPU,
  // and the old double division reported it as 1 ms.
  it('converts 10,000,000 ticks to 1000 ms', () => {
    expect(cpuMsFromTicks(10_000_000n)).toBe(1000)
  })

  it('keeps sub-millisecond precision', () => {
    expect(cpuMsFromTicks(1n)).toBe(0.0001)
    expect(cpuMsFromTicks(0n)).toBe(0)
    expect(cpuMsFromTicks(123_456n)).toBeCloseTo(12.3456, 10)
  })

  it('accepts numbers as well as bigints', () => {
    expect(cpuMsFromTicks(10_000)).toBe(1)
    expect(cpuMsFromTicks(25_000_000)).toBe(2500)
  })
})

describe('perSecond', () => {
  it('normalises a window to one second', () => {
    expect(perSecond(500, 2000)).toBe(250)
    expect(perSecond(1234.5, 1000)).toBe(1234.5)
  })

  it('refuses a window without duration instead of dividing by zero', () => {
    expect(perSecond(500, 0)).toBeNull()
    expect(perSecond(null, 1000)).toBeNull()
  })
})

describe('BUSY_LOOP_SOURCE', () => {
  it('spins without yielding so the child burns exactly one core', () => {
    expect(BUSY_LOOP_SOURCE).toContain('while')
    expect(BUSY_LOOP_SOURCE).not.toContain('setTimeout')
    expect(BUSY_LOOP_SOURCE).not.toContain('Atomics.wait')
  })
})
