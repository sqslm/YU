import { describe, expect, it } from 'vitest'
import { barCaptionRect } from './barLayout'

const work = { x: 0, y: 0, width: 1920, height: 1040 }
const bar = { x: 790, y: 800, width: 340, height: 60 }

describe('caption window geometry', () => {
  it('expands above the strip without moving it and collapses to its saved bounds', () => {
    const { bounds, layout } = barCaptionRect(bar, work, true)
    expect(bounds).toEqual({ x: 790, y: 732, width: 340, height: 128 })
    expect(layout).toEqual({ barTop: 68, captionSide: 'above' })
    expect(bounds.x).toBe(bar.x)
    expect(bounds.y + layout.barTop).toBe(bar.y)
    expect(barCaptionRect(bar, work, false).bounds).toEqual(bar)
  })
  it('flips the bubble below the strip near the top edge', () => {
    const { bounds, layout } = barCaptionRect({ ...bar, y: 4 }, work, true)
    expect(bounds.y).toBe(4)
    expect(layout.barTop).toBe(0)
    expect(layout.captionSide).toBe('below')
  })
  it.each([0, 1580])('keeps the bubble on screen at horizontal edge %s', x => {
    const { bounds } = barCaptionRect({ ...bar, x }, work, true)
    expect(bounds.x).toBeGreaterThanOrEqual(work.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(work.width)
    expect(bounds.x).toBe(x)
  })
  it('uses the strip monitor, including negative coordinates and narrow displays', () => {
    const area = { x: -450, y: -200, width: 450, height: 900 }
    const base = { ...bar, x: -400, y: -190 }
    const { bounds, layout } = barCaptionRect(base, area, true)
    expect(bounds.x).toBe(-400)
    expect(bounds.width).toBe(340)
    expect(bounds.y).toBe(-190)
    expect(bounds.x).toBe(base.x)
    expect(layout.captionSide).toBe('below')
  })
})
