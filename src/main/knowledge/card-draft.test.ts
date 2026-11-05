import { describe, expect, it, vi } from 'vitest'

import { DraftCards, MAX_CARD_CONTEXT, draftSeed } from './card-draft'

const card = (id: string, body = '检索先命中标题，再落到正文。') => ({
  id,
  title: `标题 ${id}`,
  body,
  updatedAt: 1_700_000_000_000
})

describe('the card a draft was opened from', () => {
  it('sends nothing for a thread that never carried a card', async () => {
    const read = vi.fn(async () => card('card_1'))
    const drafts = new DraftCards()

    const { seed } = await drafts.consume('t1', read)

    expect(seed).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the card again on the send that uses it, and bounds the body', async () => {
    const read = vi.fn(async () => card('card_1', 'x'.repeat(MAX_CARD_CONTEXT + 500)))
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '旧标题' })

    const { seed } = await drafts.consume('t1', read)

    expect(read).toHaveBeenCalledWith('card_1')
    // The title and the body are the ones the card has now, not the ones it had
    // when the draft was opened.
    expect(seed).toEqual([
      {
        kind: 'knowledge',
        id: 'card_1',
        title: '标题 card_1',
        text: 'x'.repeat(MAX_CARD_CONTEXT),
        at: 1_700_000_000_000
      }
    ])
  })

  it('drops the seed when the reader removed the card while it was being read', async () => {
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '标题 card_1' })
    const read = vi.fn(async () => {
      drafts.drop('t1')
      return card('card_1')
    })

    const { seed } = await drafts.consume('t1', read)

    expect(seed).toEqual([])
    // The removed association stays removed.
    expect(drafts.get('t1')).toBeUndefined()
  })

  it('drops the seed when another card was opened in the same draft', async () => {
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '标题 card_1' })
    const read = vi.fn(async () => {
      drafts.hold('t1', { id: 'card_2', title: '标题 card_2' })
      return card('card_1')
    })

    const { seed } = await drafts.consume('t1', read)

    expect(seed).toEqual([])
    expect(drafts.get('t1')).toEqual({ id: 'card_2', title: '标题 card_2' })
  })

  it('spends the card only when the turn really starts', async () => {
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '标题 card_1' })

    const { seed, started } = await drafts.consume('t1', async () => card('card_1'))

    expect(seed).toHaveLength(1)
    // A question refused before the turn starts (no model configured, a failed
    // check) keeps the card.
    expect(drafts.get('t1')).toEqual({ id: 'card_1', title: '标题 card_1' })
    started()
    expect(drafts.get('t1')).toBeUndefined()
  })

  it('leaves a newer association alone when an older send starts', async () => {
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '标题 card_1' })
    const first = await drafts.consume('t1', async () => card('card_1'))
    drafts.drop('t1')
    drafts.hold('t1', { id: 'card_2', title: '标题 card_2' })

    first.started()

    expect(drafts.get('t1')).toEqual({ id: 'card_2', title: '标题 card_2' })
  })

  it('reports the helper reason when the card is gone', async () => {
    const drafts = new DraftCards()
    drafts.hold('t1', { id: 'card_1', title: '标题 card_1' })

    await expect(drafts.consume('t1', async () => { throw new Error('unknown card: card_1') })).rejects.toThrow(
      'unknown card: card_1'
    )
    // The association survives a failed read: the reader can still see it and
    // remove it, and the question was never sent.
    expect(drafts.get('t1')).toEqual({ id: 'card_1', title: '标题 card_1' })
  })

  it('takes a card that is handed in without asking the library', async () => {
    const read = vi.fn(async () => card('card_1'))

    const seed = await draftSeed(read, { id: 'card_1', title: '标题 card_1' })

    expect(read).toHaveBeenCalledOnce()
    expect(seed[0]).toMatchObject({ kind: 'knowledge', id: 'card_1' })
  })
})
