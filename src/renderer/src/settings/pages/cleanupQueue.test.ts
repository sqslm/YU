import { describe, expect, it } from 'vitest'

import {
  EMPTY_QUEUE,
  addPending,
  abandonRetry,
  isBusy,
  mergeList,
  settleRetry,
  startRetry
} from './cleanupQueue'

const pending = (id: string, reason = 'database is locked', at = 1) => ({ id, reason, cards: true, at })
const done = { status: 'done' as const, removed: 1, kept: 0, released: 0 }
const stale = { status: 'stale' as const, reason: '预览已失效，请重新确认', removed: 0, kept: 0, released: 0 }
const failed = { status: 'failed' as const, reason: 'database is locked', removed: 0, kept: 0, released: 0 }

describe('the cleanup rows a page keeps', () => {
  it('keeps a second failure instead of replacing the first', () => {
    const one = addPending(EMPTY_QUEUE, pending('a'))
    const two = addPending(one, pending('b', 'cannot start the knowledge helper', 2))

    expect(two.rows.map(row => row.id)).toEqual(['b', 'a'])
    expect(two.rows[1].reason).toBe('database is locked')
  })

  it('puts the rows a channel query returns back, newest first', () => {
    const queue = mergeList(EMPTY_QUEUE, [pending('a', '锁住了', 5), pending('b', '锁住了', 9)])

    expect(queue.rows.map(row => row.id)).toEqual(['b', 'a'])
    expect(queue.rows[0].at).toBe(9)
  })

  it('never lets a late query resurrect a finished row or undo a stale one', () => {
    const staleRow = settleRetry(addPending(EMPTY_QUEUE, pending('a')), 'a', stale)
    const after = mergeList(staleRow, [pending('a', '数据库忙', 3)])
    expect(after.rows[0].stale).toBe(true)
    expect(after.rows[0].reason).toBe('数据库忙')

    const finished = settleRetry(staleRow, 'a', done)
    expect(finished.rows).toEqual([])
    expect(mergeList(finished, [pending('a')]).rows).toEqual([])
    expect(addPending(finished, pending('a')).rows).toEqual([])
  })

  it('keeps the rows the page already knew when the query predates them', () => {
    // The delete reply landed while the mount query was still in flight.
    const queue = addPending(EMPTY_QUEUE, pending('new', '锁住了', 7))
    const merged = mergeList(queue, [])

    expect(merged.rows.map(row => row.id)).toEqual(['new'])
  })

  it('applies one retry answer to its own id only', () => {
    let queue = addPending(addPending(EMPTY_QUEUE, pending('a')), pending('b', '锁住了', 2))
    queue = startRetry(queue, 'a')
    // A second cleanup registered while the first retry was in flight.
    queue = addPending(queue, pending('c', '锁住了', 3))
    queue = settleRetry(queue, 'a', done)

    expect(isBusy(queue, 'a')).toBe(false)
    expect(queue.rows.map(row => row.id)).toEqual(['c', 'b'])
    expect(queue.finished).toEqual(['a'])
    expect(queue.rows.every(row => row.stale === false)).toBe(true)
  })

  it('keeps the downgrade on offer when the retry fails again', () => {
    let queue = addPending(EMPTY_QUEUE, pending('a'))
    queue = settleRetry(queue, 'a', stale)
    expect(queue.rows[0].stale).toBe(true)

    // The library is locked again during the downgrade: the offer must survive.
    queue = settleRetry(queue, 'a', failed)
    expect(queue.rows[0].stale).toBe(true)
    expect(queue.rows).toHaveLength(1)

    queue = settleRetry(queue, 'a', done)
    expect(queue.rows).toEqual([])
  })

  it('clears only the in-flight lock when the request itself fails', () => {
    let queue = startRetry(addPending(EMPTY_QUEUE, pending('a')), 'a')
    queue = abandonRetry(queue, 'a')

    expect(isBusy(queue, 'a')).toBe(false)
    expect(queue.rows.map(row => row.id)).toEqual(['a'])
  })
})
