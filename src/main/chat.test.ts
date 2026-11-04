import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { askAgent } from './agent'
import { complete } from './providers/llm'
import { ChatService, chatContext } from './chat'
// The real source-list helpers stay real (the point is that they run at store time); only the
// model call is stubbed.
vi.mock('./agent', async () => ({ ...await vi.importActual<typeof import('./agent')>('./agent'), askAgent: vi.fn() }))
vi.mock('./providers/llm', () => ({ complete: vi.fn(async () => '项目讨论') }))
let root: string, service: ChatService, settings: Settings
beforeEach(() => {
  vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'yu-chat-service-'))
  settings = structuredClone(DEFAULT_SETTINGS)
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
it('answers a current-page summary without spending the search quota', async () => {
  const thread = service.create(null)
  await service.send(thread.id, '总结一下这个网页的主要内容')
  const options = vi.mocked(askAgent).mock.calls.at(-1)?.[5]
  expect(options?.allowedTools).not.toContain('web_search')
  // 「语」 answers as itself in the chat page.
  expect(options?.identity).toContain('「语」')
})
it('keeps the web tools when the request explicitly asks to search', async () => {
  const thread = service.create(null)
  await service.send(thread.id, '搜索并总结这个网页')
  expect(vi.mocked(askAgent).mock.calls.at(-1)?.[5]?.allowedTools).toContain('web_search')
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
it('answers with the conversation model and effort, never with the dictation block', async () => {
  // The dictation block is tuned for speed (no thinking); a conversation must not inherit that.
  settings.polish.effort = 'off'; settings.polish.model = 'polish-model'
  settings.profiles.push({ ...settings.polish, id: 'pro', name: 'Pro', kind: 'llm', preset: '', enabled: true, baseUrl: 'https://pro.example/v1', model: 'pro-1', apiKey: 'sk-pro' })
  const thread = service.create(null)
  service.edit({ action: 'model', id: thread.id, profileId: 'pro', effort: 'max' })
  await service.send(thread.id, '你好')
  expect(vi.mocked(askAgent).mock.calls[0][0].polish).toMatchObject({ baseUrl: 'https://pro.example/v1', model: 'pro-1', apiKey: 'sk-pro', effort: 'max' })
})
it('falls back to the first enabled profile and thinking-on when the conversation never chose', async () => {
  const thread = service.create(null)
  await service.send(thread.id, '你好')
  expect(vi.mocked(askAgent).mock.calls[0][0].polish.effort).toBe('high')
  // '' survives as "let the model decide" instead of collapsing into the 高 default.
  service.edit({ action: 'model', id: thread.id, profileId: null, effort: '' })
  await service.send(thread.id, '再来一次')
  expect(vi.mocked(askAgent).mock.calls[1][0].polish.effort).toBe('')
})
it('does not let blank profile fields erase the configured provider fields', async () => {
  settings.profiles.push({ ...settings.polish, id: 'bare', name: 'Bare', kind: 'llm', preset: '', enabled: true, baseUrl: 'https://bare.example/v1', model: 'bare-1', apiKey: '', requestPath: '  ', extraHeaders: '' })
  const thread = service.create(null)
  service.edit({ action: 'model', id: thread.id, profileId: 'bare', effort: 'low' })
  await service.send(thread.id, '你好')
  const polish = vi.mocked(askAgent).mock.calls[0][0].polish
  expect(polish).toMatchObject({ baseUrl: 'https://bare.example/v1', model: 'bare-1', apiKey: settings.polish.apiKey, effort: 'low' })
  expect(polish.requestPath).toBe(settings.polish.requestPath)
})
it('stores the answer without the appended source list and keeps the source cards unique', async () => {
  vi.mocked(askAgent).mockResolvedValueOnce({ text: '答案正文\n\n## 来源\n- [A](https://a.example/1)', sources: [{ title: 'A', url: 'https://a.example/1', snippet: '' }, { title: 'A 又一次', url: 'https://a.example/1#part', snippet: '' }, { title: 'B', url: 'https://b.example/2', snippet: '' }], searched: true, taskState: 'completed' })
  const thread = service.create(null)
  await service.send(thread.id, '查一下')
  const answer = service.get(thread.id).messages.at(-1)!
  expect(answer.text).toBe('答案正文')
  expect(answer.sources.map(source => source.url)).toEqual(['https://a.example/1', 'https://b.example/2'])
})

it('hands a completed turn to the collector and skips a failed one', async () => {
  const done: import('./knowledge/collector').ChatTurnDone[] = []
  const collecting = new ChatService(join(root, 'collect.db'), () => settings, () => {}, () => ({}), turn => done.push(turn))
  try {
    const thread = collecting.create(null)
    await collecting.send(thread.id, '问题一')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ threadId: thread.id, question: '问题一', answer: '回答', materials: [] })
    expect(done[0].userId).toBeTruthy(); expect(done[0].answerId).toBeTruthy()
    vi.mocked(askAgent).mockRejectedValueOnce(new Error('provider down'))
    await collecting.send(thread.id, '问题二').catch(() => undefined)
    expect(done).toHaveLength(1)
  } finally { collecting.close() }
})
