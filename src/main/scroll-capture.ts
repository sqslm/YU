import { matchScroll } from './scroll-match'

/** Match content, never assume a wheel notch equals a fixed number of pixels. */
export function findScrollOffset(previous: Uint8Array, next: Uint8Array, width: number, height: number): number | null {
  return matchScroll(previous, next, width, height)?.offset ?? null
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
