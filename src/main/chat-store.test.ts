import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ChatStore } from './chat-store'
let root: string, store: ChatStore
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'yu-chat-')); store = new ChatStore(join(root, 'chats.db')) })
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
it('persists messages, names and groups across restart without crossing thread boundaries', () => {
  store.edit({ action: 'group-create', name: '项目' }); const group = store.list().groups[0]
  const one = store.create(group.id), two = store.create()
  const turn = store.begin(one.id, '项目背景'); store.finish(turn.answerId, '第一条回答', 'done')
  expect(store.get(two.id).messages).toEqual([])
  store.markTemporary(one.id)
  store.close(); store = new ChatStore(join(root, 'chats.db'))
  expect(store.get(one.id).memoryTemporary).toBe(true)
  expect(store.get(one.id).messages.map(message => message.text)).toEqual(['项目背景', '第一条回答'])
  expect(store.get(one.id).groupId).toBe(group.id)
  store.edit({ action: 'rename', id: one.id, name: '我命名的对话' }); store.autoTitle(one.id, '模型迟到的标题')
  expect(store.get(one.id).title).toBe('我命名的对话')
})
it('deleting a group moves conversations to ungrouped; deleting one conversation removes only its messages', () => {
  store.edit({ action: 'group-create', name: '工作' }); const group = store.list().groups[0]
  const one = store.create(group.id), two = store.create(group.id)
  const turn = store.begin(one.id, '消息'); store.finish(turn.answerId, '回答', 'done')
  store.edit({ action: 'group-delete', id: group.id })
  expect(store.get(one.id).groupId).toBeNull(); expect(store.get(two.id).groupId).toBeNull()
  store.edit({ action: 'delete', id: one.id }); expect(() => store.get(one.id)).toThrow('不存在')
  expect(store.get(two.id).messages).toEqual([])
})
it('recovers interrupted generation and pages newest messages without reversing their order', () => {
  const thread = store.create()
  for (let i = 0; i < 4; i++) { const turn = store.begin(thread.id, String(i)); if (i < 3) store.finish(turn.answerId, `回答${i}`, 'done') }
  store.close(); store = new ChatStore(join(root, 'chats.db'))
  const detail = store.get(thread.id, 3)
  expect(detail.total).toBe(8); expect(detail.messages.map(message => message.text)).toEqual(['回答2', '3', ''])
  expect(detail.messages.at(-1)?.state).toBe('cancelled')
  expect(() => store.edit({ action: 'move', id: thread.id, groupId: 'missing' })).toThrow('分组不存在')
  expect(() => store.edit({ action: 'rename', id: thread.id, name: ' ' })).toThrow()
})
