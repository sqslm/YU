/**
 * The chat reader's cursor across threads.
 *
 * A finished thread must advance the cursor with a sequence, never with a bare
 * thread id: a bare id reads back as "sequence 0 of that thread" and repeats the
 * same page forever, which is exactly what a byte-limited page did before.
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatStore } from '../chat-store'
import { createHistoryPages } from './pages'

const roots: string[] = []
const stores: ChatStore[] = []

function store(): ChatStore {
  const root = mkdtempSync(join(tmpdir(), 'yu-knowledge-pages-'))
  roots.push(root)
  const created = new ChatStore(join(root, 'chats.db'))
  stores.push(created)
  return created
}

/** A turn whose answer alone is ~180 000 ASCII characters. */
function turn(chats: ChatStore, threadId: string, label: string): { origin: string; text: string } {
  const begun = chats.begin(threadId, `${label} 的问题`)
  const answer = `${label} `.padEnd(180_000, 'x')
  chats.finish(begun.answerId, answer, 'done')
  return { origin: `${threadId}:${begun.userId}:${begun.answerId}`, text: `${label} 的问题\n\n${answer}` }
}

afterEach(() => {
  for (const created of stores.splice(0)) {
    try {
      created.close()
    } catch {
      // already closed
    }
  }
})

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a byte-limited page that ends inside a thread', () => {
  it('moves on to the next thread instead of repeating the finished one', () => {
    const chats = store()
    const first = chats.create().id
    const second = chats.create().id
    const a0 = turn(chats, first, 'A0')
    const a1 = turn(chats, first, 'A1')
    const b0 = turn(chats, second, 'B0')

    const pages = createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats })
    const bound = chats.historyBound()
    const seen: string[] = []
    const cursors: (string | null)[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard += 1) {
      const page = pages.chat(cursor, bound)
      cursors.push(page.cursor)
      seen.push(...page.rows.map(row => row.originRef))
      if (page.done) break
      expect(page.cursor).not.toBe(cursor)
      cursor = page.cursor
    }

    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toEqual(expect.arrayContaining([a0.origin, a1.origin, b0.origin]))
    // The first page ends before B0 (A0 + A1 already fill the byte budget), and it
    // must carry a sequence for the finished thread, not the bare thread id.
    expect(cursors[0]!.startsWith(`${first}:`)).toBe(true)
    expect(cursors[0]).not.toBe(first)
  })

  it('keeps a row-limit page advancing across threads too', () => {
    const chats = store()
    const first = chats.create().id
    const second = chats.create().id
    const small = (threadId: string, label: string): void => {
      const begun = chats.begin(threadId, `${label} 问题`)
      chats.finish(begun.answerId, `${label} 答案`, 'done')
    }
    small(first, 'A0')
    small(first, 'A1')
    small(second, 'B0')

    const pages = createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats, limit: 2 })
    const bound = chats.historyBound()
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard += 1) {
      const page = pages.chat(cursor, bound)
      seen.push(...page.rows.map(row => row.originRef))
      if (page.done) break
      cursor = page.cursor
    }
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })
})
