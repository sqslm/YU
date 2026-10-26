import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NoteMarkdown } from './NoteMarkdown'
import { attachmentMarkdown } from '@shared/noteAttachments'

const render = (text: string): string => renderToStaticMarkup(createElement(NoteMarkdown, { text, noteId: 'note-1', onAttachment: vi.fn() }))
describe('note Markdown', () => {
  it('renders CommonMark and GFM including nesting, tables, tasks, strikethrough and fenced code', () => {
    const html = render('# Heading\n\n**bold _nested_**\n\n> quote\n\n- parent\n  - child\n\n- [x] complete\n\n~~gone~~\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst n = 1\n```\n\nhttps://example.com')
    for (const tag of ['<h1', '<strong', '<em', '<blockquote', '<ul', '<table', '<del', '<pre', 'type="checkbox"', 'checked=""', 'href="https://example.com"']) expect(html).toContain(tag)
    expect(html.match(/<ul/g)!.length).toBeGreaterThanOrEqual(2)
  })
  it('renders an owned image and a portable attachment without retaining original paths', () => {
    const html = render(attachmentMarkdown({ name: '图 [1].png', path: 'attachments/6e31/image.png', image: true }) + '\n\n' + attachmentMarkdown({ name: 'file.pdf', path: 'attachments/6e31/file.pdf', image: false }))
    expect(html).toContain('src="typeless-audio://attachment/note-1/attachments/6e31/image.png"')
    expect(html).toContain('href="typeless-audio://attachment/note-1/attachments/6e31/file.pdf"')
    expect(html).toContain('图 [1].png')
  })
  it('does not execute raw HTML or unsafe URL schemes', () => {
    const html = render('<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n\n![local](file:///secret.png)\n\n[x](data:text/html,unsafe)')
    expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('src="file:'); expect(html).not.toContain('href="data:')
  })
  it('encodes Unicode, spaces and literal percent names exactly once in image URLs', () => {
    const path = 'attachments/6e31/uuid-图 100%20.png'
    const html = render(attachmentMarkdown({ name: '图 100%20.png', path, image: true }))
    expect(html).toContain('src="typeless-audio://attachment/note-1/attachments/6e31/uuid-%E5%9B%BE%20100%2520.png"')
    expect(html).not.toContain('%25E5')
  })
})
