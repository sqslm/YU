import { describe, expect, it } from 'vitest'
import { noteHeadings } from './noteOutline'

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
