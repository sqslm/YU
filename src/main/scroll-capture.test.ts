import { expect, it } from 'vitest'
import { ScrollCapture, findScrollOffset } from './scroll-capture'

const width = 120, height = 100
function page(top: number, seed = 7): Buffer {
  const data = Buffer.alloc(width * height * 4, 255)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = ((y + top) * 1337 + x * 311 + seed * 97) >>> 0
    const shade = ((value ^ (value >>> 5)) * 13) & 255
    const i = (y * width + x) * 4
    data[i] = shade; data[i + 1] = shade; data[i + 2] = shade
  }
  return data
}
it('finds real overlap for downward scrolling and ignores unchanged frames', () => {
  expect(findScrollOffset(page(0), page(37), width, height)).toBe(37)
  expect(findScrollOffset(page(0), page(0), width, height)).toBe(0)
  expect(findScrollOffset(page(0), page(200), width, height)).toBeNull()
})
it('stitches a moving frame immediately and preserves all pixels without waiting for a duplicate', () => {
  const capture = new ScrollCapture(width, height)
  expect(capture.add(page(0))).toBe('added')
  expect(capture.add(page(37))).toBe('added')
  expect(capture.add(page(37))).toBe('unchanged')
  expect(capture.height).toBe(137)
  expect(capture.pixels()).toEqual(Buffer.concat([page(0), page(37).subarray((height - 37) * width * 4)]))
})
it('refuses upward scrolling, unrelated content and memory growth beyond the cap', () => {
  const capture = new ScrollCapture(width, height, width * 120)
  capture.add(page(37))
  expect(capture.add(page(0))).toBe('unmatched')
  expect(capture.add(page(74))).toBe('limit')
  expect(capture.height).toBe(height)
})

it('keeps a fixed header and footer once while preserving every scrolling row', () => {
  const frame = (top: number): Buffer => {
    const pixels = page(top)
    pixels.fill(40, 0, width * 10 * 4)
    pixels.fill(80, width * 90 * 4)
    return pixels
  }
  const capture = new ScrollCapture(width, height)
  capture.add(frame(0))
  expect(capture.add(frame(31))).toBe('added')
  expect(capture.add(frame(62))).toBe('added')
  const expected = Buffer.concat([frame(0).subarray(0, width * 90 * 4),
    frame(31).subarray(width * 59 * 4, width * 90 * 4), frame(62).subarray(width * 59 * 4)])
  expect(capture.height).toBe(162)
  expect(capture.pixels()).toEqual(expected)
})

it('does not treat matching blank content above a footer as a permanent fixed band', () => {
  const frame = (top: number): Buffer => {
    const pixels = page(top)
    for (let y = 0; y < height; y++) if ((y + top >= 86 && y + top <= 89) || (y + top >= 117 && y + top <= 120)) pixels.fill(255, y * width * 4, (y + 1) * width * 4)
    pixels.fill(40, 0, width * 10 * 4); pixels.fill(80, width * 90 * 4)
    return pixels
  }
  const capture = new ScrollCapture(width, height)
  capture.add(frame(0)); expect(capture.add(frame(31))).toBe('added')
  expect(capture.add(frame(62))).toBe('added')
  expect(capture.pixels()).toEqual(Buffer.concat([frame(0).subarray(0, width * 90 * 4),
    frame(31).subarray(width * 59 * 4, width * 90 * 4), frame(62).subarray(width * 59 * 4)]))
})

it('captures an uninterrupted sequence of distinct moving frames without duplicate or missing rows', () => {
  const capture = new ScrollCapture(width, height), expected = [page(0)]
  capture.add(page(0))
  for (let index = 1; index <= 20; index++) {
    const frame = page(index * 27)
    expect(capture.add(frame)).toBe('added')
    expected.push(frame.subarray((height - 27) * width * 4))
  }
  expect(capture.frames).toBe(21)
  expect(capture.height).toBe(height + 540)
  expect(capture.pixels()).toEqual(Buffer.concat(expected))
  const preview = capture.preview(), source = capture.pixels()
  expect(preview.width).toBeLessThanOrEqual(120); expect(preview.height).toBeLessThanOrEqual(600)
  for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) {
    const row = Math.floor((y + .5) * capture.height / preview.height), column = Math.floor((x + .5) * width / preview.width)
    expect(preview.pixels.subarray((y * preview.width + x) * 4, (y * preview.width + x + 1) * 4))
      .toEqual(source.subarray((row * width + column) * 4, (row * width + column + 1) * 4))
  }
})

it('matches repeated text rows despite a stationary translucent cursor glow', () => {
  const w = 320, h = 200
  const frame = (top: number, glow = .7): Buffer => {
    const pixels = Buffer.alloc(w * h * 4, 255)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const row = Math.floor((y + top) / 20), ink = (y + top) % 20 < 10 && x < 220 && x % 7 < 3
      const number = x < 35 && (row * 7919 >> (x % 13)) % 2
      const i = (y * w + x) * 4, shade = ink ? 150 + row % 5 * 10 + (Math.floor(row / 5) % 3) + (number ? 20 : 0) : 15
      pixels[i] = shade; pixels[i + 1] = shade; pixels[i + 2] = shade
      if (x > 100 && x < 210 && y > 50 && y < 140) { pixels[i] = pixels[i] * (1 - glow); pixels[i + 1] = pixels[i + 1] * (1 - glow) + 42 * glow; pixels[i + 2] = pixels[i + 2] * (1 - glow) + 214 * glow }
    }
    return pixels
  }
  expect(findScrollOffset(frame(0), frame(10), w, h)).toBe(10)
  expect([0, null]).toContain(findScrollOffset(frame(0), frame(0, .3), w, h))
})

it('never appends periodic text rows when only a cursor highlight fades', () => {
  const w = 320, h = 200
  const frame = (glow: number): Buffer => {
    const pixels = Buffer.alloc(w * h * 4, 255)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, ink = y % 20 < 10 && x < 220 && x % 7 < 3
      const shade = ink ? 150 + Math.floor(y / 20) % 5 * 10 : 15
      pixels[i] = shade; pixels[i + 1] = shade; pixels[i + 2] = shade
      if (x > 100 && x < 210 && y < 60) {
        pixels[i] *= 1 - glow; pixels[i + 1] = pixels[i + 1] * (1 - glow) + 42 * glow
        pixels[i + 2] = pixels[i + 2] * (1 - glow) + 214 * glow
      }
    }
    return pixels
  }
  // The previous pooled RGB score falsely matched a 100px scroll here.
  const capture = new ScrollCapture(w, h)
  capture.add(frame(.8))
  expect(capture.add(frame(.05))).toBe('unmatched')
  expect(capture.height).toBe(h); expect(capture.frames).toBe(1)
})
