import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
it('hands the turn the profile text it was given, and answers anyway when it cannot be read', async () => {
  const withProfile = new ChatService(join(root, 'profile-on.db'), () => settings, () => {}, () => ({}), undefined, undefined,
    async () => '偏好：先给结论')
  try {
    const thread = withProfile.create(null)
    await withProfile.send(thread.id, '怎么写')
    expect(vi.mocked(askAgent).mock.calls.at(-1)?.[2]).toEqual({ profile: '偏好：先给结论' })
  } finally { withProfile.close() }
  const broken = new ChatService(join(root, 'profile-error.db'), () => settings, () => {}, () => ({}), undefined, undefined,
    async () => { throw Error('helper down') })
  try {
    const thread = broken.create(null)
    await broken.send(thread.id, '怎么写')
    // No profile reaching the model is the honest degradation; the answer still happens.
    expect(vi.mocked(askAgent).mock.calls.at(-1)?.[2]).toEqual({})
    expect(broken.get(thread.id).messages.at(-1)).toMatchObject({ state: 'done', text: '回答' })
  } finally { broken.close() }
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

it('records an analysed attachment as its own source with the range that was sent', async () => {
  const done: import('./knowledge/collector').ChatTurnDone[] = []
  const collecting = new ChatService(join(root, 'collect-attachment.db'), () => settings, () => {}, () => ({}), turn => done.push(turn))
  try {
    const thread = collecting.create(null)
    await collecting.send(thread.id, '概括这个文档', [{ name: '报告.txt', bytes: Buffer.from('文档正文在第一段。') }])
    expect(done).toHaveLength(1)
    const attachment = collecting.get(thread.id).messages[0].attachments?.[0]
    expect(done[0].materials).toHaveLength(1)
    expect(done[0].materials[0]).toMatchObject({
      origin: `attachment:${attachment!.id}`,
      title: '报告.txt',
      text: '文档正文在第一段。',
      attachmentId: attachment!.id
    })
    // A follow-up re-sends the thread's recent attachments, so the same file keeps
    // one identity instead of becoming a second source.
    vi.mocked(askAgent).mockResolvedValueOnce({ text: '回答', sources: [], searched: false, taskState: 'completed' })
    await collecting.send(thread.id, '再问一句')
    expect(done[1].materials.map(material => material.origin)).toEqual([`attachment:${attachment!.id}`])
  } finally { collecting.close() }
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

it('only collects a turn that really completed, never a transient state', async () => {
  const done: import('./knowledge/collector').ChatTurnDone[] = []
  const collecting = new ChatService(join(root, 'collect-states.db'), () => settings, () => {}, () => ({}), turn => done.push(turn))
  try {
    const thread = collecting.create(null)
    for (const state of ['awaiting_confirmation', 'cancelled', 'pending'] as const) {
      vi.mocked(askAgent).mockResolvedValueOnce({ text: '回答', sources: [], searched: false, taskState: state })
      await collecting.send(thread.id, `问题-${state}`)
    }
    expect(done).toHaveLength(0)
    vi.mocked(askAgent).mockResolvedValueOnce({ text: '回答', sources: [], searched: false, taskState: 'completed' })
    await collecting.send(thread.id, '问题-完成')
    expect(done).toHaveLength(1)
  } finally { collecting.close() }
})

it('retracts the thread tasks when a conversation is deleted or turns temporary', async () => {
  const removed: Array<[string, string]> = [], done: import('./knowledge/collector').ChatTurnDone[] = []
  const collecting = new ChatService(join(root, 'collect-removed.db'), () => settings, () => {}, () => ({}),
    turn => done.push(turn), (id, reason) => { removed.push([id, reason]) })
  try {
    const deleted = collecting.create(null)
    await collecting.send(deleted.id, '会被删除')
    collecting.edit({ action: 'delete', id: deleted.id })
    expect(removed).toEqual([[deleted.id, 'thread deleted']])

    const flipped = collecting.create(null)
    vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, _signal, _log, options) => {
      // A turn can become temporary while it is being answered.
      options!.conversation!.memoryTemporary = true
      return { text: '临时回答', sources: [], searched: false, taskState: 'completed' }
    })
    await collecting.send(flipped.id, '临时对话')
    expect(done).toHaveLength(1)
    expect(removed.at(-1)).toEqual([flipped.id, 'thread became temporary'])
    expect(collecting.get(flipped.id).memoryTemporary).toBe(true)
  } finally { collecting.close() }
})

describe('knowledge citations in the chat page', () => {
  const hit = (id: string, title: string, summary = '') => ({ id, title, summary, kind: 'concept', topics: [], updatedAt: 1 })
  const knowledge = (): import('./tools/knowledge').KnowledgeTools => ({
    enabled: () => true,
    search: vi.fn(),
    get: vi.fn(),
    extractFromNote: vi.fn()
  } as unknown as import('./tools/knowledge').KnowledgeTools)

  it('cites only the card the answer declared, and stores the same card it cited', async () => {
    const turns: import('./knowledge/collector').ChatTurnDone[] = []
    const chat = new ChatService(join(root, 'citations.db'), () => settings, () => {}, () => ({ knowledge: knowledge() }), turn => turns.push(turn))
    try {
      const thread = chat.create(null)
      vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, _signal, _log, options) => {
        // Two cards share a title, so only the declared id can prove which was used.
        options?.onToolResult?.('search_knowledge', { ok: true, summary: '知识库命中 2 条：锁粒度', data: { ok: true, query: '锁', total: 2, items: [hit('card_1', '锁粒度', '锁的粒度决定竞争范围'), hit('card_3', '锁粒度', '空值缓存')] } })
        return { text: '锁粒度决定竞争范围[[card:card_1]]。', sources: [], searched: false, taskState: 'completed' }
      })
      await chat.send(thread.id, '锁粒度是什么意思')
      expect(turns[0].citedCardIds).toEqual(['card_1'])
      const message = chat.get(thread.id).messages.at(-1)!
      // The candidate is not stored as if the answer had used it.
      expect(message.records?.filter(record => record.kind === 'knowledge').map(record => record.id)).toEqual(['card_1'])
      // The marker never reaches the stored answer.
      expect(message.text).toBe('锁粒度决定竞争范围。')
    } finally { chat.close() }
  })

  it('cites nothing for a card that was only read, and drops an invented id', async () => {
    const turns: import('./knowledge/collector').ChatTurnDone[] = []
    const chat = new ChatService(join(root, 'citations-open.db'), () => settings, () => {}, () => ({ knowledge: knowledge() }), turn => turns.push(turn))
    try {
      const thread = chat.create(null)
      vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, _signal, _log, options) => {
        options?.onToolResult?.('search_knowledge', { ok: true, summary: '知识库命中 1 条：幂等键', data: { ok: true, query: '幂等', total: 1, items: [hit('card_2', '幂等键', '重复提交要用幂等键')] } })
        options?.onToolResult?.('get_knowledge', { ok: true, summary: '已读取卡片：幂等键', data: { ok: true, card: { id: 'card_2', title: '幂等键', kind: 'concept', topics: [], body: '重复提交要用幂等键。', sourceIds: [], updatedAt: 5 } } })
        return { text: '好的。', sources: [], searched: false, taskState: 'completed' }
      })
      await chat.send(thread.id, '这两件事')
      // Browsing and even opening a card is not a citation.
      expect(turns[0].citedCardIds).toEqual([])
      expect(chat.get(thread.id).messages.at(-1)?.records?.filter(record => record.kind === 'knowledge')).toEqual([])

      // An id this turn never received is dropped with its marker, and so is the row.
      vi.mocked(askAgent).mockResolvedValueOnce({ text: '我记得[[card:card_9]]这张卡片。', sources: [], searched: false, taskState: 'completed' })
      await chat.send(thread.id, '再说一次')
      expect(turns[1].citedCardIds).toEqual([])
      expect(chat.get(thread.id).messages.at(-1)?.text).toBe('我记得这张卡片。')
    } finally { chat.close() }
  })

  it('tells the collector nothing for a temporary thread', async () => {
    const turns: import('./knowledge/collector').ChatTurnDone[] = []
    const chat = new ChatService(join(root, 'citations-temp.db'), () => settings, () => {}, () => ({ knowledge: knowledge() }), turn => turns.push(turn))
    try {
      const thread = chat.create(null)
      chat.store.markTemporary(thread.id)
      vi.mocked(askAgent).mockImplementationOnce(async (_settings, _text, _context, _signal, _log, options) => {
        options?.onToolResult?.('search_knowledge', { ok: true, summary: '知识库命中 1 条：锁粒度', data: { ok: true, query: '锁', total: 1, items: [hit('card_1', '锁粒度', '锁的粒度决定竞争范围')] } })
        return { text: '锁粒度决定竞争范围。', sources: [], searched: false, taskState: 'completed' }
      })
      await chat.send(thread.id, '锁粒度')
      expect(turns).toEqual([])
    } finally { chat.close() }
  })
})
