import { expect, it } from 'vitest'
import { validateMemoryReply } from './memory-reply'
import { personalMemoryQuery } from './memory-policy'
it('accepts bounded facts and the upstream SDK operation protocol', () => {
  expect(JSON.parse(validateMemoryReply('```json\n{"facts":["用户住杭州"]}\n```'))).toEqual({ facts: ['用户住杭州'] })
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"UPDATE","text":"用户住南京","old_memory":"用户住杭州"}]}')).memory[0].event).toBe('UPDATE')
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"ADD","text":"用户住南京","old_memory":null}]}')).memory[0]).toEqual({ id: '0', event: 'ADD', text: '用户住南京' })
})
it('accepts a single complete JSON reply surrounded by model commentary without changing its facts', () => {
  expect(JSON.parse(validateMemoryReply('以下是提取结果：\n```json\n{"facts":["用户偏好中文"]}\n```\n处理完成。'))).toEqual({ facts: ['用户偏好中文'] })
})
it('handles no-op and deletion actions without requiring unused text, but never guesses an update target', () => {
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"NONE"},{"id":"1","event":"DELETE"}]}'))).toEqual({ memory: [{ id: '1', event: 'DELETE', text: '' }] })
  expect(() => validateMemoryReply('{"memory":[{"event":"DELETE","text":"x"}]}')).toThrow()
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"DELETE","text":""}]}')).memory[0].text).toBe('')
})
it.each(['{"facts":["a"]} {"facts":["b"]}', '[{"facts":[]}', '{"facts":["truncated"', '<think>{"facts":["only reasoning"]}', '{"facts":[" "]}'])('does not guess around ambiguous, truncated or empty replies: %s', input => {
  expect(() => validateMemoryReply(input)).toThrow()
})
it('balances braces inside quoted facts and enforces the requested SDK stage', () => {
  expect(JSON.parse(validateMemoryReply('结果：{"facts":["用户使用 {example} 配置"]}')).facts).toEqual(['用户使用 {example} 配置'])
  expect(() => validateMemoryReply('{"facts":[]}', 'memory')).toThrow()
  expect(() => validateMemoryReply('{"memory":[]}', 'facts')).toThrow()
})
it.each(['null', '[]', '{"facts":[{}]}', '{"memory":[{"id":"__proto__","event":"DELETE","text":"x"}]}', '{"memory":[{"id":"0","event":"RUN","text":"x"}]}', JSON.stringify({ facts: Array(21).fill('x') }), JSON.stringify({ facts: ['x'.repeat(2001)] }), 'x'.repeat(64001)])('rejects malformed/oversized model output before SDK parsing', input => {
  expect(() => validateMemoryReply(input)).toThrow()
})
it('does not read private facts for generic knowledge requests or polite generic prefixes', () => {
  for (const text of ['帮我解释光合作用', '请给我计算七乘八', '太阳系有几颗行星', 'help me calculate 2+2']) expect(personalMemoryQuery(text)).toBe(false)
  for (const text of ['我的名字是什么', '请帮我回忆我的项目', '推荐适合我的旅游路线', 'what is my preferred language']) expect(personalMemoryQuery(text)).toBe(true)
})
