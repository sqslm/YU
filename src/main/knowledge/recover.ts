/**
 * Reads a source's body back out of the store it came from.
 *
 * A pending task is only worth retrying while the original content is still
 * there. The queue keeps a reference (channel + origin ref) and a fingerprint;
 * this module turns that reference into current text by reading the same
 * `NotesStore` / `ChatStore` the live hooks read, and nothing else. It never
 * re-fetches a page, never re-opens a file and never asks the renderer for text,
 * so a deleted note or a thread that became temporary is reported truthfully
 * instead of resurrecting stale content.
 */

import { noteBody } from './collector'
import type { NoteProjection } from './collector'

/** Which store an origin ref points at. */
export type SourceChannel = 'note' | 'chat' | 'reading'

/** Either the current body, or why it cannot be produced any more. */
export type RecoveryBody =
  | { text: string }
  | { missing: 'deleted' | 'temporary' | 'empty' | 'unknown' }

/** The slice of a thread this module reads. */
export interface ChatThreadView {
  memoryTemporary?: boolean
  messages: { id: string; role: string; text: string; state: string }[]
}

export interface RecoveryDeps {
  notes: () => { list(): { notes: NoteProjection[] } }
  chats: () => {
    /**
     * `messageId` anchors the read at that message instead of the newest ones,
     * so a source bound to an old turn is still found in a long thread. The real
     * store throws when the thread or that message is gone.
     */
    get(id: string, limit?: number, messageId?: string): ChatThreadView | undefined
  }
}

/**
 * Messages read around the anchored question. A question is followed by its
 * answer and possibly a tool record, so a small window is enough and the read
 * stays bounded no matter how long the thread grew.
 */
const CHAT_MESSAGE_WINDOW = 8

/** `${threadId}:${userId}:${answerId}` — ids never contain a colon. */
export function chatReference(threadId: string, userId: string, answerId: string): string {
  return `${threadId}:${userId}:${answerId}`
}

function splitChatReference(originRef: string): { threadId: string; userId: string; answerId: string } | null {
  const first = originRef.indexOf(':')
  const last = originRef.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  return {
    threadId: originRef.slice(0, first),
    userId: originRef.slice(first + 1, last),
    answerId: originRef.slice(last + 1)
  }
}

/**
 * The production recovery entry: give it a channel and an origin ref and it
 * answers with the body those stores hold right now.
 */
export function createSourceRecovery(
  deps: RecoveryDeps
): (channel: SourceChannel, originRef: string) => RecoveryBody {
  return (channel, originRef) => {
    if (channel === 'note') {
      const note = deps
        .notes()
        .list()
        .notes.map(note => note)
        .find(item => item.id === originRef)
      if (!note) return { missing: 'deleted' }
      const text = noteBody(note)
      return text ? { text } : { missing: 'empty' }
    }
    if (channel === 'chat') {
      const parsed = splitChatReference(originRef)
      if (!parsed) return { missing: 'unknown' }
      // The store throws when the thread or the anchored message is gone, which is
      // exactly the "deleted" answer this function must give.
      let thread: ChatThreadView | undefined
      try {
        thread = deps.chats().get(parsed.threadId, CHAT_MESSAGE_WINDOW, parsed.userId)
      } catch {
        return { missing: 'deleted' }
      }
      if (!thread) return { missing: 'deleted' }
      if (thread.memoryTemporary) return { missing: 'temporary' }
      const question = thread.messages.find(message => message.id === parsed.userId)
      const answer = thread.messages.find(message => message.id === parsed.answerId)
      // The window is anchored at the question, so a missing question really is a
      // removed message — it is not "older than the newest hundred".
      if (!question || !answer) return { missing: 'deleted' }
      if (answer.state !== 'done') return { missing: 'unknown' }
      const questionText = question.text.trim()
      const answerText = answer.text.trim()
      if (!questionText || !answerText) return { missing: 'empty' }
      return { text: `${questionText}\n\n${answerText}` }
    }
    // Reading bodies never touch a store: they exist only while the same version
    // is still in the process, and the collector's stash owns that answer.
    return { missing: 'unknown' }
  }
}
