import { describe, expect, it } from 'vitest'
import { markdownToHtml } from './richText'

describe('markdownToHtml', () => {
  it('returns null for plain prose so the caller keeps the plain paste', () => {
    // No formatting means an HTML flavour would only give the target a second
    // way to render the same characters.
    expect(markdownToHtml('明天上午十点开会，记得带上报价单。')).toBeNull()
    expect(markdownToHtml('')).toBeNull()
    expect(markdownToHtml('   ')).toBeNull()
  })

  it('turns bold, italic and inline code into tags', () => {
    expect(markdownToHtml('这是**重点**和*补充*，还有`npm run dev`')).toBe(
      '<div><p>这是<b>重点</b>和<i>补充</i>，还有<code>npm run dev</code></p></div>'
    )
  })

  it('consumes a double asterisk before a single one matches', () => {
    // The single-asterisk rule runs later, so `**x**` must not become `<i>*x*</i>`.
    expect(markdownToHtml('**甲**与*乙*')).toContain('<b>甲</b>')
    expect(markdownToHtml('**甲**与*乙*')).not.toContain('*甲*')
  })

  it('groups consecutive bullet lines into one list', () => {
    expect(markdownToHtml('- 第一项\n- 第二项')).toBe(
      '<div><ul><li>第一项</li><li>第二项</li></ul></div>'
    )
  })

  it('keeps an ordered list ordered and restarts after a paragraph', () => {
    expect(markdownToHtml('1. 先做甲\n2. 再做乙\n\n收尾')).toBe(
      '<div><ol><li>先做甲</li><li>再做乙</li></ol><p>收尾</p></div>'
    )
  })

  it('renders a heading as a bold paragraph, not an h1', () => {
    // A pasted <h1> drags its own font size and margins into the target document.
    expect(markdownToHtml('## 结论')).toBe('<div><p><b>结论</b></p></div>')
  })

  it('escapes markup the user actually said instead of emitting it', () => {
    expect(markdownToHtml('用 **<script>alert(1)</script>** 试试')).toBe(
      '<div><p>用 <b>&lt;script&gt;alert(1)&lt;/script&gt;</b> 试试</p></div>'
    )
  })

  it('produces no font, size or colour of its own', () => {
    const html = markdownToHtml('- **加粗**') ?? ''
    expect(html).not.toContain('font')
    expect(html).not.toContain('style=')
  })
})
