import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The heat-map axis asks the dictionary for "10月"; a Chinese build must answer
 * "10月".
 *
 * This locks down a real regression: the twelve month keys were once added to
 * both locales with English values, so the whole year axis of the hub read
 * "Nov Dec Jan …" under a Chinese interface, and nothing failed because the
 * keys existed and the value was a string.
 */
const locales = join(process.cwd(), 'src/renderer/src/locales')
const read = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

describe('month labels', () => {
  it('keeps 月 in the Chinese locale, whether translated or left to the fallback', () => {
    const zh = read('zh-CN.json')
    for (const key of MONTHS) {
      // Absent is fine — i18n falls back to the key itself, which is already right.
      if (!(key in zh)) continue
      expect(zh[key], `${key} must not be translated in zh-CN`).toBe(key)
    }
  })

  it('names the twelve months in English', () => {
    const en = read('en-US.json')
    MONTHS.forEach((key, index) => expect(en[key]).toBe(SHORT[index]))
  })
})
