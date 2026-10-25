import { describe, expect, it } from 'vitest'
import { applyReplacements, countRuleHits } from './text'

describe('applyReplacements', () => {
  it('returns the input when there is nothing to do', () => {
    expect(applyReplacements('hello', [])).toBe('hello')
    expect(applyReplacements('hello', undefined)).toBe('hello')
    expect(applyReplacements('', [{ from: 'a', to: 'b' }])).toBe('')
  })

  it('replaces every occurrence', () => {
    expect(applyReplacements('a b a', [{ from: 'a', to: 'x' }])).toBe('x b x')
  })

  it('ignores empty source strings', () => {
    expect(applyReplacements('abc', [{ from: '', to: 'X' }])).toBe('abc')
  })

  it('prefers the longest source so GPT4 wins over GPT', () => {
    const pairs = [
      { from: 'GPT', to: 'GPT' },
      { from: 'GPT4', to: 'GPT-4' }
    ]
    expect(applyReplacements('用 GPT4 跑', pairs)).toBe('用 GPT-4 跑')
  })

  it('handles CJK and punctuation literally', () => {
    expect(applyReplacements('打开太普勒斯（测试）', [{ from: '太普勒斯', to: 'Typeless' }])).toBe(
      '打开Typeless（测试）'
    )
  })

  it('treats regex metacharacters as plain text', () => {
    expect(applyReplacements('a.b * c', [{ from: 'a.b', to: 'X' }])).toBe('X * c')
  })

  it('does not rewrite replacement text produced by another rule', () => {
    expect(applyReplacements('GTP', [
      { from: 'GTP', to: 'GPT' },
      { from: 'GPT', to: 'ChatGPT' }
    ])).toBe('GPT')
  })

  it('replaces overlapping rules at their original positions', () => {
    expect(applyReplacements('GPT4 GPT', [
      { from: 'GPT', to: 'ChatGPT' },
      { from: 'GPT4', to: 'GPT-4' }
    ])).toBe('GPT-4 ChatGPT')
  })

  it('never rewrites a glossary hint, even with an empty target', () => {
    // A hint exists to teach the model a spelling. If it reached the literal
    // path, an empty `to` would silently delete the word from the output.
    const pairs = [
      { from: '太普勒斯', to: '', mode: 'hint' as const },
      { from: 'ChatGPT', to: 'ChatGPT', mode: 'hint' as const }
    ]
    expect(applyReplacements('打开太普勒斯问 ChatGPT', pairs)).toBe('打开太普勒斯问 ChatGPT')
  })

  it('still applies replace pairs that sit beside hints', () => {
    const pairs = [
      { from: '太普勒斯', to: '', mode: 'hint' as const },
      { from: 'GTP', to: 'GPT' }
    ]
    expect(applyReplacements('太普勒斯 GPT', pairs)).toBe('太普勒斯 GPT')
    expect(applyReplacements('GTP 模型', pairs)).toBe('GPT 模型')
  })
})
describe('countRuleHits', () => {
  it('counts each literal occurrence of a replace rule in the transcript', () => {
    const pairs = [{ from: 'GTP', to: 'GPT' }]
    expect(countRuleHits('GTP and GTP and gtp', pairs)).toEqual({ GTP: 2 })
  })

  it('still counts a rule the model already applied on its own', () => {
    // Measured bug: the glossary goes to the model, so "今天晚上打CSR吗？" came back
    // as "今天晚上打 CS2 吗？" and counting the result reported zero.
    const pairs = [{ from: 'CSR', to: 'CS2' }]
    expect(countRuleHits('今天晚上打CSR吗？', pairs)).toEqual({ CSR: 1 })
  })

  it('counts a hint rule on the transcript, ignoring case', () => {
    const pairs = [{ from: '太普勒斯', to: '', mode: 'hint' as const }]
    expect(countRuleHits('太普勒斯 太普勒斯', pairs)).toEqual({ 太普勒斯: 2 })
    expect(countRuleHits('Typeless', pairs)).toEqual({})
  })

  it('reports only the rules that appeared', () => {
    const pairs = [
      { from: 'GTP', to: 'GPT' },
      { from: '没出现过', to: 'x' }
    ]
    expect(countRuleHits('GTP 在句子里', pairs)).toEqual({ GTP: 1 })
    expect(countRuleHits('无关文本', pairs)).toEqual({})
  })

  it('survives empty input and empty rules', () => {
    expect(countRuleHits('', [])).toEqual({})
    expect(countRuleHits('a', undefined)).toEqual({})
    expect(countRuleHits('a', [{ from: '', to: 'x' }])).toEqual({})
  })

  it('does not count the replacement text the rule produced', () => {
    const pairs = [{ from: '凯撒', to: 'Caesar' }]
    expect(countRuleHits('凯撒说过', pairs)).toEqual({ 凯撒: 1 })
    expect(countRuleHits('Caesar 说过', pairs)).toEqual({})
  })
})
