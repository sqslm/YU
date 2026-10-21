import { describe, expect, it } from 'vitest'
import { APP_COLORS, appColor, arcPath, donutSlices, piePercentages } from './pie'

describe('piePercentages', () => {
  it('adds up to exactly 100 when the shares do not divide evenly', () => {
    // 1/3 each rounds to 33+33+33 = 99 on its own; the largest remainder gives
    // the extra point to the first slice instead of losing it.
    const percents = piePercentages([3, 3, 3])
    expect(percents.reduce((sum, value) => sum + value, 0)).toBe(100)
    expect(percents).toEqual([34, 33, 33])
  })

  it('keeps a single app at 100', () => {
    expect(piePercentages([42])).toEqual([100])
  })

  it('returns zeros rather than NaN for an empty or all-zero list', () => {
    expect(piePercentages([])).toEqual([])
    expect(piePercentages([0, 0])).toEqual([0, 0])
    expect(piePercentages([Number.NaN, -3])).toEqual([0, 0])
  })

  it('is deterministic for equal remainders', () => {
    expect(piePercentages([1, 1, 1, 1, 1, 1])).toEqual([17, 17, 17, 17, 16, 16])
  })
})

describe('arcPath', () => {
  it('returns nothing for a zero-width segment', () => {
    expect(arcPath(50, 50, 44, 27, 90, 90)).toBe('')
  })

  it('draws a full turn with two outer and two inner arcs', () => {
    // One 360° arc collapses to nothing in SVG, so the full ring is assembled
    // from halves and the single-app donut stays visible.
    const path = arcPath(50, 50, 44, 27, 0, 360)
    expect(path.match(/A /g)?.length).toBe(4)
    expect(path.startsWith('M 50 6')).toBe(true)
    expect(path.trim().endsWith('Z')).toBe(true)
  })

  it('flags a segment wider than a half circle as a large arc', () => {
    const path = arcPath(50, 50, 44, 27, 0, 270)
    expect(path).toContain('A 44 44 0 1 1')
    expect(arcPath(50, 50, 44, 27, 0, 45)).toContain('A 44 44 0 0 1')
  })
})

describe('donutSlices', () => {
  it('has nothing to draw without apps or without calls', () => {
    expect(donutSlices([])).toEqual([])
    expect(donutSlices([{ name: '微信', count: 0 }])).toEqual([])
  })

  it('makes one seamless slice for a single app', () => {
    const slices = donutSlices([{ name: 'WeChat', count: 7 }])
    expect(slices).toHaveLength(1)
    expect(slices[0].percent).toBe(100)
    expect(slices[0].fraction).toBe(1)
    expect(slices[0].startAngle).toBe(0)
    expect(slices[0].endAngle).toBe(360)
    expect(slices[0].path.match(/A /g)?.length).toBe(4)
  })

  it('chains the segments so the ring closes on exactly 360', () => {
    const slices = donutSlices([
      { name: 'Chrome', count: 5 },
      { name: 'WeChat', count: 3 },
      { name: 'Code', count: 2 }
    ])

    expect(slices.map((slice) => slice.percent)).toEqual([50, 30, 20])
    expect(slices[0].startAngle).toBe(0)
    slices.forEach((slice, index) => {
      if (index > 0) expect(slice.startAngle).toBe(slices[index - 1].endAngle)
      expect(slice.endAngle).toBeGreaterThan(slice.startAngle)
      expect(slice.path.length).toBeGreaterThan(0)
    })
    expect(slices[slices.length - 1].endAngle).toBe(360)
    expect(slices.reduce((sum, slice) => sum + slice.fraction, 0)).toBeCloseTo(1, 10)
  })

  it('gives every app the colour of its own chip dot', () => {
    const slices = donutSlices([
      { name: 'A', count: 2 },
      { name: 'B', count: 1 },
      { name: 'C', count: 1 }
    ])
    slices.forEach((slice, index) => expect(slice.color).toBe(appColor(index)))
    expect(new Set(slices.map((slice) => slice.color)).size).toBe(slices.length)
  })

  it('wraps the palette without ever repeating a neighbour', () => {
    expect(appColor(APP_COLORS.length)).toBe(APP_COLORS[0])
    expect(appColor(-1)).toBe(APP_COLORS[APP_COLORS.length - 1])
  })
})
