import { expect, it } from 'vitest'
import { memoryIdleEnough } from './idle'
it('requires computer idle, spare memory and low CPU together', () => {
  expect(memoryIdleEnough(60, 2 * 1024 ** 3, 16 * 1024 ** 3, 0.2)).toBe(true)
  expect(memoryIdleEnough(59, 2 * 1024 ** 3, 16 * 1024 ** 3, 0.2)).toBe(false)
  expect(memoryIdleEnough(60, 512 * 1024 ** 2, 4 * 1024 ** 3, 0.2)).toBe(false)
  expect(memoryIdleEnough(60, 2 * 1024 ** 3, 32 * 1024 ** 3, 0.2)).toBe(false)
  expect(memoryIdleEnough(60, 2 * 1024 ** 3, 16 * 1024 ** 3, 0.5)).toBe(false)
})
