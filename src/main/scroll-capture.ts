/** Mean RGB difference over a grid, comparing the overlapping part of two frames. */
function difference(previous: Uint8Array, next: Uint8Array, width: number, height: number, offset = 0, top = 0, bottom = 0, changed?: Uint8Array): number {
  let total = 0, count = 0
  const sums = [0, 0, 0], counts = [0, 0, 0], possible = [0, 0, 0]
  const overlap = height - offset - bottom, margin = Math.max(1, Math.floor(width * .03))
  for (let y = top; y < overlap; y += Math.max(1, Math.floor((overlap - top) / 28))) {
    for (let x = margin; x < width - margin; x += Math.max(1, Math.floor(width / 64))) {
      const a = ((y + offset) * width + x) * 4, b = (y * width + x) * 4
      const band = Math.min(2, Math.floor((y - top) * 3 / (overlap - top)))
      if (changed) {
        if (changed[a / 4] || changed[b / 4]) possible[band]++
        if (!changed[a / 4] || !changed[b / 4]) continue
      }
      // A blinking caret or pointer should not outweigh otherwise identical content.
      for (let c = 0; c < 3; c++) { const error = Math.min(30, Math.abs(previous[a + c] - next[b + c])); total += error; count++; sums[band] += error; counts[band]++ }
    }
  }
  if (!changed) return total / Math.max(1, count)
  // Require evidence across the overlap, not a matching pointer or a few dots.
  if (counts.some((n, band) => n < 12 || n < possible[band] * .6)) return Infinity
  // A localized translucent cursor/glow cannot outweigh two clean text bands.
  return sums.map((sum, band) => sum / counts[band]).sort((a, b) => a - b)[1]
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
  const changed = new Uint8Array(width * height)
  for (let pixel = 0; pixel < changed.length; pixel++) {
    const i = pixel * 4
    changed[pixel] = Number(Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]) > 12)
  }
  let best = Infinity, offset = 0, second = Infinity
  const scores: number[] = []
  for (let step = 1; step <= contentHeight - Math.max(24, Math.ceil(contentHeight * .2)); step++) {
    const score = difference(previous, next, width, height, step, top, bottom, changed)
    scores[step] = score
    if (score < best) { best = score; offset = step }
  }
  for (let step = 1; step < scores.length; step++) if (Math.abs(step - offset) > 2) second = Math.min(second, scores[step])
  // Ambiguous/repeating or unrelated content must never be silently joined.
  return best < 3 && best + .5 < unchanged && best + .25 < second ? { offset, top, bottom } : null
}

export type ScrollCaptureStatus = 'added' | 'unchanged' | 'unmatched' | 'limit'

/** Match every captured frame, including during continuous scrolling. */
export class ScrollCapture {
  private chunks: Buffer[] = []
  private previous: Buffer | null = null
  private footer = Buffer.alloc(0)
  private fixedBottom: number | null = null
  height = 0
  frames = 0
  constructor(readonly width: number, readonly viewportHeight: number, private maxPixels = 32_000_000) {}

  add(pixels: Buffer): ScrollCaptureStatus {
    if (pixels.length !== this.width * this.viewportHeight * 4) throw new Error('Invalid scroll capture frame')
    if (!this.previous) {
      if (this.width * this.viewportHeight > this.maxPixels) return 'limit'
      this.previous = pixels; this.chunks.push(pixels)
      this.height = this.viewportHeight; this.frames = 1; return 'added'
    }
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

  /** Sample a bounded thumbnail without copying the full (up to 128 MB) long image. */
  preview(): { pixels: Buffer; width: number; height: number } {
    const scale = Math.min(1, 120 / this.width, 600 / this.height)
    const width = Math.max(1, Math.round(this.width * scale)), height = Math.max(1, Math.round(this.height * scale))
    const pixels = Buffer.alloc(width * height * 4), chunks = [...this.chunks, this.footer]
    let index = 0, base = 0
    for (let y = 0; y < height; y++) {
      const row = Math.min(this.height - 1, Math.floor((y + .5) * this.height / height)) * this.width * 4
      while (index < chunks.length - 1 && base + chunks[index].length <= row) base += chunks[index++].length
      for (let x = 0; x < width; x++) {
        const from = row - base + Math.min(this.width - 1, Math.floor((x + .5) * this.width / width)) * 4
        chunks[index].copy(pixels, (y * width + x) * 4, from, from + 4)
      }
    }
    return { pixels, width, height }
  }
}
