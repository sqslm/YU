import { describe, expect, it } from 'vitest'
import { matchHeadingIndex, noteHeadings } from './noteOutline'

describe('note outline', () => {
  it('lists headings in document order with their level and offset', () => {
    const markdown = '# 一\n\n正文\n\n## 二\n\n### 三 ###\n'
    expect(noteHeadings(markdown)).toEqual([
      { level: 1, text: '一', offset: 0 },
      { level: 2, text: '二', offset: 9 },
      { level: 3, text: '三', offset: 15 }
    ])
  })

  it('ignores # lines inside fenced code blocks', () => {
    const markdown = '# 真\n\n```bash\n# 注释\n## 注释二\n```\n\n## 也真\n'
    expect(noteHeadings(markdown).map(heading => heading.text)).toEqual(['真', '也真'])
  })

  it('closes the fence again so the document keeps its headings', () => {
    const markdown = '```\ncode\n```\n\n## 后面\n'
    expect(noteHeadings(markdown).map(heading => heading.text)).toEqual(['后面'])
  })

  it('strips inline markers so the row reads like prose', () => {
    expect(noteHeadings('## **粗** 与 `代码` 与 [链接](https://example.com)\n')[0]?.text).toBe('粗 与 代码 与 链接')
  })

  it('drops empty headings and non-headings', () => {
    expect(noteHeadings('#\n\n#hashtag\n\n####### 七级\n')).toEqual([])
  })
})

describe('outline row to editor heading', () => {
  const rows = (texts: string[]) => texts.map((text, offset) => ({ level: 2, text, offset }))

  it('maps one-to-one when both lists agree', () => {
    const dom = ['一', '二', '三']
    expect(dom.map((_, index) => matchHeadingIndex(dom, rows(dom), index))).toEqual([0, 1, 2])
  })

  it('steps over a heading the outline never listed', () => {
    // A heading inside a quote shows up in the editor but not in this parser.
    const outline = rows(['一', '二'])
    const dom = ['引用里的标题', '一', '二']
    expect(matchHeadingIndex(dom, outline, 0)).toBe(1)
    expect(matchHeadingIndex(dom, outline, 1)).toBe(2)
  })

  it('picks the right occurrence of a repeated section name', () => {
    const outline = rows(['目标', '目标', '结尾'])
    const dom = ['目标', '目标', '结尾']
    expect([0, 1, 2].map(index => matchHeadingIndex(dom, outline, index))).toEqual([0, 1, 2])
    expect(matchHeadingIndex(['封面', '目标', '目标', '结尾'], outline, 1)).toBe(2)
  })

  it('falls back to the raw index when the text is gone', () => {
    expect(matchHeadingIndex(['甲', '乙'], rows(['被改掉的标题', '乙']), 0)).toBe(0)
  })
})
