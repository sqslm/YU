import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_MESSAGES } from './mainMessages'
import { mainLanguage, mt, setMainLanguage } from './mainI18n'

/**
 * The main-process half of the i18n layer.
 *
 * `mt()` is what the tray menu, alert rows, provider step names and error
 * messages go through. Two properties matter and both are easy to break:
 * a missing English entry must degrade to the Chinese source text (never to a
 * bare key name), and `{{placeholders}}` must survive translation.
 */

afterEach(() => {
  setMainLanguage('zh')
})

describe('main language', () => {
  it('defaults to Chinese so unwired callers keep the source string', () => {
    expect(mainLanguage()).toBe('zh')
    expect(mt('重试')).toBe('重试')
  })

  it('switches on the first call and ignores anything but en', () => {
    setMainLanguage('en')
    expect(mainLanguage()).toBe('en')
    setMainLanguage('de')
    expect(mainLanguage()).toBe('zh')
    setMainLanguage(undefined)
    expect(mainLanguage()).toBe('zh')
  })

  it('returns the English entry once the language is en', () => {
    setMainLanguage('en')
    expect(mt('重试')).toBe('Retry')
    expect(mt('复制')).toBe('Copy')
  })

  it('falls back to the Chinese source, not the key, for an untranslated template', () => {
    setMainLanguage('en')
    expect(mt('这句话故意没有英文')).toBe('这句话故意没有英文')
  })

  it('interpolates placeholders in both languages', () => {
    expect(mt('已重试 {{n}} 次', { n: 3 })).toBe('已重试 3 次')
    setMainLanguage('en')
    const key = '已重试 {{n}} 次'
    expect(mt(key, { n: 3 })).toBe((MAIN_MESSAGES[key] ?? key).replace('{{n}}', '3'))
  })

  it('leaves an unknown placeholder alone instead of printing undefined', () => {
    expect(mt('第 {{page}} 页 / {{pages}}', { page: 2 })).toBe('第 2 页 / {{pages}}')
  })
})

describe('mainMessages dictionary', () => {
  it('maps every entry to a non-empty English string', () => {
    const broken = Object.entries(MAIN_MESSAGES).filter(
      ([key, value]) => !value.trim() || value === key
    )
    expect(broken).toEqual([])
  })

  it('keeps the same placeholders on both sides of every entry', () => {
    const mismatched = Object.entries(MAIN_MESSAGES).filter(([key, value]) => {
      const slots = (text: string): string[] => (text.match(/\{\{\w+\}\}/g) ?? []).sort()
      return slots(key).join() !== slots(value).join()
    })
    expect(mismatched).toEqual([])
  })
})
