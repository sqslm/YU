import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { askAgent } from './agent'
import { complete } from './providers/llm'
import { ChatService, chatContext } from './chat'
vi.mock('./agent', () => ({ askAgent: vi.fn() }))
vi.mock('./providers/llm', () => ({ complete: vi.fn(async () => '项目讨论') }))
let root: string, service: ChatService
beforeEach(() => {
  vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'yu-chat-service-'))
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.profiles = [{ ...settings.polish, id: 'qa', name: 'QA', kind: 'llm', preset: '', enabled: true }]
  service = new ChatService(join(root, 'chats.db'), () => settings, () => {})
  vi.mocked(askAgent).mockResolvedValue({ text: '回答', sources: [], searched: false, taskState: 'completed' })
})
afterEach(() => { service.close(); rmSync(root, { recursive: true, force: true }) })
it('isolates conversation context and excludes failed or uncompleted turns', async () => {
  const a = service.create(null), b = service.create(null)
  await service.send(a.id, '第一条'); await service.send(a.id, '第二条'); await service.send(b.id, '其他对话')
  expect(vi.mocked(askAgent).mock.calls[1][5]?.conversation?.messages).toEqual([{ role: 'user', content: '第一条' }, { role: 'assistant', content: '回答' }])
  expect(vi.mocked(askAgent).mock.calls[2][5]?.conversation?.messages).toEqual([])
  const detail = service.get(a.id); detail.messages[1].state = 'error'
  expect(chatContext(detail).some(message => message.content === '第一条')).toBe(false)
  await vi.waitFor(() => expect(service.get(a.id).title).toBe('项目讨论'))
  expect(complete).toHaveBeenCalled()
})
it('persists model errors and partial cancellation rather than leaving a permanent working state', async () => {
  const a = service.create(null)
  vi.mocked(askAgent).mockRejectedValueOnce(Error('LLM offline'))
  await service.send(a.id, '失败测试')
  expect(service.get(a.id).messages.at(-1)).toMatchObject({ state: 'error', text: 'LLM offline' })
  vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, signal, _log, options) => {
    options?.onDelta?.('部分内容'); service.cancel(); signal?.throwIfAborted(); throw Error('unreachable')
  })
  await service.send(a.id, '取消测试')
  expect(service.get(a.id).messages.at(-1)).toMatchObject({ state: 'cancelled', text: '部分内容' })
  expect(service.busy).toBe(false)
})
it('keeps a usable fallback title when automatic naming fails', async () => {
  vi.mocked(complete).mockRejectedValueOnce(Error('title offline'))
  const thread = service.create(null)
  await service.send(thread.id, '讨论产品介绍视频')
  await vi.waitFor(() => expect(service.get(thread.id).title).toBe('讨论产品介绍视频'))
  expect(service.get(thread.id).messages.at(-1)?.state).toBe('done')
})
it('keeps temporary memory mode across later messages and reopening a conversation', async () => {
  const thread = service.create(null)
  vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, _signal, _log, options) => {
    options!.conversation!.memoryTemporary = true
    return { text: '不读写长期记忆', sources: [], searched: false }
  })
  await service.send(thread.id, '临时对话')
  expect(service.get(thread.id).memoryTemporary).toBe(true)
  await service.send(thread.id, '我喜欢短句')
  expect(vi.mocked(askAgent).mock.calls[1][5]?.conversation?.memoryTemporary).toBe(true)
  expect(service.create(null).memoryTemporary).toBe(false)
})
it('persists attachments and provides them again on follow-up without mixing them into user learning text', async () => {
  const thread = service.create(null)
  await service.send(thread.id, '概括这个文档', [{ name: 'notes.txt', bytes: Buffer.from('文档中的人物喜欢长句。') }])
  const call = vi.mocked(askAgent).mock.calls[0]
  expect(call[1]).toBe('概括这个文档')
  expect(call[5]?.conversation?.reference?.content).toContain('文档中的人物喜欢长句')
  expect(service.get(thread.id).messages[0].attachments?.[0]).toMatchObject({ name: 'notes.txt', kind: 'document' })
  expect(service.get(thread.id).messages[0].attachments?.[0]).not.toHaveProperty('text')
  await service.send(thread.id, '里面的人喜欢什么')
  expect(vi.mocked(askAgent).mock.calls[1][5]?.conversation?.reference?.content).toContain('文档中的人物喜欢长句')
  service.close()
  const reopened = new ChatService(join(root, 'chats.db'), () => DEFAULT_SETTINGS, () => {})
  expect(reopened.store.references(thread.id)[0].text).toContain('喜欢长句')
  reopened.edit({ action: 'delete', id: thread.id })
  expect(reopened.store.references(thread.id)).toEqual([])
  reopened.close()
})
