import { describe, expect, it } from 'vitest'
import { amountLabel } from './quotaAmountLabel'

describe('amountLabel', () => {
  it('shows a money balance with its mark, keeping cents', () => {
    expect(amountLabel({ label: '可用余额', remaining: 7.62, unit: 'CNY' }, 'zh-CN')).toMatchObject({ symbol: '¥', figure: '7.62', spoken: '¥7.62' })
    expect(amountLabel({ label: 'key usage', used: 3.5, unit: 'USD' }, 'en-US').spoken).toBe('$3.5')
  })

  it('compacts four-digit balances so they still fit a 28 px ring', () => {
    const zh = amountLabel({ label: '', remaining: 12345, unit: 'CNY' }, 'zh-CN')
    expect(zh.figure).toBe('1.2万')
    expect(amountLabel({ label: '', remaining: 12345, unit: 'CNY' }, 'en-US').figure).toBe('12.3K')
  })

  it('keeps whole numbers short', () => {
    expect(amountLabel({ label: '', remaining: 800, unit: 'CNY' }, 'zh-CN').figure).toBe('800')
    expect(amountLabel({ label: '', remaining: 0, unit: 'USD' }, 'zh-CN').figure).toBe('0')
  })

  it('labels character allowances without a currency mark', () => {
    const label = amountLabel({ label: '', remaining: 9500, used: 500, total: 10000, unit: 'characters' }, 'zh-CN')
    expect(label).toMatchObject({ symbol: '字', spoken: `${label.figure} 字` })
  })
})
