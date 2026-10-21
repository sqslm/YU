/**
 * Donut geometry for the 热门场景 breakdown dialog.
 *
 * Pure numbers on purpose: the ring is built from `insights.apps`, the same
 * array the chips in that row render, so the picture and the chips cannot drift
 * apart. Keeping the arcs out of the component also means the two things that
 * are easy to get wrong — percentages that do not add up to 100 and a ring that
 * does not close — can be asserted without a renderer.
 */

export interface AppSliceInput {
  name: string
  count: number
}

export interface DonutOptions {
  cx?: number
  cy?: number
  outerRadius?: number
  innerRadius?: number
}

export interface DonutSlice extends AppSliceInput {
  /** Share of the listed calls, 0..1. */
  fraction: number
  /** Whole percent; the slices' labels add up to exactly 100. */
  percent: number
  /** Degrees clockwise from 12 o'clock. */
  startAngle: number
  endAngle: number
  /** SVG path of the segment, in the coordinate space of the options. */
  path: string
  /** Colour of the segment, and of the matching dot in the 热门场景 chip. */
  color: string
}

const FULL_TURN = 360

/**
 * One colour per app, in list order.
 *
 * The first two are the page's own accent blue and secondary violet; the rest
 * are muted companions at the same value level so eight segments stay
 * distinguishable on both the dark and the light panel. They are assigned by
 * position, not by name: the donut, the legend and the chip dots all read the
 * same index, which is what makes a segment traceable back to its chip.
 */
export const APP_COLORS = [
  '#4c8dff',
  '#8f7cff',
  '#3fb8a8',
  '#e0a252',
  '#7f8fa6',
  '#d16b9a',
  '#59c2e0',
  '#a3a9b5'
] as const

export function appColor(index: number): string {
  const at = ((index % APP_COLORS.length) + APP_COLORS.length) % APP_COLORS.length
  return APP_COLORS[at]
}

/** Three decimals is plenty for a 100px viewBox and keeps the path readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Point on a circle where 0° is 12 o'clock and angles grow clockwise. */
function point(cx: number, cy: number, radius: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180
  return [round(cx + radius * Math.cos(rad)), round(cy + radius * Math.sin(rad))]
}

/**
 * Whole percentages that sum to exactly 100 (largest remainder).
 *
 * Rounding each share on its own gives 33 + 33 + 33 = 99 for three equal apps,
 * which reads as a bug in a legend that is supposed to add up. Ties break by
 * list order so the same numbers always produce the same labels.
 */
export function piePercentages(counts: readonly number[]): number[] {
  const safe = counts.map((count) => (Number.isFinite(count) && count > 0 ? count : 0))
  if (safe.length === 0) return []
  const total = safe.reduce((sum, count) => sum + count, 0)
  if (total <= 0) return safe.map(() => 0)

  const raw = safe.map((count) => (count / total) * 100)
  const out = raw.map((value) => Math.floor(value))
  let rest = 100 - out.reduce((sum, value) => sum + value, 0)
  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => (b.remainder !== a.remainder ? b.remainder - a.remainder : a.index - b.index))
  for (let i = 0; i < order.length && rest > 0; i += 1) {
    out[order[i].index] += 1
    rest -= 1
  }
  return out
}

/**
 * SVG path for one donut segment.
 *
 * A segment that spans the whole turn is drawn as two half arcs plus a reversed
 * inner pair: a single 360° arc ends where it started, which SVG collapses to
 * nothing, and the single-app case is exactly the one users hit on day one.
 */
export function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const sweep = endAngle - startAngle
  if (!(sweep > 0)) return ''

  if (sweep >= FULL_TURN - 0.01) {
    const [ox0, oy0] = point(cx, cy, outerRadius, startAngle)
    const [ox1, oy1] = point(cx, cy, outerRadius, startAngle + 180)
    const [ox2, oy2] = point(cx, cy, outerRadius, startAngle + FULL_TURN)
    const [ix0, iy0] = point(cx, cy, innerRadius, startAngle + FULL_TURN)
    const [ix1, iy1] = point(cx, cy, innerRadius, startAngle + 180)
    const [ix2, iy2] = point(cx, cy, innerRadius, startAngle)
    return [
      `M ${ox0} ${oy0}`,
      `A ${outerRadius} ${outerRadius} 0 0 1 ${ox1} ${oy1}`,
      `A ${outerRadius} ${outerRadius} 0 0 1 ${ox2} ${oy2}`,
      `L ${ix0} ${iy0}`,
      `A ${innerRadius} ${innerRadius} 0 0 0 ${ix1} ${iy1}`,
      `A ${innerRadius} ${innerRadius} 0 0 0 ${ix2} ${iy2}`,
      'Z'
    ].join(' ')
  }

  const largeArc = sweep > 180 ? 1 : 0
  const [sx, sy] = point(cx, cy, outerRadius, startAngle)
  const [ex, ey] = point(cx, cy, outerRadius, endAngle)
  const [tx, ty] = point(cx, cy, innerRadius, endAngle)
  const [bx, by] = point(cx, cy, innerRadius, startAngle)
  return [
    `M ${sx} ${sy}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${ex} ${ey}`,
    `L ${tx} ${ty}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${bx} ${by}`,
    'Z'
  ].join(' ')
}

/**
 * Donut segments from the per-app counts, clockwise from 12 o'clock.
 *
 * The last segment is pinned to exactly 360° instead of trusting the accumulated
 * float: a 0.0001° shortfall shows up as a hairline gap in the ring, and the
 * labels would still claim the app holds its full share.
 */
export function donutSlices(
  apps: readonly AppSliceInput[],
  options: DonutOptions = {}
): DonutSlice[] {
  const { cx = 50, cy = 50, outerRadius = 44, innerRadius = 27 } = options
  const counts = apps.map((app) => (Number.isFinite(app.count) && app.count > 0 ? app.count : 0))
  const total = counts.reduce((sum, count) => sum + count, 0)
  // Nothing to draw: an empty ring reads as a broken chart, so the dialog shows
  // its own sentence instead.
  if (apps.length === 0 || total <= 0) return []

  const percents = piePercentages(counts)
  let cursor = 0
  return apps.map((app, index) => {
    const count = counts[index]
    const fraction = count / total
    const startAngle = cursor
    const endAngle = index === apps.length - 1 ? FULL_TURN : cursor + fraction * FULL_TURN
    cursor = endAngle
    return {
      name: app.name,
      count,
      fraction,
      percent: percents[index] ?? 0,
      startAngle,
      endAngle,
      path: arcPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle),
      color: appColor(index)
    }
  })
}
