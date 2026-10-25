import { expect, it } from 'vitest'
import { wrapTranslation } from './translation'

it('wraps mixed text, long identifiers and emoji without losing content or overflowing', () => {
  const measure = (text: string): number => Array.from(text).length
  const lines = wrapTranslation('翻译 Test architecture.md 😀\n下一段', 10, measure)
  expect(lines.every(line => measure(line) <= 10)).toBe(true)
  expect(lines.join('').replace(/\s/g, '')).toBe('翻译Testarchitecture.md😀下一段')
  expect(wrapTranslation('Hello world', 7, measure)).toEqual(['Hello', 'world'])
})
