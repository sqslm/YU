import { describe, expect, it } from 'vitest'
import {
  CARD_FALLBACK_BOTTOM,
  CARD_GAP,
  CARD_MARGIN,
  CARD_INITIAL_HEIGHT,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  type Rect,
  cardRect,
  clampCardHeight
} from './cardLayout'

/**
 * The card geometry is a pure function so it can be verified without an
 * Electron process; `windows.ts` itself imports `electron` and therefore cannot
 * be loaded by the Node test runner. The cases below are exactly the placement
 * rules the window code follows.
 */

const FHD: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
const CARD = { width: 560, height: 380 }

describe('cardRect', () => {
  it('centres the card above the pill with a 10px gap', () => {
    const rect = cardRect({
      ...CARD,
      bar: { x: 790, y: 800, width: 340, height: 60 },
      workArea: FHD
    })
    expect(rect.anchor).toBe('above')
    expect(rect.x).toBe(680) // 790 + (340 - 560) / 2
    expect(rect.y).toBe(800 - CARD_GAP - 380)
    expect(rect.width).toBe(560)
    expect(rect.height).toBe(380)
  })

  it('falls below the pill when there is no room above it', () => {
    const rect = cardRect({
      ...CARD,
      bar: { x: 100, y: 20, width: 340, height: 60 },
      workArea: FHD
    })
    expect(rect.anchor).toBe('below')
    expect(rect.y).toBe(20 + 60 + CARD_GAP)
    // x would be -10 before clamping: the card must stay on screen.
    expect(rect.x).toBe(FHD.x + CARD_MARGIN)
  })

  it('keeps the card inside the work area when neither side fits', () => {
    const rect = cardRect({
      ...CARD,
      bar: { x: 700, y: 20, width: 340, height: 60 },
      workArea: { x: 0, y: 0, width: 1920, height: 300 }
    })
    expect(rect.anchor).toBe('above')
    expect(rect.y).toBe(CARD_MARGIN)
  })

  it('clamps the card against the right work-area edge', () => {
    const rect = cardRect({
      ...CARD,
      bar: { x: 1800, y: 800, width: 340, height: 60 },
      workArea: FHD
    })
    expect(rect.x).toBe(FHD.width - CARD_MARGIN - CARD.width)
  })

  it('falls back to bottom-centre when the pill position is unknown', () => {
    const rect = cardRect({ ...CARD, bar: null, workArea: FHD })
    expect(rect.anchor).toBe('screen')
    expect(rect.x).toBe(Math.round((FHD.width - CARD.width) / 2))
    expect(rect.y).toBe(FHD.height - CARD_FALLBACK_BOTTOM - CARD.height)
  })

  it('stays on the pill display on a second monitor with its own origin', () => {
    const second: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }
    const rect = cardRect({
      ...CARD,
      bar: { x: 2920, y: 900, width: 340, height: 60 },
      workArea: second
    })
    expect(rect.anchor).toBe('above')
    expect(rect.x).toBe(2810)
    expect(rect.y).toBe(510)
    // The whole card lives inside that monitor, not on the primary one.
    expect(rect.x).toBeGreaterThanOrEqual(second.x)
    expect(rect.x + rect.width).toBeLessThanOrEqual(second.x + second.width)
  })

  it('treats a zero-sized pill as unknown instead of dividing by it', () => {
    const rect = cardRect({
      ...CARD,
      bar: { x: 0, y: 0, width: 0, height: 0 },
      workArea: FHD
    })
    expect(rect.anchor).toBe('screen')
  })
})

describe('clampCardHeight', () => {
  it('keeps short answers at the minimum height', () => {
    expect(clampCardHeight(120)).toBe(CARD_MIN_HEIGHT)
  })

  it('caps long answers and lets the body scroll instead', () => {
    expect(clampCardHeight(900)).toBe(CARD_MAX_HEIGHT)
  })

  it('passes a normal height through unchanged', () => {
    expect(clampCardHeight(412.4)).toBe(412)
  })

  it('falls back to the initial height for a non-finite report', () => {
    expect(clampCardHeight(Number.NaN)).toBe(CARD_INITIAL_HEIGHT)
  })
})
