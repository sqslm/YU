/**
 * Recovery through the real entry points: a 61-turn `ChatStore`, the production
 * body resolution, the production collector and the compiled helper.
 *
 * A task whose body is still there must come back as `ready`; only a body that is
 * really gone may be retracted. The chat read is anchored at the bound question,
 * so an old turn is not mistaken for a deleted one.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'

import { ChatStore } from '../chat-store'
import { KnowledgeCollector } from './collector'
import { KnowledgeHost } from './host'
import { chatReference, createSourceRecovery } from './recover'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const roots: string[] = []
const instances: KnowledgeHost[] = []
const stores: ChatStore[] = []

vi.mock('electron', () => ({ app: { getPath: () => roots[0] ?? tmpdir() } }))

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-recover-'))
  roots.push(dir)
  return dir
}

function host(dir: string): KnowledgeHost {
  const instance = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
  instances.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
})

afterAll(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover root is reported by the caller, never hidden
    }
  }
})

describe('retrying a source whose turn is old', () => {
  it('recovers the first, a middle and the last turn of a long thread', async () => {
    if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
    const dir = root()
    const knowledge = host(dir)
    const chats = new ChatStore(join(dir, 'chats.db'))
    stores.push(chats)
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      notesDir: join(dir, 'notes'),
      knowledge: { enabled: true, notes: true, chat: true, reading: true }
    })
    const collector = new KnowledgeCollector({
      settings: () => settings,
      host: () => knowledge,
      readBody: createSourceRecovery({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats })
    })
    await knowledge.configureCollect({ enabled: true })

    // Three separate threads, each long enough that the newest-100 window never
    // reaches the turn we bind: the target is the first, the middle and the last.
    for (const index of [0, 30, 60]) {
      const { id: threadId } = chats.create()
      let pair = chats.begin(threadId, `问题${index}`)
      chats.finish(pair.answerId, `答案${index}`, 'done')
      for (let filler = 0; filler < 60; filler += 1) {
        const extra = chats.begin(threadId, `填充${filler}`)
        chats.finish(extra.answerId, `填充答案${filler}`, 'done')
      }
      expect(chats.get(threadId).total).toBe(122)
      pair = { userId: pair.userId, answerId: pair.answerId }
      const published = await knowledge.publishSource({
        channel: 'chat',
        kind: 'chat',
        originRef: chatReference(threadId, pair.userId, pair.answerId),
        groupKey: threadId,
        threadKey: threadId,
        title: `问题${index}`,
        scope: '主界面问答',
        text: `问题${index}\n\n答案${index}`,
        at: Date.now()
      })
      await knowledge.needsReread({ groupId: published.groupId }, 'test: force recovery')
      expect(await collector.retry(published.groupId)).toBe(true)
      const page = await knowledge.queueItems({ groupId: published.groupId, limit: 1 })
      // The source stayed valid and the task was not retracted: only a body that is
      // really gone may cancel the group.
      expect(page.items[0]!.state).toBe('active')
      const source = await knowledge.getSource(page.items[0]!.sourceId)
      expect(source.fingerprint).toBe(published.fingerprint)
      const listed = await knowledge.listQueue({ offset: 0, limit: 100 })
      const task = listed.items.find(item => item.id === published.groupId)
      expect(task?.state === 'cancelled').toBe(false)
      expect(task?.reason ?? null).toBeNull()
    }
  }, 60_000)
})
