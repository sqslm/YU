import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

/** The exact shape the gateway returns for a news question, used as the fixture. */
const ANSWER = `用户提到的应该是**平陆运河**，不过它并非“前两天”才开通的——它已在 **9 月 16 日**全线正式通航[1][2]。

## 平陆运河简介

- **位置与走向**：位于广西，全长 **134.2 公里**，北端接西江航运干线[3]。
- **地位**：新中国成立以来**第一条**由国家层面统筹建设的通航建筑物。
  它的通航等级是国内最高的一档。

## 核心效益

1. 西南地区货物从这里出海。
2. 比传统路径缩短内河航程 560 公里。

\`\`\`text
重庆 → 北部湾：约 1200 公里
\`\`\`

> 以上数字来自交通运输部的通航公告。

---

更多细节可以问。`

describe('parseInline', () => {
  it('marks bold, code, links and citations', () => {
    const runs = parseInline('见 **重点** 与 `npm test` 和 [文档](https://example.com) 以及[3]。')
    expect(runs.map((run) => run.kind)).toEqual([
      'text',
      'strong',
      'text',
      'code',
      'text',
      'link',
      'text',
      'cite',
      'text'
    ])
    expect(runs[1]).toEqual({ kind: 'strong', text: '重点' })
    expect(runs[5]).toMatchObject({ kind: 'link', href: 'https://example.com' })
    expect(runs[7]).toMatchObject({ kind: 'cite', label: '3' })
  })

  it('leaves snake_case and arithmetic alone', () => {
    const runs = parseInline('audio_path 与 2 * 3')
    expect(runs).toEqual([{ kind: 'text', text: 'audio_path 与 2 * 3' }])
  })

  it('keeps an unterminated delimiter literal so a streaming answer stays readable', () => {
    expect(parseInline('**平陆')).toEqual([{ kind: 'text', text: '**平陆' }])
    expect(parseInline('`unclosed')).toEqual([{ kind: 'text', text: '`unclosed' }])
  })

  it('treats a lone underscore pair with hugging content as emphasis', () => {
    expect(parseInline('这是 _强调_ 的词')).toEqual([
      { kind: 'text', text: '这是 ' },
      { kind: 'em', text: '强调' },
      { kind: 'text', text: ' 的词' }
    ])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, lists, code, quotes and rules', () => {
    const blocks = parseMarkdown(ANSWER)
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'heading',
      'list',
      'heading',
      'list',
      'code',
      'quote',
      'rule',
      'paragraph'
    ])

    const [intro, firstHeading, bullets, secondHeading, numbered, code, quote] = blocks
    expect(intro).toMatchObject({ kind: 'paragraph' })
    expect(firstHeading).toMatchObject({ kind: 'heading', level: 2 })
    expect(bullets).toMatchObject({ kind: 'list', ordered: false })
    expect(secondHeading).toMatchObject({ kind: 'heading', level: 2 })
    expect(numbered).toMatchObject({ kind: 'list', ordered: true })
    expect(code).toMatchObject({ kind: 'code', lang: 'text' })
    expect(quote).toMatchObject({ kind: 'quote' })
  })

  it('joins a wrapped bullet instead of starting a new paragraph', () => {
    const blocks = parseMarkdown('- 第一条\n  接着写的内容\n- 第二条')
    expect(blocks).toHaveLength(1)
    const list = blocks[0]
    expect(list).toMatchObject({ kind: 'list', ordered: false })
    if (list?.kind !== 'list') throw new Error('expected a list')
    expect(list.items).toHaveLength(2)
    expect(list.items[0]).toEqual([
      { kind: 'text', text: '第一条 接着写的内容' }
    ])
  })

  it('keeps a numbered list separate from a bullet list', () => {
    const blocks = parseMarkdown('- a\n- b\n\n1. c\n2. d')
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'list'])
    expect(blocks[0]).toMatchObject({ ordered: false })
    expect(blocks[1]).toMatchObject({ ordered: true })
  })

  it('keeps an open fence as a code block while the answer streams', () => {
    const blocks = parseMarkdown('说明如下\n\n```js\nconst a = 1\n')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'code'])
    expect(blocks[1]).toMatchObject({ kind: 'code', lang: 'js', text: 'const a = 1' })
  })

  it('splits paragraphs on blank lines and keeps soft wraps', () => {
    const blocks = parseMarkdown('第一段第一行\n第一段第二行\n\n第二段')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'text', text: '第一段第一行\n第一段第二行' }]
    })
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n  ')).toEqual([])
  })

  it('reads every prefix of a real answer without throwing', () => {
    for (let end = 0; end <= ANSWER.length; end += 17) {
      expect(() => parseMarkdown(ANSWER.slice(0, end))).not.toThrow()
    }
  })
})
