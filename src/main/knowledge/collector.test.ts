import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  KnowledgeCollector,
  attachmentMaterial,
  isReadingTool,
  materialKind,
  noteBody,
  readingKey,
  noteProjection,
  readingMaterial
} from './collector'
import type { KnowledgeHost } from './host'
import type { Settings } from '@shared/types'

function settings(patch: Partial<Settings['knowledge']> = {}): Settings {
  return { knowledge: { enabled: true, notes: true, chat: true, reading: true, ...patch } } as Settings
}

/** A host double: the collector only ever calls these methods. */
function fakeHost(options: { running?: boolean } = {}) {
  let group = 0
  return {
    running: options.running ?? true,
    publishSource: vi.fn(async (input: unknown) => ({
      sourceId: `s${group}`,
      version: 'v1',
      fingerprint: 'f',
      groupId: `g${++group}`,
      state: 'stabilizing',
      duplicate: false,
      input
    })),
    invalidateTask: vi.fn(async () => ({ groupId: 'g1', state: 'cancelled' })),
    /**
     * One group with one item, which is all recovery needs: the channel decides
     * which store is read, the item carries the id and the origin reference.
     */
    queueItems: vi.fn(async ({ groupId }: { groupId: string }) => ({
      channel: 'reading' as const,
      // `queue.items` answers with the items of one group, so recovery reads the
      // origin reference straight off the first entry.
      items:
        groupId === 'g-never-seen'
          ? []
          : [{ sourceId: 's1', originRef: 'https://example.test/y', ordinal: 0, kind: 'web', title: '', locator: '', scope: '', size: 1, readAt: 1, state: 'active' }],
      total: 1, offset: 0, limit: 1, hasMore: false, nextOffset: null, paused: false,
      channels: { enabled: true, note: true, chat: true, reading: true, pausedManual: false, pausedGame: false }
    })),
    readSource: vi.fn(async () => ({ source: {}, matched: true, fingerprint: 'f', size: 1 })),
    invalidateThread: vi.fn(async () => ({ threadKey: 't1', cancelled: ['g1'], reason: 'thread deleted' })),
    retryTask: vi.fn(async () => ({ groupId: 'g1', state: 'stabilizing' })),
    needsReread: vi.fn(async () => ({ groupId: 'g1', state: 'needs_reread' })),
    configureCollect: vi.fn(async () => ({ enabled: true, note: true, chat: true, reading: true, pausedManual: false, pausedGame: false }))
  }
}

function collector(current: Settings, host: ReturnType<typeof fakeHost>) {
  return new KnowledgeCollector({ settings: () => current, host: () => host as unknown as KnowledgeHost })
}

describe('knowledge collector notes', () => {
  it('publishes the polished body and falls back to the transcript', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteSettled({ id: 'n1', transcript: '原始', polished: '润色后', updatedAt: 1 })
    subject.noteSettled({ id: 'n2', transcript: '只有原文', polished: '', updatedAt: 2 })
    expect(host.publishSource).toHaveBeenCalledTimes(2)
    expect(host.publishSource.mock.calls[0][0]).toMatchObject({ channel: 'note', kind: 'note', groupKey: 'n1', text: '润色后' })
    expect(host.publishSource.mock.calls[1][0]).toMatchObject({ groupKey: 'n2', text: '只有原文' })
  })

  it('creates nothing while a body is unsaved or a polish is still running', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteSettled({ id: 'n1', transcript: '', polished: '', updatedAt: 1, pending: true })
    subject.noteSettled({ id: 'n2', transcript: '正文', polished: '', updatedAt: 1, polishStatus: 'pending' })
    expect(host.publishSource).not.toHaveBeenCalled()
  })

  it('creates nothing for a disabled channel or a disabled master switch', () => {
    for (const current of [settings({ notes: false }), settings({ enabled: false })]) {
      const host = fakeHost(), subject = collector(current, host)
      subject.noteSettled({ id: 'n3', transcript: '正文', polished: '', updatedAt: 1 })
      expect(host.publishSource).not.toHaveBeenCalled()
    }
  })

  it('retracts the old task when a body is cleared on purpose', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteSettled({ id: 'n1', transcript: '   ', polished: '', updatedAt: 1 })
    expect(host.publishSource).not.toHaveBeenCalled()
    expect(host.invalidateTask).toHaveBeenCalledWith({ channel: 'note', groupKey: 'n1' }, 'note body cleared')
  })
})

describe('knowledge collector chat turns', () => {
  it('publishes one item per finished question, grouped by thread', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.threadFinished({ threadId: 't1', threadTitle: '标题', userId: 'u1', answerId: 'a1', question: '问题', answer: '回答', at: 5 })
    expect(host.publishSource.mock.calls[0][0]).toMatchObject({
      channel: 'chat',
      kind: 'chat',
      groupKey: 't1',
      threadKey: 't1',
      originRef: 't1:u1:a1',
      text: '问题\n\n回答'
    })
  })

  it('carries the cards this answer really cited, deduped and capped', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    const many = ['c1', 'c2', 'c1', '', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13']
    subject.threadFinished({ threadId: 't1', userId: 'u1', answerId: 'a1', question: '问题', answer: '回答', at: 5, citedCardIds: many })
    const published = host.publishSource.mock.calls[0][0] as { citedCardIds?: string[] }
    // Duplicates and blanks collapse; the cap keeps the frame small.
    expect(published.citedCardIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'])
  })

  it('sends no cited list when the answer cited nothing', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.threadFinished({ threadId: 't1', userId: 'u1', answerId: 'a1', question: '问题', answer: '回答', at: 5, citedCardIds: [] })
    expect(host.publishSource.mock.calls[0][0]).not.toHaveProperty('citedCardIds')
  })

  it('ignores a turn without a question or an answer', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.threadFinished({ threadId: 't1', userId: 'u1', answerId: 'a1', question: '  ', answer: '回答', at: 5 })
    subject.threadFinished({ threadId: 't1', userId: 'u1', answerId: 'a2', question: '问题', answer: '  ', at: 5 })
    expect(host.publishSource).not.toHaveBeenCalled()
  })

  it('addresses removals by channel and key instead of a minted id', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteRemoved('n1')
    subject.threadRemoved('t1')
    expect(host.invalidateTask).toHaveBeenCalledWith({ channel: 'note', groupKey: 'n1' }, 'note deleted')
    expect(host.invalidateThread).toHaveBeenCalledWith('t1', 'thread deleted')
  })
})

describe('knowledge collector reading', () => {
  it('publishes one source per material under its own identity', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.readingFinished({
      threadId: 'ask:1',
      scope: '浮动提问',
      request: '比较两个文件',
      materials: [
        { origin: 'https://example.test/a?p=2', title: '页面甲', text: '甲正文', url: 'https://example.test/a?p=2', coverage: '公开网页正文' },
        { origin: 'E:/docs/乙.md', title: '乙文档', text: '乙正文', path: 'E:/docs/乙.md', locator: '第 3 章' }
      ],
      answer: '答案',
      sources: [{ title: '来源', url: 'https://example.test/a?p=2' }],
      at: 7
    })
    expect(host.publishSource).toHaveBeenCalledTimes(2)
    const [first, second] = host.publishSource.mock.calls.map(call => call[0]) as Array<Record<string, unknown>>
    expect(first).toMatchObject({
      channel: 'reading',
      kind: 'web',
      originRef: 'https://example.test/a?p=2',
      // The key is a digest of the origin: bounded, and never a truncated prefix
      // that two long URLs could share.
      groupKey: readingKey('https://example.test/a?p=2'),
      threadKey: 'ask:1',
      locator: 'https://example.test/a?p=2',
      readAt: 7
    })
    expect(String(first.scope)).toContain('材料 1/2')
    expect(String(first.scope)).toContain('公开网页正文')
    // The version is the material's own text; the question and answer belong to
    // the conversation, not to the identity of the page.
    expect(first.text).toBe('甲正文')
    expect(second).toMatchObject({ kind: 'document', originRef: 'E:/docs/乙.md', locator: '第 3 章' })
    expect(second.text).toBe('乙正文')
    expect(String(second.groupKey).length).toBeLessThan(200)
  })

  it('caps the material count and the character budget, marking the cut', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    const materials = Array.from({ length: 7 }, (_, index) => ({
      origin: `https://example.test/${index}`,
      title: `材料${index}`,
      text: '知'.repeat(12_500),
      url: `https://example.test/${index}`
    }))
    subject.readingFinished({ threadId: 'ask:1', scope: '浮动提问', request: '总结', materials, answer: '答案', sources: [], at: 1 })
    expect(host.publishSource).toHaveBeenCalledTimes(4)
    const scopes = host.publishSource.mock.calls.map(call => String((call[0] as { scope: string }).scope))
    expect(scopes[0]).toContain('材料 1/4')
    expect(scopes[3]).toContain('已截断')
  })

  it('keeps nothing when the reading channel or the master switch is off', () => {
    for (const current of [settings({ reading: false }), settings({ enabled: false })]) {
      const host = fakeHost(), subject = collector(current, host)
      subject.readingFinished({
        threadId: 'ask:2', scope: '浮动提问', request: '总结', answer: '答案', sources: [], at: 1,
        materials: [{ origin: 'https://example.test/x', title: '页面', text: '正文', url: 'https://example.test/x' }]
      })
      expect(host.publishSource).not.toHaveBeenCalled()
    }
  })

  it('reuses the stashed body for a retry and reports a lost one', async () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.readingFinished({
      threadId: 'ask:3', scope: '浮动提问', request: '总结', answer: '答案', sources: [], at: 1,
      materials: [{ origin: 'https://example.test/y', title: '页面', text: '正文', url: 'https://example.test/y' }]
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    // The stash holds the material's own text — the version the helper stored a
    // fingerprint for — not a composed summary that would never match it.
    expect(subject.locate('https://example.test/y')).toBe('正文')
    const published = host.publishSource.mock.calls[0]?.[0] as { text: string }
    expect(published.text).toBe(subject.locate('https://example.test/y'))
    // The helper minted g1; the collector must be able to map it back to the body.
    expect(await subject.retry('g1')).toBe(true)
    expect(host.retryTask).toHaveBeenCalledWith({ groupId: 'g1' })
    // A group it never saw has no body either: the task is not retried blindly.
    expect(await subject.retry('g-never-seen')).toBe(false)
    expect(host.retryTask).toHaveBeenCalledTimes(1)
  })
})

describe('knowledge collector helpers', () => {
  it('normalizes a tool payload and ignores a body without an identity', () => {
    expect(readingMaterial('read_webpage', { url: 'https://example.test/a', title: '标题', text: '正文', truncated: true }))
      .toEqual({ origin: 'https://example.test/a', title: '标题', text: '正文', url: 'https://example.test/a', truncated: true })
    expect(readingMaterial('read_current_content', { path: 'C:/a.md', text: '正文', coverage: '已保存文件正文' }))
      .toMatchObject({ origin: 'C:/a.md', title: 'C:/a.md', coverage: '已保存文件正文' })
    expect(readingMaterial('read_webpage', { text: '正文' })).toBeNull()
    expect(readingMaterial('read_webpage', { url: 'https://example.test/b', text: '   ' })).toBeNull()
    expect(readingMaterial('read_webpage', null)).toBeNull()
  })

  it('keeps an analysed attachment addressable and its kind a document', () => {
    const material = attachmentMaterial({ id: 'f1', name: '报告.pdf', text: '正文', truncated: true })!
    expect(material).toMatchObject({ origin: 'attachment:f1', attachmentId: 'f1', title: '报告.pdf', truncated: true })
    expect(materialKind(material)).toBe('document')
    expect(materialKind({ origin: 'https://example.test/a', title: 'a', text: 't', url: 'https://example.test/a' })).toBe('web')
    expect(attachmentMaterial({ id: 'f2', text: '  ' })).toBeNull()
  })

  it('recognizes only the reading tools', () => {
    expect(isReadingTool('read_webpage')).toBe(true)
    expect(isReadingTool('read_current_content')).toBe(true)
    expect(isReadingTool('web_search')).toBe(false)
  })

  it('reads a note body from either field', () => {
    expect(noteBody({ polished: '润色', transcript: '原始' })).toBe('润色')
    expect(noteBody({ polished: '', transcript: '原始' })).toBe('原始')
    expect(noteBody({})).toBe('')
    expect(noteProjection({ id: 'n1', transcript: '原始', updatedAt: 3 })).toEqual({
      id: 'n1', title: undefined, transcript: '原始', polished: '', updatedAt: 3, pending: undefined, polishStatus: undefined
    })
  })
})

describe('knowledge collector switches', () => {
  it('tells the helper "off" instead of staying silent when it is already running', async () => {
    const host = fakeHost({ running: true })
    await collector(settings({ enabled: false }), host).sync()
    expect(host.configureCollect).toHaveBeenCalledWith({ enabled: false, notes: true, chat: true, reading: true, paused: undefined })
  })

  it('never spawns the helper just to switch the feature off', async () => {
    const host = fakeHost({ running: false })
    const subject = collector(settings({ enabled: false }), host)
    subject.readingFinished({
      threadId: 'ask:1', scope: '浮动提问', request: '总结', answer: '答案', sources: [], at: 1,
      materials: [{ origin: 'https://example.test/z', title: '页面', text: '正文', url: 'https://example.test/z' }]
    })
    await subject.sync()
    expect(host.configureCollect).not.toHaveBeenCalled()
    expect(subject.locate('https://example.test/z')).toBeNull()
  })

  it('mirrors the channels and the game pause when the feature is on', async () => {
    const host = fakeHost()
    await collector(settings({ notes: false, reading: false }), host).sync({ game: true })
    expect(host.configureCollect).toHaveBeenCalledWith({ enabled: true, notes: false, chat: true, reading: false, paused: { game: true } })
  })

  it('never lets a refused publish escape', async () => {
    const host = fakeHost()
    host.publishSource.mockRejectedValueOnce(new Error('channel_disabled'))
    const log = vi.fn()
    const subject = new KnowledgeCollector({ settings: () => settings(), host: () => host as unknown as KnowledgeHost, log })
    subject.noteSettled({ id: 'n1', transcript: '正文', polished: '', updatedAt: 1 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('channel_disabled'))
  })
})

describe('knowledge collector stash', () => {
  it('marks a task needs_reread when its reading body was evicted', async () => {
    const host = fakeHost()
    const current = { ...DEFAULT_SETTINGS, knowledge: { enabled: true, notes: true, chat: true, reading: true } }
    const service = new KnowledgeCollector({ settings: () => current, host: () => host as unknown as KnowledgeHost })
    const body = 'x'.repeat(48_000)
    // The per-material cap is 48 000 characters and the stash holds 16 MiB, so the
    // first task falls out of memory long before the last one is published.
    for (let index = 0; index < 360; index += 1) {
      service.readingFinished({
        threadId: `ask-stash-${index}`,
        scope: '浮动提问',
        request: '问题',
        materials: [{ origin: `https://example.test/${index}`, title: `材料${index}`, text: body }],
        answer: '回答',
        sources: [],
        at: index
      })
    }
    await Promise.resolve()
    await expect(service.retry('g1')).resolves.toBe(false)
    expect(host.needsReread).toHaveBeenCalledWith({ groupId: 'g1' }, expect.any(String))
    expect(host.retryTask).not.toHaveBeenCalledWith({ groupId: 'g1' })
  })
})
