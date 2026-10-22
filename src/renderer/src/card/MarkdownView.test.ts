import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MarkdownView } from './MarkdownView'

describe('answer source rendering', () => {
  it('links only known safe citation numbers to their actual source', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, { text: '结论[1][2][9]', sources: [
      { title: 'Original', url: 'https://example.com/article', snippet: '' },
      { title: 'Unsafe', url: 'javascript:alert(1)', snippet: '' }
    ] }))
    expect(html).toContain('href="https://example.com/article"')
    expect(html).toContain('data-card-citation="1"')
    expect(html).not.toContain('data-card-citation="2"')
    expect(html).not.toContain('data-card-citation="9"')
    expect(html).not.toContain('javascript:')
  })
  it('renders readable comparison cells while treating HTML as text', () => {
    const html = renderToStaticMarkup(createElement(MarkdownView, { text: '| A | B |\n| --- | --- |\n| <script>alert(1)</script> | **Good** |' }))
    expect(html).toContain('<table')
    expect(html).toContain('<strong')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
