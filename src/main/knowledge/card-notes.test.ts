import { describe, expect, it, vi } from 'vitest'

import { cardNoteText, saveCardAsNote } from './card-notes'
import type { CardNoteDeps } from './card-notes'

const CARD = { id: 'card_1', title: '检索粒度', body: '检索先命中标题，再落到正文。' }

function deps(overrides: Partial<CardNoteDeps> = {}) {
  const order: string[] = []
  const base: CardNoteDeps = {
    read: vi.fn(async () => CARD),
    nextId: () => 'note_1',
    save: vi.fn(async () => { order.push('save'); return { id: 'note_1' } }),
    cite: vi.fn(() => { order.push('cite') }),
    forget: vi.fn(() => { order.push('forget') })
  }
  return { order, deps: { ...base, ...overrides } }
}

describe('saving a card as a note', () => {
  it('cites the card before the note is written, so the first source carries it', async () => {
    const { order, deps: d } = deps()

    await expect(saveCardAsNote(d, 'card_1')).resolves.toEqual({ noteId: 'note_1' })

    // The store announces the finished note on its own, so a citation registered
    // after the save would race that publication and lose.
    expect(order).toEqual(['cite', 'save'])
    expect(d.cite).toHaveBeenCalledWith('note_1', ['card_1'])
    expect(d.save).toHaveBeenCalledWith({ id: 'note_1', text: cardNoteText(CARD) })
    expect(d.forget).not.toHaveBeenCalled()
  })

  it('forgets the citation when the note could not be written', async () => {
    const { order, deps: d } = deps({ save: vi.fn(async () => { throw new Error('EACCES: permission denied') }) })

    await expect(saveCardAsNote(d, 'card_1')).rejects.toThrow('EACCES')

    // A note that was thrown away must not leave a citation behind: the id could
    // be reused, and nothing else may publish for it.
    expect(order).toEqual(['cite', 'forget'])
    expect(d.forget).toHaveBeenCalledWith('note_1')
  })

  it('saves nothing when the card cannot be read', async () => {
    const { deps: d } = deps({ read: vi.fn(async () => { throw new Error('unknown card: card_1') }) })

    await expect(saveCardAsNote(d, 'card_1')).rejects.toThrow('unknown card: card_1')

    expect(d.cite).not.toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
  })

  it('writes the card as its own note body', () => {
    expect(cardNoteText(CARD)).toBe('# 检索粒度\n\n检索先命中标题，再落到正文。\n')
  })
})
