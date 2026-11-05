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

/**
 * The cards drafts were opened from, one per thread.
 *
 * Reading the card takes a moment, and the association can change while it runs:
 * the reader may remove it, or open another card in the same empty conversation.
 * A seed is therefore consumed against the association the send started with, and
 * only that exact association is used — never one that was removed or replaced in
 * between. Nothing here outlives the process: a card belongs to a draft of this
 * session, not to the conversation's stored history.
 */
export class DraftCards {
  private readonly held = new Map<string, DraftCard>()

  get(threadId: string): DraftCard | undefined {
    return this.held.get(threadId)
  }

  hold(threadId: string, card: DraftCard): void {
    this.held.set(threadId, card)
  }

  /** Forgets the association, on the reader's request or with the thread itself. */
  drop(threadId: string): void {
    this.held.delete(threadId)
  }

  /**
   * The seed for one send, plus the hook that consumes it. A card that was
   * removed or replaced while it was being read yields no seed — the question is
   * still sent, just without a reference the reader no longer sees.
   */
  async consume(threadId: string, read: DraftCardRead): Promise<{ seed: LocalRecord[]; started: () => void }> {
    const pending = this.held.get(threadId)
    const seed = await draftSeed(read, pending)
    const current = this.held.get(threadId)
    const live = current === pending
    return {
      seed: live ? seed : [],
      // The turn really beginning is what spends the draft; a question refused
      // before that (no model configured, a failed check) keeps its card.
      started: () => {
        if (this.held.get(threadId) === pending) this.held.delete(threadId)
      }
    }
  }
}
