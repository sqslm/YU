import { describe, expect, it, vi } from 'vitest'
import { KnowledgeCollector, isReadingTool, noteBody, noteProjection, readingMaterial } from './collector'
import type { KnowledgeHost } from './host'
import type { Settings } from '@shared/types'

function settings(patch: Partial<Settings['knowledge']> = {}): Settings {
  return { knowledge: { enabled: true, notes: true, chat: true, reading: true, ...patch } } as Settings
}

/** A host double: the collector only ever calls publishSource and friends. */
function fakeHost() {
  return {
    publishSource: vi.fn(async (input: unknown) => ({ sourceId: 's1', version: 1, fingerprint: 'f', groupId: 'g1', state: 'stabilizing', duplicate: false, input })),
    invalidateTask: vi.fn(async () => ({ groupId: 'g1', state: 'cancelled' })),
    retryTask: vi.fn(async () => ({ groupId: 'g1', state: 'stabilizing' })),
    needsReread: vi.fn(async () => ({ groupId: 'g1', state: 'needs_reread' })),
    configureCollect: vi.fn(async () => ({ note: true, chat: true, reading: true, pausedManual: false, pausedGame: false }))
  }
}

function collector(current: Settings, host: ReturnType<typeof fakeHost>) {
  return new KnowledgeCollector({ settings: () => current, host: () => host as unknown as KnowledgeHost })
}

describe('knowledge collector projections', () => {
  it('publishes the polished body and falls back to the transcript', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteSettled({ id: 'n1', transcript: '原始', polished: '润色后', updatedAt: 1 })
    subject.noteSettled({ id: 'n2', transcript: '只有原文', polished: '', updatedAt: 2 })
    expect(host.publishSource).toHaveBeenCalledTimes(2)
    expect(host.publishSource.mock.calls[0][0]).toMatchObject({ channel: 'note', kind: 'note', groupKey: 'n1', text: '润色后' })
    expect(host.publishSource.mock.calls[1][0]).toMatchObject({ groupKey: 'n2', text: '只有原文' })
  })

  it('creates nothing for an empty body, a disabled channel or a disabled master switch', () => {
    for (const [current, note] of [
      [settings(), { id: 'n1', transcript: '   ', polished: '', updatedAt: 1 }],
      [settings({ notes: false }), { id: 'n2', transcript: '正文', polished: '', updatedAt: 1 }],
      [settings({ enabled: false }), { id: 'n3', transcript: '正文', polished: '', updatedAt: 1 }]
    ] as const) {
      const host = fakeHost(), subject = collector(current, host)
      subject.noteSettled({ ...note })
      expect(host.publishSource).not.toHaveBeenCalled()
    }
  })

  it('publishes one chat item per finished question, grouped by thread', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.threadFinished({ threadId: 't1', threadTitle: '标题', userId: 'u1', answerId: 'a1', question: '问题', answer: '回答', at: 5 })
    expect(host.publishSource.mock.calls[0][0]).toMatchObject({
      channel: 'chat', kind: 'chat', groupKey: 't1', originRef: 't1:u1:a1', text: '问题\n\n回答'
    })
  })

  it('caps reading material at five items and 48000 characters and records the range', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    const materials = Array.from({ length: 7 }, (_, index) => ({ title: `材料${index}`, text: '知'.repeat(12_000) }))
    subject.readingFinished({
      originRef: 'ask:1', groupKey: 'ask:1', title: '页面', scope: '浮动提问', request: '总结',
      materials, answer: '答案', sources: [{ title: '来源', url: 'https://example.test/a' }], at: 1
    })
    const input = host.publishSource.mock.calls[0][0] as { scope: string; text: string; channel: string }
    expect(input.channel).toBe('reading')
    expect(input.scope).toContain('4/7')
    expect(input.scope).toContain('已截断')
    expect(input.text).toContain('【材料 4】')
    expect(input.text).not.toContain('【材料 5】')
    expect(input.text).toContain('https://example.test/a')
  })

  it('does not publish a reading answer without a body', () => {
    const host = fakeHost(), subject = collector(settings({ reading: false }), host)
    subject.readingFinished({
      originRef: 'ask:2', groupKey: 'ask:2', title: '页面', scope: '浮动提问', request: '总结',
      materials: [{ title: '材料', text: '正文' }], answer: '答案', sources: [], at: 1
    })
    expect(host.publishSource).not.toHaveBeenCalled()
  })

  it('addresses removals by channel and key instead of a minted id', () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.noteRemoved('n1')
    subject.threadRemoved('t1')
    expect(host.invalidateTask.mock.calls[0]).toEqual([{ channel: 'note', groupKey: 'n1' }, 'note deleted'])
    expect(host.invalidateTask.mock.calls[1]).toEqual([{ channel: 'chat', groupKey: 't1' }, 'thread deleted'])
  })
})

describe('knowledge collector helpers', () => {
  it('normalizes a tool payload and ignores an empty body', () => {
    expect(readingMaterial('read_webpage', { url: 'https://example.test', title: '标题', text: '正文', truncated: true }))
      .toEqual({ title: '标题', text: '正文', url: 'https://example.test', truncated: true })
    expect(readingMaterial('read_current_content', { path: 'C:/a.md', text: '正文', coverage: '已保存文件正文' }))
      .toMatchObject({ title: 'C:/a.md', coverage: '已保存文件正文' })
    expect(readingMaterial('read_webpage', { text: '   ' })).toBeNull()
    expect(readingMaterial('read_webpage', null)).toBeNull()
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
      id: 'n1', title: undefined, transcript: '原始', polished: '', updatedAt: 3
    })
  })

  it('keeps the reading body for a retry and reports a lost one', async () => {
    const host = fakeHost(), subject = collector(settings(), host)
    subject.readingFinished({
      originRef: 'ask:3', groupKey: 'ask:3', title: '页面', scope: '浮动提问', request: '总结',
      materials: [{ title: '材料', text: '正文' }], answer: '答案', sources: [], at: 1
    })
    expect(subject.locate('ask:3')).toContain('【回答】')
    host.retryTask.mockRejectedValueOnce(new Error('only a failed task can be retried'))
    await subject.retry('ask:3')
    expect(host.needsReread).not.toHaveBeenCalled()
    host.retryTask.mockRejectedValue(new Error('queue group not found'))
    await subject.retry('missing')
    expect(host.needsReread).toHaveBeenCalledWith({ groupId: 'missing' }, expect.stringContaining('no longer in memory'))
  })

  it('mirrors the switches only when the master switch is on', async () => {
    const off = fakeHost()
    await collector(settings({ enabled: false }), off).sync()
    expect(off.configureCollect).not.toHaveBeenCalled()
    const on = fakeHost()
    await collector(settings({ notes: false }), on).sync()
    expect(on.configureCollect).toHaveBeenCalledWith({ notes: false, chat: true, reading: true })
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
