import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HistoryPage } from './HistoryPage'

it('keeps primary history controls visible and low-frequency actions collapsed initially', () => {
  const html = renderToStaticMarkup(createElement(HistoryPage))
  expect(html).toContain('data-history-search-row')
  expect(html).toContain('data-history-refresh=')
  expect(html).toContain('更多操作')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('data-history-date-toolbar')
  expect(html).not.toContain('data-history-refresh-picker')
  expect(html).not.toContain('data-history-clean-abnormal')
})
