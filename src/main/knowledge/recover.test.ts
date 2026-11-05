import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../chat-store'
import { chatReference, createSourceRecovery } from './recover'

const roots: string[] = []
const stores: ChatStore[] = []

function store(): ChatStore {
  const root = mkdtempSync(join(tmpdir(), 'yu-knowledge-recover-'))
  roots.push(root)
  const created = new ChatStore(join(root, 'chats.db'))
  stores.push(created)
  return created
}

/** A real store with `turns` completed question/answer pairs. */
function thread(
  turns: number,
  chats = store()
): { chats: ChatStore; id: string; pairs: { userId: string; answerId: string }[] } {
  const { id } = chats.create()
  const pairs: { userId: string; answerId: string }[] = []
  for (let index = 0; index < turns; index += 1) {
    const begun = chats.begin(id, `问题${index}`)
    chats.finish(begun.answerId, `答案${index}`, 'done')
    pairs.push(begun)
  }
  return { chats, id, pairs }
}

function recovery(chats: ChatStore) {
  return createSourceRecovery({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats })
}

afterAll(() => {
  for (const withStore of stores) withStore.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('a source bound to an old turn', () => {
  it('reads the first, a middle and the last turn of a 61-turn thread', () => {
    const { chats, id, pairs } = thread(61)
    expect(chats.get(id).total).toBe(122)

    for (const index of [0, 30, 60]) {
      const pair = pairs[index]!
      const body = recovery(chats)('chat', chatReference(id, pair.userId, pair.answerId))
      expect(body).toEqual({ text: `问题${index}\n\n答案${index}` })
    }
  })

  it('still reports a deleted thread as deleted', () => {
    const { chats, id, pairs } = thread(2)
    const other = thread(1, chats)
    chats.edit({ action: 'delete', id })
    expect(recovery(chats)('chat', chatReference(id, pairs[1]!.userId, pairs[1]!.answerId))).toEqual({
      missing: 'deleted'
    })
    expect(
      recovery(chats)('chat', chatReference(other.id, other.pairs[0]!.userId, other.pairs[0]!.answerId))
    ).toEqual({ text: '问题0\n\n答案0' })
  })

  it('refuses a temporary thread and an unfinished answer', () => {
    const { chats, id, pairs } = thread(2)
    const pending = chats.begin(id, '还在生成')
    expect(recovery(chats)('chat', chatReference(id, pending.userId, pending.answerId))).toEqual({ missing: 'unknown' })
    chats.markTemporary(id)
    expect(recovery(chats)('chat', chatReference(id, pairs[0]!.userId, pairs[0]!.answerId))).toEqual({
      missing: 'temporary'
    })
  })
})
