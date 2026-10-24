import { expect, it } from 'vitest'
import { resizeMark, type Mark } from './layers'

it.each(['rect', 'ellipse', 'arrow', 'mosaic', 'pen'] as const)('resizes %s without mutating the original layer or stroke settings', tool => {
  const mark: Mark = { tool, color: '#fff', width: 5, points: [{ x: 100, y: 100 }, { x: 150, y: 120 }, { x: 200, y: 150 }] }
  const resized = resizeMark(mark, { x: 100, y: 100, width: 100, height: 50 }, { x: 80, y: 70, width: 200, height: 150 })
  expect(resized.points).toEqual([{ x: 80, y: 70 }, { x: 180, y: 130 }, { x: 280, y: 220 }])
  expect(resized.width).toBe(5); expect(mark.points[0]).toEqual({ x: 100, y: 100 })
})
it('resizes text independently in each axis without changing its words', () => {
  const mark: Mark = { tool: 'text', color: '#fff', points: [{ x: 100, y: 100 }], text: '原文 Text', fontSize: 20, scaleX: 1.5 }
  expect(resizeMark(mark, { x: 100, y: 100, width: 120, height: 30 }, { x: 90, y: 80, width: 240, height: 90 }))
    .toMatchObject({ points: [{ x: 90, y: 80 }], text: '原文 Text', fontSize: 20, scaleX: 3, scaleY: 3 })
})
