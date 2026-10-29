import { expect, it, vi } from 'vitest'
import { memoryCompletion, MemoryReplyError } from './completion'

const messages = [{ role: 'user' as const, content: '我偏好中文' }]
it('requests the explicit stage schema and normalizes presentation-only wrappers without another call', async () => {
  const request = vi.fn().mockResolvedValue('结果：\n```json\n{"facts":["用户偏好中文"]}\n```')
  expect(await memoryCompletion(messages, 'facts', new AbortController().signal, request)).toBe('{"facts":["用户偏好中文"]}')
  expect(request).toHaveBeenCalledOnce()
  expect(request.mock.calls[0][0].at(-1).content).toContain('"facts"')
  expect(request.mock.calls[0][0].at(-1).content).toContain('删除“嗯、呃、那个、呢”等口头语')
  expect(request.mock.calls[0][0].at(-1).content).toContain('不添加信息')
})
it('retries invalid formatting once from the original request, not from fabricated model text', async () => {
  const request = vi.fn().mockResolvedValueOnce('模型编造的解释').mockResolvedValueOnce('{"facts":["用户偏好中文"]}')
  expect(await memoryCompletion(messages, 'facts', new AbortController().signal, request)).toContain('用户偏好中文')
  expect(request).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(request.mock.calls[1])).not.toContain('模型编造的解释')
  expect(request.mock.calls[1][0][0]).toEqual(messages[0])
})
it('rejects a response for the wrong SDK stage and stops after the second malformed result', async () => {
  const request = vi.fn().mockResolvedValue('{"facts":[]}')
  await expect(memoryCompletion(messages, 'memory', new AbortController().signal, request)).rejects.toBeInstanceOf(MemoryReplyError)
  expect(request).toHaveBeenCalledTimes(2)
})
it('does not retry network failures, cancellation or authentication errors as formatting problems', async () => {
  const request = vi.fn().mockRejectedValue(Error('HTTP 401'))
  await expect(memoryCompletion(messages, 'facts', new AbortController().signal, request)).rejects.toThrow('HTTP 401')
  expect(request).toHaveBeenCalledOnce()
  const controller = new AbortController()
  const canceled = vi.fn().mockImplementation(async () => { controller.abort(); return 'bad' })
  await expect(memoryCompletion(messages, 'facts', controller.signal, canceled)).rejects.toThrow()
  expect(canceled).toHaveBeenCalledOnce()
})
