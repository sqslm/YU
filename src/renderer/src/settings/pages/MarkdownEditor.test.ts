import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { expect, it } from 'vitest'
import i18n from '../../i18n'
import { MarkdownEditor } from './MarkdownEditor'

const render = (value: string, extra: Partial<Parameters<typeof MarkdownEditor>[0]> = {}): string =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement(MarkdownEditor, { value, onChange: () => {}, noteId: 'note-1', onAttachment: () => {}, placeholder: '正文占位', ...extra })))

it('renders every markdown block as its own clickable block, in reading order', () => {
  const html = render('# 标题\n\n第一段\n\n- 甲\n- 乙\n\n```\ncode\n```')
  // 4 blocks: heading, paragraph, one list (kept together), one fence.
  expect(html).toContain('data-notes-blocks="4"')
  expect(html.match(/data-notes-block="/g)).toHaveLength(4)
  expect(html).toContain('<h1>标题</h1>')
  expect(html.indexOf('第一段')).toBeLessThan(html.indexOf('甲'))
  expect(html).toContain('data-notes-markdown')
})

it('shows the placeholder, and no rendered block, for an empty note', () => {
  const html = render('')
  expect(html).toContain('正文占位')
  expect(html).toContain('data-notes-blocks="1"')
  expect(html.match(/data-notes-block="/g)).toBeNull()
})

it('keeps a read-only note out of the tab order', () => {
  const html = render('只读', { disabled: true })
  expect(html).toContain('tabindex="-1"')
  expect(html).not.toContain('tabindex="0"')
})
