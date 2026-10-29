import { expect, it } from 'vitest'
import { dampenNodeDrag } from './memoryGraphDrag'
it('reduces absolute displacement by 15% and keeps the pinned simulation position consistent', () => {
  const origin = { x: 20, y: 10 }, node = { x: 120, y: -90, fx: 0, fy: 0 }
  dampenNodeDrag(node, origin)
  expect(node).toEqual({ x: 105, y: -75, fx: 105, fy: -75 })
  node.x = 220; node.y = 10
  dampenNodeDrag(node, origin)
  expect(node.x).toBe(190)
  expect(node.y).toBe(10)
})
