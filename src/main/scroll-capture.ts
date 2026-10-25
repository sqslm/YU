/** Mean RGB difference over a grid, comparing the overlapping part of two frames. */
function difference(previous: Uint8Array, next: Uint8Array, width: number, height: number, offset = 0, top = 0, bottom = 0): number {
  let total = 0, count = 0
  const overlap = height - offset - bottom, margin = Math.max(1, Math.floor(width * .03))
  for (let y = top; y < overlap; y += Math.max(1, Math.floor((overlap - top) / 28))) {
    for (let x = margin; x < width - margin; x += Math.max(1, Math.floor(width / 64))) {
      const a = ((y + offset) * width + x) * 4, b = (y * width + x) * 4
      // A blinking caret or pointer should not outweigh otherwise identical content.
      for (let c = 0; c < 3; c++) { total += Math.min(30, Math.abs(previous[a + c] - next[b + c])); count++ }
    }
  }
  return total / Math.max(1, count)
}

/** Match content, never assume a wheel notch equals a fixed number of pixels. */
export function findScrollOffset(previous: Uint8Array, next: Uint8Array, width: number, height: number): number | null {
  return matchScroll(previous, next, width, height)?.offset ?? null
}

function stationaryEdge(previous: Uint8Array, next: Uint8Array, width: number, height: number, bottom: boolean): number {
  const limit = Math.floor(height / 3)
  for (let row = 0; row < limit; row++) {
    const y = bottom ? height - row - 1 : row
    let sum = 0, count = 0
    for (let x = 2; x < width - 2; x += Math.max(1, Math.floor(width / 64))) {
      const index = (y * width + x) * 4
      for (let c = 0; c < 3; c++) { sum += Math.abs(previous[index + c] - next[index + c]); count++ }
    }
    if (sum / Math.max(1, count) > 2) return row > 1 ? row : 0
  }
  return 0
}

function matchScroll(previous: Uint8Array, next: Uint8Array, width: number, height: number): { offset: number; top: number; bottom: number } | null {
  if (difference(previous, next, width, height) < .5) return { offset: 0, top: 0, bottom: 0 }
  const top = stationaryEdge(previous, next, width, height, false), bottom = stationaryEdge(previous, next, width, height, true)
  const contentHeight = height - top - bottom
  const unchanged = difference(previous, next, width, height, 0, top, bottom)
  let best = Infinity, offset = 0, second = Infinity
  const scores: number[] = []
  for (let step = 1; step <= contentHeight - Math.max(24, Math.ceil(contentHeight * .2)); step++) {
    const score = difference(previous, next, width, height, step, top, bottom)
    scores[step] = score
    if (score < best) { best = score; offset = step }
  }
  for (let step = 1; step < scores.length; step++) if (Math.abs(step - offset) > 2) second = Math.min(second, scores[step])
  // Ambiguous/repeating or unrelated content must never be silently joined.
  return best < 3 && best + .5 < unchanged && best + .25 < second ? { offset, top, bottom } : null
}

export type ScrollCaptureStatus = 'waiting' | 'added' | 'unchanged' | 'unmatched' | 'limit'

/** Keep only accepted rows plus two viewport frames; release everything on close. */
export class ScrollCapture {
  private chunks: Buffer[] = []
  private previous: Buffer | null = null
  private sample: Buffer | null = null
  private footer = Buffer.alloc(0)
  private fixedBottom: number | null = null
  height = 0
  frames = 0
  constructor(readonly width: number, readonly viewportHeight: number, private maxPixels = 32_000_000) {}

  add(pixels: Buffer): ScrollCaptureStatus {
    if (pixels.length !== this.width * this.viewportHeight * 4) throw new Error('Invalid scroll capture frame')
    if (!this.previous) {
      if (this.width * this.viewportHeight > this.maxPixels) return 'limit'
      this.previous = pixels; this.sample = pixels; this.chunks.push(pixels)
      this.height = this.viewportHeight; this.frames = 1; return 'added'
    }
    const stable = this.sample && difference(this.sample, pixels, this.width, this.viewportHeight) < .5
    this.sample = pixels
    if (!stable) return 'waiting'
    const match = matchScroll(this.previous, pixels, this.width, this.viewportHeight)
    const offset = match?.offset ?? null
    if (offset === 0) return 'unchanged'
    if (offset === null) return 'unmatched'
    if (this.width * (this.height + offset) > this.maxPixels || this.height + offset > 30_000) return 'limit'
    const bottom = Math.min(this.fixedBottom ?? match!.bottom, match!.bottom), stride = this.width * 4
    if (this.fixedBottom === null) {
      if (bottom) this.chunks[this.chunks.length - 1] = this.chunks.at(-1)!.subarray(0, -bottom * stride)
    } else if (bottom < this.fixedBottom) {
      // Shared blank content can initially look like part of the fixed footer.
      // Restore those rows as content when a later frame reveals the boundary.
      this.chunks.push(this.footer.subarray(0, (this.fixedBottom - bottom) * stride))
    }
    this.fixedBottom = bottom
    this.chunks.push(Buffer.from(pixels.subarray((this.viewportHeight - bottom - offset) * stride, (this.viewportHeight - bottom) * stride)))
    this.footer = bottom ? Buffer.from(pixels.subarray((this.viewportHeight - bottom) * stride)) : Buffer.alloc(0)
    this.height += offset; this.frames++; this.previous = pixels
    return 'added'
  }

  pixels(): Buffer { return Buffer.concat([...this.chunks, this.footer]) }
}
