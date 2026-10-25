import { expect, it } from 'vitest'
import { groupScreenshotLines, parseScreenshotTranslation } from './screenshotTranslation'

it('merges split runs on one baseline without clipping taller glyphs', () => {
  expect(groupScreenshotLines([{ text: 'First', x: 10, y: 12, width: 50, height: 18 },
    { text: 'second', x: 75, y: 10, width: 70, height: 20 }]))
    .toEqual([{ text: 'First second', x: 10, y: 10, width: 135, height: 20, fontSize: 18 }])
})

it('joins wrapped paragraphs without merging headings, numbered items or columns', () => {
  const lines = [
    { x: 10, y: 10, width: 200, height: 20, text: 'Heading' },
    { x: 10, y: 60, width: 300, height: 20, text: '1. First paragraph' },
    { x: 24, y: 86, width: 240, height: 20, text: 'continued here.' },
    { x: 10, y: 112, width: 300, height: 20, text: '2. Another paragraph' },
    { x: 450, y: 138, width: 100, height: 20, text: 'Other column' }
  ]
  expect(groupScreenshotLines(lines)).toEqual([lines[0], { x: 10, y: 60, width: 300, height: 46, fontSize: 20,
    text: '1. First paragraph\ncontinued here.' }, lines[3], lines[4]])
  expect(lines[1].text).toBe('1. First paragraph')
})
it('maps reordered translation IDs to trusted OCR bounds and ignores supplied coordinates', () => {
  const regions = [{ x: 10, y: 20, width: 300, height: 30, text: 'First' }, { x: 10, y: 80, width: 300, height: 30, text: 'Second' }]
  expect(parseScreenshotTranslation('```json\n[{"id":1,"text":"第二","x":999},{"id":0,"text":"第一"}]\n```', regions))
    .toEqual([{ ...regions[0], text: '第一' }, { ...regions[1], text: '第二' }])
  for (const value of ['bad JSON', '[]', '[{"id":0,"text":"one"},{"id":0,"text":"duplicate"}]', '[{"id":0,"text":"one"},{"id":1,"text":""}]']) {
    expect(() => parseScreenshotTranslation(value, regions)).toThrow('翻译结果不完整')
  }
})
