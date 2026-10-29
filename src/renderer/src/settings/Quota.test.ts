import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { expect, it } from 'vitest'
import { QuotaRing } from './Quota'
import type { QuotaResult } from '@shared/quota'

const result: QuotaResult = { status: 'ok', scope: 'key', message: '', checkedAt: 1, metrics: [{ label: '', remaining: 25, total: 100, unit: 'USD' }] }
const render = (mode: 'dark' | 'light', row?: QuotaResult): string => renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme({ palette: { mode } }), children: createElement(QuotaRing, { result: row }) }))
it('renders the requested white remainder on a darker used track in dark mode', () => {
  const html = render('dark', result)
  expect(html).toContain('stroke="#ffffff"'); expect(html).toContain('stroke="#101010"')
  expect(html).toContain('stroke-dasharray="25 100"')
})
it('keeps unknown balance proportions distinct from an actually exhausted allowance', () => {
  expect(render('dark')).not.toContain('data-quota-remaining')
  expect(render('dark', { ...result, metrics: [{ label: '', remaining: 25, unit: 'USD' }] })).not.toContain('data-quota-remaining')
  expect(render('dark', { ...result, metrics: [{ label: '', remaining: 0, total: 100, unit: 'USD' }] })).toContain('stroke-dasharray="0 100"')
})
it('uses contrasting dark remainder and light used colors in light mode', () => {
  const html = render('light', result)
  expect(html).toContain('stroke="#242832"'); expect(html).toContain('stroke="#d9dce1"')
})
