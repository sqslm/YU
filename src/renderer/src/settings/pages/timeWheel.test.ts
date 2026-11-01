import { describe, expect, it } from 'vitest'
import { indexOffset, nearestIndex, pad2, stepIndex, WHEEL_PAD, WHEEL_ROW } from './timeWheel'

describe('wheel geometry', () => {
  it('centres the first and last row', () => {
    // The padding exists so value 0 and value 23 can both sit under the band.
    expect(indexOffset(0)).toBe(0)
    expect(indexOffset(23)).toBe(23 * WHEEL_ROW)
    expect(WHEEL_PAD).toBe(2 * WHEEL_ROW)
  })

  it('rounds a scroll position to the nearest value', () => {
    expect(nearestIndex(0, 60)).toBe(0)
    expect(nearestIndex(WHEEL_ROW * 7, 60)).toBe(7)
    // 40% into a row is still the row above; 60% is the row below.
    expect(nearestIndex(WHEEL_ROW * 7 + WHEEL_ROW * 0.4, 60)).toBe(7)
    expect(nearestIndex(WHEEL_ROW * 7 + WHEEL_ROW * 0.6, 60)).toBe(8)
  })

  it('clamps instead of returning an impossible value', () => {
    // Rubber-band overscroll reports negative scrollTop on some engines.
    expect(nearestIndex(-48, 60)).toBe(0)
    expect(nearestIndex(WHEEL_ROW * 999, 60)).toBe(59)
    expect(nearestIndex(Number.NaN, 60)).toBe(0)
    expect(nearestIndex(100, 0)).toBe(0)
  })

  it('steps without wrapping', () => {
    expect(stepIndex(0, -1, 24)).toBe(0)
    expect(stepIndex(23, 1, 24)).toBe(23)
    expect(stepIndex(10, 5, 60)).toBe(15)
    expect(stepIndex(58, 5, 60)).toBe(59)
  })

  it('pads to two digits', () => {
    expect(pad2(0)).toBe('00')
    expect(pad2(7)).toBe('07')
    expect(pad2(59)).toBe('59')
  })
})
