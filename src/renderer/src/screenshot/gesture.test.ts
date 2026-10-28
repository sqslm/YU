import { expect, it } from 'vitest'
import { dragged } from './gesture'
it('ignores clicks and pointer jitter, but accepts a deliberate drag in any direction', () => {
  expect(dragged({ x: 50, y: 50 }, { x: 50, y: 50 })).toBe(false)
  expect(dragged({ x: 50, y: 50 }, { x: 52, y: 51 })).toBe(false)
  expect(dragged({ x: 50, y: 50 }, { x: 50, y: 60 })).toBe(true)
  expect(dragged({ x: 50, y: 50 }, { x: 40, y: 40 })).toBe(true)
})
