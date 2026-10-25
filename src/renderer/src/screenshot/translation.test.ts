import { expect, it } from 'vitest'
import { layoutTranslation, wrapTranslation } from './translation'

it('wraps mixed text, long identifiers and emoji without losing content or overflowing', () => {
  const measure = (text: string): number => Array.from(text).length
  const lines = wrapTranslation('翻译 Test architecture.md 😀\n下一段', 10, measure)
  expect(lines.every(line => measure(line) <= 10)).toBe(true)
  expect(lines.join('').replace(/\s/g, '')).toBe('翻译Testarchitecture.md😀下一段')
  expect(wrapTranslation('Hello world', 7, measure)).toEqual(['Hello', 'world'])
})

it('uses a shared text column and spare height without colliding with the next paragraph', () => {
  const regions = [{ x: 10, y: 10, width: 50, height: 20, fontSize: 20, text: '这是完整翻译标题' },
    { x: 10, y: 70, width: 300, height: 40, fontSize: 20, text: '正文' },
    { x: 330, y: 10, width: 100, height: 25, fontSize: 20, text: '侧边栏' }]
  const layout = layoutTranslation(regions, 450, 180, (text, size) => Array.from(text).length * size)
  expect(layout[0].size).toBe(20)
  expect(layout[0].lines.join('')).toBe(regions[0].text)
  expect(layout[0].overflow).toBe(false)
  expect(layout[0].x + layout[0].width).toBeLessThan(regions[2].x)
  expect(layout[0].y + layout[0].height).toBeLessThan(regions[1].y)
})

it('marks an impossible fit explicitly instead of rendering unreadable one-pixel text', () => {
  const [region] = layoutTranslation([{ x: 0, y: 0, width: 30, height: 20, fontSize: 20, text: '很长的翻译'.repeat(30) }], 30, 20,
    (text, size) => Array.from(text).length * size)
  expect(region.size).toBeGreaterThanOrEqual(13)
  expect(region.overflow).toBe(true)
  expect(region.lines.at(-1)).toContain('…')
})
