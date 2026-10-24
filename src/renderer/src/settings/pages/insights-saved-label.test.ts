import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import { savedLabel } from './insights'

afterEach(async () => { await i18n.changeLanguage('zh') })

describe('saved time keeps its unit in the current UI language (LOCALE-2)', () => {
  it('returns dictionary keys rather than words already translated', () => {
    // A memoised pair must not carry a language: the card only recomputes when the
    // duration changes, so a translated unit would freeze whichever language was
    // active at the first render.
    expect(savedLabel(0)).toEqual({ value: '—', unit: '分钟' })
    expect(savedLabel(30_000)).toEqual({ value: '30', unit: '秒' })
    expect(savedLabel(18 * 60_000)).toEqual({ value: '18', unit: '分钟' })
    expect(savedLabel(10 * 3_600_000)).toEqual({ value: '10.0', unit: '小时' })
  })
  it('translates the unit at render time, so switching language changes it at once', async () => {
    const card = savedLabel(18 * 60_000)
    expect(i18n.t(card.unit)).toBe('分钟')
    await i18n.changeLanguage('en')
    expect(i18n.t(savedLabel(18 * 60_000).unit)).toBe('min')
    expect(i18n.t(savedLabel(30_000).unit)).toBe('s')
    expect(i18n.t(savedLabel(10 * 3_600_000).unit)).toBe('h')
    expect(i18n.t('{{unit}} · 对比 {{wpm}} 字/分', { unit: i18n.t(savedLabel(18 * 60_000).unit), wpm: 40 }))
      .toBe('min · typing at 40 chars/min')
  })
})
