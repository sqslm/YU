import { describe, expect, it } from 'vitest'

import { CardPager } from './knowledgeView'
import type { CardPage, CardPagerDeps, CardSectionState } from './knowledgeView'

/**
 * The note's card section is driven from two places at once: the reader asking for
 * the next page, and the knowledge collector announcing that extraction finished.
 * These tests hold one request open while the other starts, which is exactly the
 * interleaving the section used to get wrong — the manual page was dropped because
 * its ticket had moved on, and the spinner of an older answer closed the newer one.
 */

type Row = { id: string }

function rows(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `card_${from + index}` }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function rig() {
  const calls: Array<{ noteId: string; offset: number; limit: number; answer: ReturnType<typeof deferred<CardPage<Row>>> }> = []
  const renders: Array<CardSectionState<Row>> = []
  const loading: boolean[] = []
  const errors: string[] = []
  const deps: CardPagerDeps<Row> = {
    page: (noteId, offset, limit) => {
      const answer = deferred<CardPage<Row>>()
      calls.push({ noteId, offset, limit, answer })
      return answer.promise
    },
    render: (state) => renders.push(state),
    loading: (on) => loading.push(on),
    error: (message) => { if (message) errors.push(message) },
    message: (error) => (error instanceof Error ? error.message : String(error))
  }
  const pager = new CardPager<Row>(() => deps)
  return { pager, calls, renders, loading, errors }
}

const page = (items: Row[], total: number, nextOffset: number | null): CardPage<Row> => ({
  items,
  total,
  hasMore: nextOffset !== null,
  nextOffset
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('the note card section while a page and a notice overlap', () => {
  it('finishes the page the reader asked for when a notice arrives first', async () => {
    const { pager, calls } = rig()
    pager.open('note_1')
    calls[0].answer.resolve(page(rows(0, 5), 8, 5))
    await settle()
    expect(pager.state.rows).toHaveLength(5)

    pager.append()
    expect(calls).toHaveLength(2)
    // The notice lands while the reader's page is still loading.
    pager.refresh()
    expect(calls).toHaveLength(2)

    calls[1].answer.resolve(page(rows(5, 3), 8, null))
    await settle()

    // The reader's page is kept, and the notice follows it once with the new range.
    expect(pager.state.rows.map((row) => row.id)).toEqual([
      'card_0', 'card_1', 'card_2', 'card_3', 'card_4', 'card_5', 'card_6', 'card_7'
    ])
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ noteId: 'note_1', offset: 0, limit: 8 })

    calls[2].answer.resolve(page(rows(0, 8), 9, 8))
    await settle()
    expect(pager.state.total).toBe(9)
    expect(pager.state.more).toBe(true)
    expect(pager.state.pages).toBe(2)
  })

  it('lets a page started during a refresh win, and drops the refresh answer', async () => {
    const { pager, calls } = rig()
    pager.open('note_1')
    calls[0].answer.resolve(page(rows(0, 5), 8, 5))
    await settle()

    pager.refresh()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ offset: 0, limit: 5 })

    pager.append()
    expect(calls).toHaveLength(3)
    calls[2].answer.resolve(page(rows(5, 3), 8, null))
    await settle()
    expect(pager.state.rows).toHaveLength(8)

    calls[1].answer.resolve(page(rows(0, 6), 9, 6))
    await settle()
    // The late refresh cannot shrink the section back to its first page.
    expect(pager.state.rows).toHaveLength(8)
    expect(pager.state.total).toBe(8)

    // …and the notice it carried is followed once, over the whole loaded range.
    expect(calls).toHaveLength(4)
    expect(calls[3]).toMatchObject({ offset: 0, limit: 8 })
  })

  it('spends one request per page and none for a notice', async () => {
    const { pager, calls } = rig()
    pager.open('note_1')
    calls[0].answer.resolve(page(rows(0, 5), 9, 5))
    await settle()
    pager.append()
    calls[1].answer.resolve(page(rows(5, 5), 9, 10))
    await settle()
    pager.refresh()
    calls[2].answer.resolve(page(rows(0, 10), 12, 10))
    await settle()

    expect(pager.state.pages).toBe(2)
    expect(pager.state.rows).toHaveLength(10)
    expect(pager.state.total).toBe(12)
  })

  it('drops an answer that belongs to the note the reader already left', async () => {
    const { pager, calls, errors } = rig()
    pager.open('note_1')
    pager.append()
    pager.open('note_2')
    expect(calls[1]).toMatchObject({ noteId: 'note_2', offset: 0 })

    calls[0].answer.resolve(page(rows(0, 5), 8, 5))
    await settle()
    expect(pager.state.rows).toHaveLength(0)

    calls[0].answer.reject(new Error('slow'))
    await settle()
    expect(errors).toEqual([])
  })

  it('keeps the spinner of the newest page even when an older answer lands later', async () => {
    const { pager, calls, loading } = rig()
    pager.open('note_1')
    calls[0].answer.resolve(page(rows(0, 5), 8, 5))
    await settle()
    expect(loading.at(-1)).toBe(false)

    // Two pages in flight: the first one landing must not close the second's spinner.
    pager.append()
    pager.append()
    expect(calls).toHaveLength(3)

    calls[1].answer.resolve(page(rows(5, 3), 8, 8))
    await settle()
    expect(loading.at(-1)).toBe(true)

    calls[2].answer.resolve(page(rows(5, 3), 8, null))
    await settle()
    expect(loading.at(-1)).toBe(false)
  })

  it('keeps the rows on screen when a notice fails, and speaks up when there are none', async () => {
    const { pager, calls, errors } = rig()
    pager.open('note_1')
    calls[0].answer.resolve(page(rows(0, 5), 8, 5))
    await settle()

    pager.refresh()
    calls[1].answer.reject(new Error('helper down'))
    await settle()
    expect(pager.state.rows).toHaveLength(5)
    expect(errors).toEqual([])

    pager.open('note_2')
    calls[2].answer.reject(new Error('helper down'))
    await settle()
    expect(errors).toEqual(['helper down'])
  })
})
