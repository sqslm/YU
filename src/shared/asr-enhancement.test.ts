import { expect, it } from 'vitest'
import { asrEnhancementCapability, asrTermContext } from './asr-enhancement'
it('requires the verified provider protocol, not a familiar model name on an unknown server', () => {
  expect(asrEnhancementCapability({ baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' })).toBe('prompt')
  expect(asrEnhancementCapability({ baseUrl: 'http://localhost:8080/v1', model: 'whisper-1' })).toBe('none')
  expect(asrEnhancementCapability({ baseUrl: 'https://proxy.example.com', model: 'qwen3-asr-flash', asrAdapter: 'aliyun' })).toBe('context')
  expect(asrEnhancementCapability({ baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-asr-flash-filetrans', asrAdapter: 'aliyun' })).toBe('none')
})
it('bounds context bytes and terms without cutting the final name in half', () => {
  const context = asrTermContext(Array.from({ length: 30 }, (_, i) => '专有名词' + i))
  expect(new TextEncoder().encode(context).length).toBeLessThanOrEqual(200)
  expect(context.split(', ').length).toBeLessThanOrEqual(20)
  expect(context).toMatch(/\d$/u)
})
