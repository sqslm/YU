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
it('waits for a stable frame, stitches only new rows and preserves all pixels', () => {
  const capture = new ScrollCapture(width, height)
  expect(capture.add(page(0))).toBe('added')
  expect(capture.add(page(37))).toBe('waiting')
  expect(capture.add(page(37))).toBe('added')
  expect(capture.add(page(37))).toBe('unchanged')
  expect(capture.height).toBe(137)
  expect(capture.pixels()).toEqual(Buffer.concat([page(0), page(37).subarray((height - 37) * width * 4)]))
})
it('refuses upward scrolling, unrelated content and memory growth beyond the cap', () => {
  const capture = new ScrollCapture(width, height, width * 120)
  capture.add(page(37)); capture.add(page(0))
  expect(capture.add(page(0))).toBe('unmatched')
  capture.add(page(74))
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
  capture.add(frame(0)); capture.add(frame(31))
  expect(capture.add(frame(31))).toBe('added')
  capture.add(frame(62)); expect(capture.add(frame(62))).toBe('added')
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
  capture.add(frame(0)); capture.add(frame(31)); expect(capture.add(frame(31))).toBe('added')
  capture.add(frame(62)); expect(capture.add(frame(62))).toBe('added')
  expect(capture.pixels()).toEqual(Buffer.concat([frame(0).subarray(0, width * 90 * 4),
    frame(31).subarray(width * 59 * 4, width * 90 * 4), frame(62).subarray(width * 59 * 4)]))
})
