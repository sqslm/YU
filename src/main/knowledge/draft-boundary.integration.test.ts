import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ChatService } from '../chat'
import { deleteThread } from '../chat-delete'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { DraftCards } from './card-draft'

/**
 * The delete boundary as the chat IPC handler runs it: a real ChatService owns the
 * thread, DraftCards owns the association, and deleteThread is the production
 * function between them. The preview is the only stand-in, and it is rejected with
 * the same error the helper raises, because the refusal itself is what has to leave
 * the association alone.
 */

const roots: string[] = []

function settings(): Settings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings
}

afterEach(() => {
  // The chat store still holds its sqlite handle on Windows; the temp root is
  // disposable, so a refused unlink is not a test failure.
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* left for the OS temp sweeper */
    }
  }
})

async function rig() {
  const root = mkdtempSync(join(tmpdir(), 'yu-draft-boundary-'))
  roots.push(root)
  const chats = new ChatService(join(root, 'chats.db'), settings, () => {}, () => ({}))
  const drafts = new DraftCards()
  const thread = chats.create(null)
  drafts.hold(thread.id, { id: 'card_1', title: '锁粒度基线' })
  // The association is dropped the way the handler drops it: only after the write.
  const deps = (overrides: { verify?: () => Promise<void>; purge?: () => Promise<void> } = {}) => ({
    edit: (input: import('@shared/chat').ChatEdit) => chats.edit(input),
    dropCard: () => drafts.drop(thread.id),
    verify: overrides.verify ?? (async () => {}),
    settle: <T,>(_id: string, body: () => Promise<T>) => body(),
    purge: overrides.purge ?? (async () => {}),
    pending: () => ({ id: 'retry-1', reason: 'database is locked', cards: true })
  })
  const del = { action: 'delete' as const, id: thread.id, deleteKnowledge: true, ticket: 'stale' }
  const exists = () => chats.list().threads.some((item) => item.id === thread.id)
  return { chats, drafts, deps, del, thread, exists }
}

describe('deleting a conversation that still holds a card draft', () => {
  it('keeps the association when the preview refuses the ticket', async () => {
    const { drafts, deps, del, thread, exists } = await rig()

    await expect(deleteThread(deps({
      verify: async () => { throw new Error('预览已失效，请重新确认') }
    }), del)).rejects.toThrow('预览已失效，请重新确认')

    expect(exists()).toBe(true)
    expect(drafts.get(thread.id)).toEqual({ id: 'card_1', title: '锁粒度基线' })
  })

  it('drops the association once the delete really landed', async () => {
    const { drafts, deps, del, thread, exists } = await rig()

    await deleteThread(deps(), del)

    expect(exists()).toBe(false)
    expect(drafts.get(thread.id)).toBeUndefined()
  })

  it('drops the association even when the cleanup afterwards fails', async () => {
    const { drafts, deps, del, thread, exists } = await rig()

    const pending = await deleteThread(deps({
      purge: async () => { throw new Error('database is locked') }
    }), del)

    expect(pending).toEqual({ id: 'retry-1', reason: 'database is locked', cards: true })
    expect(exists()).toBe(false)
    expect(drafts.get(thread.id)).toBeUndefined()
  })

  it('leaves other threads and their associations alone', async () => {
    const { chats, drafts, deps, del } = await rig()
    const other = chats.create(null)
    drafts.hold(other.id, { id: 'card_2', title: '幂等键' })

    await deleteThread(deps(), del)

    expect(chats.list().threads.some((item) => item.id === other.id)).toBe(true)
    expect(drafts.get(other.id)).toEqual({ id: 'card_2', title: '幂等键' })
  })
})
