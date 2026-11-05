import { describe, expect, it } from 'vitest'

import { createHistoryPages, HISTORY_BATCH_BYTES } from './pages'
import type { NoteProjection } from './collector'

function note(index: number, text: string): NoteProjection {
  return { id: `n-${String(index).padStart(3, '0')}`, transcript: text, polished: text, polishStatus: 'ok', updatedAt: index }
}

describe('bounded history pages', () => {
  it('packs a note page by real UTF-8 bytes, not only by row count', () => {
    const notes = Array.from({ length: 40 }, (_, index) => note(index, '汉'.repeat(10_000)))
    const pages = createHistoryPages({
      notes: () => ({ list: () => ({ notes }) }),
      chats: () => ({
        historyThreads: () => [],
        historyTurns: () => ({ turns: [], nextSeq: 0, done: true }),
        get: () => ({ title: '线程' })
      }),
      limit: 20
    })
    const first = pages.notes(null, null)
    expect(first.done).toBe(false)
    // 10 000 han characters is about 30 000 UTF-8 bytes, so the byte budget stops the
    // page well before the 20-row limit instead of handing over the whole set.
    expect(first.rows.length).toBeLessThan(20)
    const bytes = Buffer.byteLength(JSON.stringify(first.rows), 'utf8')
    expect(bytes).toBeLessThanOrEqual(HISTORY_BATCH_BYTES)

    const seen = [...first.rows.map(row => row.originRef)]
    let cursor = first.cursor
    for (let guard = 0; guard < 20; guard += 1) {
      const page = pages.notes(cursor, null)
      seen.push(...page.rows.map(row => row.originRef))
      cursor = page.cursor
      if (page.done) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(40)
  })

  it('keeps every note reachable when one body alone exceeds the budget', () => {
    const huge = note(0, '长'.repeat(300_000))
    const small = note(1, '短正文')
    const pages = createHistoryPages({
      notes: () => ({ list: () => ({ notes: [huge, small] }) }),
      chats: () => ({
        historyThreads: () => [],
        historyTurns: () => ({ turns: [], nextSeq: 0, done: true }),
        get: () => ({ title: '线程' })
      })
    })
    const first = pages.notes(null, null)
    expect(first.rows.map(row => row.originRef)).toEqual([huge.id])
    const second = pages.notes(first.cursor, null)
    expect(second.rows.map(row => row.originRef)).toEqual([small.id])
    expect(second.done).toBe(true)
  })
})
