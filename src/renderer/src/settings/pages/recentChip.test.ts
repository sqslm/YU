import { describe, expect, it } from 'vitest'
import { recentChipText } from './recentChip'

describe('recentChipText', () => {
  it('shows only the card recorded with the take, omitting kind and model', () => {
    const entry = { promptKind: 'polish' as const, promptName: '默认提示词', providerName: 'cn.deepseek-v4.1-flash' }
    expect(recentChipText(entry)).toBe('默认提示词')
  })

  it('keeps custom card names and trims surrounding whitespace', () => {
    expect(recentChipText({ promptName: '  邮件精修  ' })).toBe('邮件精修')
    expect(recentChipText({ promptName: 'DeepSeek' })).toBe('DeepSeek')
  })

  it('renders no card tag for legacy or card-free takes', () => {
    expect(recentChipText({})).toBeNull()
    expect(recentChipText({ promptName: '   ' })).toBeNull()
    const providerOnly = { providerName: '自建 vLLM', promptName: undefined }
    expect(recentChipText(providerOnly)).toBeNull()
  })

  it('does not mistake a model or prompt kind for a missing card', () => {
    const entry = { promptKind: 'email' as const, providerName: '邮件精修模型', promptName: '' }
    expect(recentChipText(entry)).toBeNull()
  })
})
