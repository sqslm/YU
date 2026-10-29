import { expect, it } from 'vitest'
import { validateMemoryReply } from './memory-reply'
import { personalMemoryQuery } from './memory-policy'
it('accepts bounded facts and the upstream SDK operation protocol', () => {
  expect(JSON.parse(validateMemoryReply('```json\n{"facts":["用户住杭州"]}\n```'))).toEqual({ facts: ['用户住杭州'] })
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"UPDATE","text":"用户住南京","old_memory":"用户住杭州"}]}')).memory[0].event).toBe('UPDATE')
  expect(JSON.parse(validateMemoryReply('{"memory":[{"id":"0","event":"ADD","text":"用户住南京","old_memory":null}]}')).memory[0]).toEqual({ id: '0', event: 'ADD', text: '用户住南京' })
})
it.each(['null', '[]', '{"facts":[{}]}', '{"memory":[{"id":"__proto__","event":"DELETE","text":"x"}]}', '{"memory":[{"id":"0","event":"RUN","text":"x"}]}', JSON.stringify({ facts: Array(21).fill('x') }), JSON.stringify({ facts: ['x'.repeat(2001)] }), 'x'.repeat(64001)])('rejects malformed/oversized model output before SDK parsing', input => {
  expect(() => validateMemoryReply(input)).toThrow()
})
it('does not read private facts for generic knowledge requests or polite generic prefixes', () => {
  for (const text of ['帮我解释光合作用', '请给我计算七乘八', '太阳系有几颗行星', 'help me calculate 2+2']) expect(personalMemoryQuery(text)).toBe(false)
  for (const text of ['我的名字是什么', '请帮我回忆我的项目', '推荐适合我的旅游路线', 'what is my preferred language']) expect(personalMemoryQuery(text)).toBe(true)
})
