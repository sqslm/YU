import { describe, expect, it } from 'vitest'
import { recentChipText } from './recentChip'

describe('recentChipText', () => {
  it('names the card and the provider that produced a take', () => {
    expect(
      recentChipText({
        promptKind: 'polish',
        promptName: '默认提示词',
        providerName: 'cn.deepseek-v4.1-flash'
      })
    ).toBe('润色 · 默认提示词 · cn.deepseek-v4.1-flash')
  })

  it('keeps whatever part was recorded', () => {
    expect(recentChipText({ promptName: '邮件精修' })).toBe('邮件精修')
    expect(recentChipText({ providerName: '自建 vLLM' })).toBe('自建 vLLM')
    expect(recentChipText({ promptKind: 'email', promptName: '邮件精修' })).toBe(
      '邮件 · 邮件精修'
    )
  })

  it('renders nothing for entries that predate both fields', () => {
    // A blank caption is the point: an old row must not grow a "未记录" line
    // that the page has no vertical room for.
    expect(recentChipText({})).toBeNull()
    expect(recentChipText({ promptName: '   ', providerName: '' })).toBeNull()
    expect(recentChipText({ promptKind: 'polish' })).toBeNull()
  })

  it('does not repeat a provider that shares the card name', () => {
    expect(
      recentChipText({ promptKind: 'translate', promptName: 'DeepSeek', providerName: 'DeepSeek' })
    ).toBe('翻译 · DeepSeek')
  })

  it('ignores a prompt kind it does not know', () => {
    // `history.json` is editable by hand, so an unknown kind must not print
    // `undefined` into the row.
    const raw = { promptKind: 'calendar' as never, promptName: '默认提示词' }
    expect(recentChipText(raw)).toBe('默认提示词')
  })
})
