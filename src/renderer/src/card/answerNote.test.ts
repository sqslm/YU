import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { answerNote } from './answerNote'
afterEach(async () => { await i18n.changeLanguage('zh') })
describe('save Ask answer as a note', () => {
  it('preserves Markdown, question and original citation numbering without unsafe links or tool state', async () => {
    await i18n.changeLanguage('en')
    const output = answerNote({ question: '# Compare\nproducts', answer: '**Result** [1][3]\n\n```js\nlet x = 1;\n```', tools: ['private-tool'], status: 'Transient status', sources: [
      { title: '<Original>', url: 'https://example.com/one', snippet: 'private snippet' },
      { title: 'Unsafe', url: 'javascript:alert(1)', snippet: '' },
      { title: 'Third', url: 'https://example.com/three', snippet: '' }
    ] })
    expect(output).toContain('## Question\n\n\\# Compare products')
    expect(output).toContain('**Result** [1][3]\n\n```js\nlet x = 1;\n```')
    expect(output).toContain('1. \\<Original\\> — https://example.com/one')
    expect(output).toContain('3. Third — https://example.com/three')
    for (const value of ['javascript:', 'private-tool', 'Transient status', 'private snippet']) expect(output).not.toContain(value)
  })
  it('labels a stopped partial answer in Chinese rather than silently presenting it as complete', async () => {
    await i18n.changeLanguage('zh')
    const output = answerNote({ question: '问题', answer: '部分回答', stopped: true })
    expect(output).toContain('已停止生成，以下为部分回答。')
    expect(output).not.toContain('## 来源')
  })
})
