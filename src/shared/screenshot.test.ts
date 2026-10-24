import { expect, it } from 'vitest'
import { screenshotCrop, captureHit, captureHandle, CAPTURE_HANDLES, resizeCapture, captureWindowRegions, captureWindowAt } from './screenshot'

it('snaps to the top visible window and clips a window spanning a scaled negative-origin monitor', () => {
  const windows = captureWindowRegions([{ x: -1800, y: 60, width: 600, height: 300 }, { x: -2000, y: 0, width: 2400, height: 1080 }, { x: 100, y: 0, width: 100, height: 100 }], { x: -1920, y: 0, width: 1920, height: 1080 }, { width: 1280, height: 720 })
  expect(windows).toEqual([{ x: 80, y: 40, width: 400, height: 200 }, { x: 0, y: 0, width: 1280, height: 720 }])
  expect(captureWindowAt({ x: 100, y: 100 }, windows)).toEqual(windows[0])
  expect(captureWindowAt({ x: 700, y: 100 }, windows)).toEqual(windows[1])
  expect(captureWindowAt({ x: 1280, y: 0 }, windows)).toBeNull()
})

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
it('offers all eight resize handles; only the border can move a selection', () => {
  const rect = { x: 100, y: 100, width: 400, height: 200 }
  for (const handle of CAPTURE_HANDLES) expect(captureHit(captureHandle(rect, handle), rect)).toBe(handle)
  expect(captureHit({ x: 180, y: 100 }, rect)).toBe('move')
  expect(captureHit({ x: 180, y: 160 }, rect)).toBeNull()
  expect(captureHit({ x: 30, y: 100 }, rect)).toBeNull()
})
it('resizes any edge independently without moving the opposite edge or allowing inverted rectangles', () => {
  const rect = { x: 100, y: 100, width: 400, height: 200 }, view = { width: 1000, height: 800 }
  expect(resizeCapture(rect, 'w', { x: 70, y: 130 }, view)).toEqual({ x: 70, y: 100, width: 430, height: 200 })
  expect(resizeCapture(rect, 'n', { x: 320, y: 80 }, view)).toEqual({ x: 100, y: 80, width: 400, height: 220 })
  expect(resizeCapture(rect, 'e', { x: 700, y: 150 }, view)).toEqual({ x: 100, y: 100, width: 600, height: 200 })
  expect(resizeCapture(rect, 's', { x: 120, y: 900 }, view)).toEqual({ x: 100, y: 100, width: 400, height: 700 })
  expect(resizeCapture(rect, 'w', { x: 600, y: 150 }, view).width).toBe(4)
})
