import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HistoryPage, processingLabel, processingNote, processingSeconds } from './HistoryPage'

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

/**
 * 用时 (录音结束 → 完成) as the row prints it.
 *
 * One decimal under a minute: a polished take lives in the 0.8–5 s range, so
 * whole seconds would flatten every difference the user can actually feel.
 */
it('prints sub-minute waits with one decimal', () => {
  expect(processingSeconds(2400)).toBe('2.4 秒')
  expect(processingLabel(2400)).toBe('用时 2.4 秒')
  expect(processingLabel(0)).toBe('用时 0.0 秒')
})

it('switches to minutes and seconds once the wait passes a minute', () => {
  expect(processingLabel(72_000)).toBe('用时 1 分 12 秒')
  expect(processingLabel(60_000)).toBe('用时 1 分 0 秒')
})

it('says nothing for rows written before the clock existed', () => {
  expect(processingLabel(undefined)).toBeNull()
  expect(processingNote(undefined)).toBeNull()
  // A negative span can only come from a broken clock; it is not a measurement.
  expect(processingLabel(-5)).toBeNull()
  expect(processingLabel(Number.NaN)).toBeNull()
})

it('spells out both ends of the clock in the hover text', () => {
  expect(processingNote(2400)).toBe('任务用时 2.4 秒（录音结束 → 完成）')
})
