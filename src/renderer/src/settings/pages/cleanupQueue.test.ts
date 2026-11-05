import { describe, expect, it } from 'vitest'

import { EMPTY_QUEUE, applySnapshot, clearRetry, isBusy, markRetry } from './cleanupQueue'

const first = { id: 'a', reason: 'database is locked', cards: true, stale: false, at: 10, busy: false }
const second = { id: 'b', reason: 'database is locked', cards: true, stale: false, at: 20, busy: false }

describe('the cleanup rows a page shows', () => {
  it('takes the channel rows from the main process as they are', () => {
    const queue = applySnapshot(EMPTY_QUEUE, { revision: 3, rows: [first, second] })

    expect(queue.revision).toBe(3)
    // Newest first, and nothing the page knew before can survive the replacement.
    expect(queue.rows.map(row => row.id)).toEqual(['b', 'a'])
    expect(queue.rows[0]).toEqual({ id: 'b', reason: 'database is locked', stale: false, at: 20, busy: false })
  })

  it('drops an answer older than what the page already applied', () => {
    const fresh = applySnapshot(EMPTY_QUEUE, { revision: 5, rows: [second] })
    // A mount-time query sent before the change landed resolves after it.
    const late = applySnapshot(fresh, { revision: 4, rows: [first, second] })

    expect(late).toBe(fresh)
    expect(late.rows.map(row => row.id)).toEqual(['b'])
  })

  it('cannot bring back a row that a newer snapshot already settled', () => {
    const waiting = applySnapshot(EMPTY_QUEUE, { revision: 7, rows: [first] })
    const settled = applySnapshot(waiting, { revision: 8, rows: [] })

    expect(settled.rows).toEqual([])
    // The retry reply carries the row it was about; it cannot resurrect it.
    expect(applySnapshot(settled, { revision: 7, rows: [first] }).rows).toEqual([])
  })

  it('keeps an attempt that is still running visible as busy after a remount', () => {
    const queue = applySnapshot(EMPTY_QUEUE, { revision: 9, rows: [{ ...first, busy: true }] })

    expect(isBusy(queue, 'a')).toBe(true)
    expect(queue.rows[0].busy).toBe(true)
  })

  it('blocks only the row that was clicked, and only until the next answer', () => {
    const queue = applySnapshot(EMPTY_QUEUE, { revision: 2, rows: [first, second] })
    const clicked = markRetry(queue, 'a')

    expect(isBusy(clicked, 'a')).toBe(true)
    expect(isBusy(clicked, 'b')).toBe(false)
    expect(clearRetry(clicked, 'a').rows.every(row => !row.busy)).toBe(true)
  })

  it('leaves the other rows untouched when one of them settles', () => {
    const queue = applySnapshot(EMPTY_QUEUE, { revision: 4, rows: [first, second] })
    const after = applySnapshot(queue, { revision: 5, rows: [second] })

    expect(after.rows.map(row => row.id)).toEqual(['b'])
    expect(after.revision).toBe(5)
  })
})
