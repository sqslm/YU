/**
 * Pure geometry for the Ask Anything answer card.
 *
 * The card grows out of the recording bar: it is centred on the pill and its
 * bottom edge sits just above the pill's top edge, flipping below the pill only
 * when there is not enough room above (the bar can live anywhere on any
 * monitor, including the very top of the screen).
 *
 * This module deliberately imports nothing from `electron`: the Windows-facing
 * wrappers live in `windows.ts`, and keeping the maths separate means it can be
 * unit-tested in the plain Node test runner.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Fixed card width: the card is a column of text, never a resizable panel. */
export const CARD_WIDTH = 560
/** Height used before the renderer has reported its content. */
export const CARD_INITIAL_HEIGHT = 380
/** The card never collapses below this, even for a one-word answer. */
export const CARD_MIN_HEIGHT = 220
/** The card never grows past this; the answer body scrolls instead. */
export const CARD_MAX_HEIGHT = 520
/** Breathing room between the pill and the card. */
export const CARD_GAP = 10
/** Free space kept between the card and every work-area edge. */
export const CARD_MARGIN = 8
/** Legacy bottom lift, only used when no bar bounds are known at all. */
export const CARD_FALLBACK_BOTTOM = 80

/**
 * Where the card ended up:
 * - `above`  — the normal case, floating on top of the pill
 * - `below`  — the pill is too close to the top of the work area
 * - `screen` — no pill position known yet, old bottom-centre behaviour
 */
export type CardAnchor = 'above' | 'below' | 'screen'

export interface CardRectInput {
  /** Card width in device-independent pixels. */
  width: number
  /** Card height in device-independent pixels. */
  height: number
  /** Current pill bounds in screen DIP, or null when the pill is unknown. */
  bar: Rect | null
  /** `workArea` of the display that owns the pill (taskbar already excluded). */
  workArea: Rect
  /** Override for the pill→card gap. */
  gap?: number
  /** Override for the work-area margin. */
  margin?: number
}

export interface CardRect extends Rect {
  anchor: CardAnchor
}

function clamp(value: number, min: number, max: number): number {
  // The card can be larger than the work area on a tiny screen; in that case
  // pinning it to the top/left edge keeps the header (and the ✕) reachable.
  if (max < min) return Math.round(min)
  return Math.round(Math.min(Math.max(value, min), max))
}

/**
 * Computes the window rectangle for the card.
 *
 * Every coordinate is relative to the passed `workArea`, so a bar on a second
 * monitor with a different DPI scale lands on that monitor's work area rather
 * than on the primary display's — the caller passes the work area of the
 * display that owns the bar.
 */
export function cardRect(input: CardRectInput): CardRect {
  const width = Math.max(1, Math.round(input.width))
  const height = Math.max(1, Math.round(input.height))
  const gap = input.gap ?? CARD_GAP
  const margin = input.margin ?? CARD_MARGIN

  const area = input.workArea
  const left = area.x + margin
  const right = area.x + area.width - margin - width
  const top = area.y + margin
  const bottom = area.y + area.height - margin - height

  const bar = input.bar
  if (bar && bar.width > 0 && bar.height > 0) {
    const x = clamp(bar.x + (bar.width - width) / 2, left, right)
    const above = bar.y - gap - height
    const below = bar.y + bar.height + gap

    if (above >= top) {
      return { x, y: Math.round(above), width, height, anchor: 'above' }
    }
    if (below <= bottom) {
      return { x, y: clamp(below, top, bottom), width, height, anchor: 'below' }
    }
    // Neither side has room (huge card, tiny work area): stay above the pill
    // and let the clamp pull the card back onto the screen.
    return { x, y: clamp(above, top, bottom), width, height, anchor: 'above' }
  }

  // No pill position known yet (very first show): old bottom-centre spot.
  const x = clamp(area.x + (area.width - width) / 2, left, right)
  const y = clamp(area.y + area.height - CARD_FALLBACK_BOTTOM - height, top, bottom)
  return { x, y, width, height, anchor: 'screen' }
}

/** Clamps a renderer-reported content height into the allowed window range. */
export function clampCardHeight(height: number): number {
  if (!Number.isFinite(height)) return CARD_INITIAL_HEIGHT
  return Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, Math.round(height)))
}
