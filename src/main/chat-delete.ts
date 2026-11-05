import { mt } from '@shared/mainI18n'

import type { ChatEdit } from '@shared/chat'
import type { CleanupPending, FindSourceInput, SourceIdentity } from '@shared/knowledge'

/** The one delete shape: everything else on `chat:edit` returns before this. */
export type ChatDelete = Extract<ChatEdit, { action: 'delete' }>

/** What one thread's deletion needs, as the app wires it. */
export interface ChatDeleteDeps {
  /** Writes the deletion itself. */
  edit: (input: ChatEdit) => void | Promise<void>
  /**
   * Drops what only a draft of this thread held — its card. Called once the
   * deletion is written, never before: a refused preview or a failed write leaves
   * the conversation alive, and a card that outlives its thread must not be sent.
   */
  dropCard?: () => void
  /** Proves the ticked preview still holds, while the thread still exists. */
  verify: (identity: SourceIdentity, ticket?: string) => Promise<void>
  /** One owner for the record write and its settlement. */
  settle: <T>(id: string, body: () => Promise<T>) => Promise<T>
  purge: (input: FindSourceInput, identity: SourceIdentity, options: { cards: boolean; ticket?: string }) => Promise<void>
  /** Remembers the failed cleanup and returns the handle the page can act on. */
  pending: (input: FindSourceInput, detail: { reason: string; ticket?: string }) => CleanupPending
}

/**
 * Deletes one thread and settles the knowledge it alone supported.
 *
 * The order is the promise the confirmation dialog makes: the preview is proved
 * first (a failure deletes nothing), then the thread is written away, and only
 * then is the knowledge settled. A ticked cleanup that fails afterwards is not
 * thrown at the page — the thread is already gone, so the user gets a retry they
 * can act on instead. The default path (cards kept) keeps its own wording and its
 * helper-driven recovery: nothing about it becomes a manual retry.
 */
export async function deleteThread(deps: ChatDeleteDeps, input: ChatDelete): Promise<CleanupPending | void> {
  const identity: SourceIdentity = { channel: 'chat', groupKey: input.id }
  if (input.deleteKnowledge) await deps.verify(identity, input.ticket)
  return await deps.settle(input.id, async () => {
    const written = await deps.edit(input)
    deps.dropCard?.()
    try {
      await deps.purge(identity, identity, { cards: Boolean(input.deleteKnowledge), ticket: input.ticket })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (input.deleteKnowledge) return deps.pending(identity, { reason, ticket: input.ticket })
      throw new Error(mt('对话已删除，但关联知识清理失败：{{reason}}', { reason }))
    }
    return written
  })
}
