/** Mean RGB difference over a grid, comparing the overlapping part of two frames. */
function difference(previous: Uint8Array, next: Uint8Array, width: number, height: number, offset = 0): number {
  let total = 0, count = 0
  const overlap = height - offset, margin = Math.max(1, Math.floor(width * .03))
  for (let y = 0; y < overlap; y += Math.max(1, Math.floor(overlap / 28))) {
    for (let x = margin; x < width - margin; x += Math.max(1, Math.floor(width / 64))) {
      const a = ((y + offset) * width + x) * 4, b = (y * width + x) * 4
      for (let c = 0; c < 3; c++) { total += Math.abs(previous[a + c] - next[b + c]); count++ }
    }
  }
  return total / Math.max(1, count)
}

/** Match content, never assume a wheel notch equals a fixed number of pixels. */
export function findScrollOffset(previous: Uint8Array, next: Uint8Array, width: number, height: number): number | null {
  const unchanged = difference(previous, next, width, height)
  if (unchanged < .5) return 0
  let best = Infinity, offset = 0, second = Infinity
  const scores: number[] = []
  for (let step = 1; step <= height - Math.max(24, Math.ceil(height * .2)); step++) {
    const score = difference(previous, next, width, height, step)
    scores[step] = score
    if (score < best) { best = score; offset = step }
  }
  for (let step = 1; step < scores.length; step++) if (Math.abs(step - offset) > 2) second = Math.min(second, scores[step])
  // Ambiguous/repeating or unrelated content must never be silently joined.
  return best < 6 && best + .5 < unchanged && best + .25 < second ? offset : null
}

export type ScrollCaptureStatus = 'waiting' | 'added' | 'unchanged' | 'unmatched' | 'limit'

/** Keep only accepted rows plus two viewport frames; release everything on close. */
export class ScrollCapture {
  private chunks: Buffer[] = []
  private previous: Buffer | null = null
  private sample: Buffer | null = null
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
    const offset = findScrollOffset(this.previous, pixels, this.width, this.viewportHeight)
    if (offset === 0) return 'unchanged'
    if (offset === null) return 'unmatched'
    if (this.width * (this.height + offset) > this.maxPixels || this.height + offset > 30_000) return 'limit'
    this.chunks.push(Buffer.from(pixels.subarray((this.viewportHeight - offset) * this.width * 4)))
    this.height += offset; this.frames++; this.previous = pixels
    return 'added'
  }

  pixels(): Buffer { return Buffer.concat(this.chunks) }
}
