/**
 * Geometry for the hour/minute scroll wheels.
 *
 * Kept pure and separate from the component so the rounding rules can be
 * tested without a DOM: the picker's whole job is translating between a
 * `scrollTop` in pixels and an integer value, and an off-by-one there is the
 * difference between "set 14:00" and "set 15:00".
 */

/** Height of one row, in px. Must match the row `sx` in the component. */
export const WHEEL_ROW = 32
/** Rows visible at once. Odd, so one row can sit exactly in the middle. */
export const WHEEL_VISIBLE = 5
/** Padding above the first and below the last row, so both can centre. */
export const WHEEL_PAD = ((WHEEL_VISIBLE - 1) / 2) * WHEEL_ROW

/**
 * The value a scroll position is closest to.
 *
 * Rounds to the nearest row and clamps into `[0, count - 1]`: rubber-banding at
 * the ends produces a negative `scrollTop` on some engines, and a value of -1
 * minutes would be a crash rather than a clamp.
 */
export function nearestIndex(scrollTop: number, count: number, row = WHEEL_ROW): number {
  if (!Number.isFinite(scrollTop) || count <= 0) return 0
  const index = Math.round(scrollTop / row)
  return Math.min(count - 1, Math.max(0, index))
}

/** The scroll position that centres `index`. */
export function indexOffset(index: number, row = WHEEL_ROW): number {
  return Math.max(0, index) * row
}

/** Keyboard stepping, clamped instead of wrapping (23 → 24 would be invalid). */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, index + delta))
}

/** `7` → `'07'`, the way a clock reads. */
export function pad2(value: number): string {
  return String(Math.trunc(value)).padStart(2, '0')
}
