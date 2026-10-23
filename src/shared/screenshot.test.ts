import { expect, it } from 'vitest'
import { screenshotCrop } from './screenshot'

it.each([1, 1.25, 1.5, 2])('exports the real captured pixels at %sx display scale', scale => {
  expect(screenshotCrop({ x: 20, y: 40, width: 200, height: 100 }, { width: 1000, height: 800 }, { width: 1000 * scale, height: 800 * scale }))
    .toEqual({ x: 20 * scale, y: 40 * scale, width: 200 * scale, height: 100 * scale })
})
it('clamps an edge selection to the actual image rather than exporting toolbar or empty pixels', () => {
  expect(screenshotCrop({ x: 999.9, y: 799.9, width: 25, height: 25 }, { width: 1000, height: 800 }, { width: 1500, height: 1200 }))
    .toEqual({ x: 1499, y: 1199, width: 1, height: 1 })
})
it('uses actual source dimensions when desktop capture returns a smaller thumbnail', () => {
  expect(screenshotCrop({ x: 0, y: 0, width: 2000, height: 1000 }, { width: 4000, height: 2000 }, { width: 1600, height: 800 }))
    .toEqual({ x: 0, y: 0, width: 800, height: 400 })
})
