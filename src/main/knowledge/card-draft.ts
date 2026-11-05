import type { LocalRecord } from '@shared/workspace'

/** Characters of a card body handed to a continued discussion. */
export const MAX_CARD_CONTEXT = 2000

/**
 * The card a draft was opened from. Only the identity and the title are kept:
 * the body is read again on the send that actually uses it, so a card edited in
 * the meantime is quoted as it is now and a deleted one is reported as deleted.
 */
export interface DraftCard {
  id: string
  title: string
}

export type DraftCardRead = (cardId: string) => Promise<{ id: string; title: string; body: string; updatedAt: number }>

/**
 * The reference the first real question carries. An unreadable card throws the
 * helper's own reason: a draft whose card is gone must not be sent with a body
 * nobody can check any more — the caller keeps the input and the association.
 */
export async function draftSeed(read: DraftCardRead, pending: DraftCard | undefined): Promise<LocalRecord[]> {
  if (!pending) return []
  const card = await read(pending.id)
  return [{ kind: 'knowledge', id: card.id, title: card.title, text: card.body.slice(0, MAX_CARD_CONTEXT), at: card.updatedAt }]
}
