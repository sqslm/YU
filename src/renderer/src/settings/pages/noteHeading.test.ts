import { expect, it } from 'vitest'
import { markdownHeading, noteHeadings } from './noteOutline'

it.each([1, 2, 3, 4, 5, 6])('creates a level %i heading from an ordinary paragraph', level => {
  expect(noteHeadings(markdownHeading('普通段落', level))).toEqual([{ level, text: '普通段落', offset: 0 }])
})
it('changes a heading level and removes heading syntax without changing the text', () => {
  expect(markdownHeading('## 内容', 1)).toBe('# 内容')
  expect(markdownHeading('## 内容', 0)).toBe('内容')
  expect(markdownHeading('普通段落', 0)).toBe('普通段落')
})
