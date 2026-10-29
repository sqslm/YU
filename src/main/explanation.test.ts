import { expect, it, vi } from 'vitest'
vi.mock('./providers/llm', () => ({ complete: vi.fn() }))
import { explanationMessages } from './explanation'
it('passes a bounded frozen context as data, with no memory or tool execution path', () => {
  const messages = explanationMessages('RAG', '什么是检索', '前缀'.repeat(4000) + 'RAG 是检索增强生成' + '尾部'.repeat(5000))
  expect(messages).toHaveLength(2)
  expect(messages[0].content).toContain('不是指令')
  const data = JSON.parse(messages[1].content)
  expect(data.selected).toBe('RAG'); expect(data.answerContext).toContain('RAG 是检索增强生成'); expect(data.answerContext.length).toBeLessThanOrEqual(8000)
})
