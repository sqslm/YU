import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatStore } from './chat-store'
import { readWorkspaceRecord, searchWorkspace, type WorkspaceSources } from './workspace'
import type { NoteEntry } from '@shared/types'

const roots: string[] = [], stores: ChatStore[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(): WorkspaceSources {
  const root = mkdtempSync(join(tmpdir(), 'yu-workspace-')); roots.push(root)
  const chat = new ChatStore(join(root, 'chats.db')); stores.push(chat)
  return { chat, notes: () => [], history: { list: () => [], get: () => undefined }, reminders: () => [], events: () => [] }
}
it('finds Chinese text in message bodies and document attachments and opens the exact old message', () => {
  const sources = fixture(), thread = sources.chat.create(), first = sources.chat.begin(thread.id, '采购预算 50%_预算')
  sources.chat.finish(first.answerId, '批准', 'done')
  sources.chat.attach(first.userId, [{ id: 'file', name: '会议.txt', size: 20, kind: 'document', truncated: false, text: '项目代号：青山计划' }])
  for (let i = 0; i < 70; i++) { const next = sources.chat.begin(thread.id, `普通消息${i}`); sources.chat.finish(next.answerId, '回答', 'done') }
  expect(sources.chat.get(thread.id).messages.some(row => row.id === first.userId)).toBe(false)
  for (const query of ['采购', '50%_', '青山']) {
    const result = searchWorkspace(sources, query)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ kind: 'chat', id: first.userId, threadId: thread.id })
    expect(readWorkspaceRecord(sources, result.items[0]).text).toContain('采购')
  }
  expect(sources.chat.get(thread.id, 40, first.userId).messages.some(row => row.id === first.userId)).toBe(true)
  sources.chat.edit({ action: 'delete', id: thread.id })
  expect(searchWorkspace(sources, '青山').items).toEqual([])
})
it('paginates a combined result deterministically and provides the matching excerpt', () => {
  const sources = fixture()
  const notes = Array.from({ length: 42 }, (_, i) => ({ id: String(i), title: '资料', transcript: '前文'.repeat(200) + '中文关键词', polished: '', tags: [], createdAt: i, updatedAt: i, durationMs: 0, polishStatus: 'skipped' })) as NoteEntry[]
  sources.notes = () => notes
  const first = searchWorkspace(sources, '关键词'), second = searchWorkspace(sources, '关键词', 30)
  expect(first.hasMore).toBe(true); expect(second.hasMore).toBe(false)
  expect([...first.items, ...second.items].map(row => row.id)).toEqual([...notes].reverse().map(row => row.id))
  expect(first.items[0].text).toContain('关键词'); expect(first.items[0].text.length).toBeLessThan(185)
  expect(() => searchWorkspace(sources, '关键词', -1)).toThrow('无效')
  expect(() => readWorkspaceRecord(sources, { ...first.items[0], id: 'gone' })).toThrow('不存在')
})
it('keeps pages stable when many chat messages have the same timestamp', () => {
  const sources = fixture(), thread = sources.chat.create()
  vi.spyOn(Date, 'now').mockReturnValue(100)
  for (let i = 0; i < 40; i++) { const ids = sources.chat.begin(thread.id, '同时创建'); sources.chat.finish(ids.answerId, '完成', 'done') }
  const first = searchWorkspace(sources, '同时'), next = searchWorkspace(sources, '同时', 30)
  expect(new Set([...first.items, ...next.items].map(row => row.id)).size).toBe(40)
})
