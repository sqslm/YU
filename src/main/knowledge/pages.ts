/**
 * The bounded, read-only projections the history scan walks.
 *
 * The renderer never supplies bodies — these readers are the only source of
 * "old content". Two rules keep a scan honest while the user keeps working:
 *
 * 1. The set is fixed when the job starts. The note reader is bounded by the
 *    highest note id and the chat reader by the highest message sequence that
 *    existed at `history.begin`; anything newer takes the live path instead.
 * 2. The order is stable and independent of mutable fields. Notes are ordered by
 *    their id (never by `updatedAt`, which every edit moves), and turns by the
 *    message sequence the chat store already keeps (never by an index into a
 *    sliding window of the newest 10 000 messages).
 *
 * Each page is also capped by bytes, not only by row count: twenty legal notes of
 * 200 000 characters would otherwise build a batch the helper has to refuse.
 */

import type { PublishInput } from '@shared/knowledge'
import type { HistoryPage, HistoryPages } from './history'
import type { HistoryTurn } from '../chat-store'
import { noteBody, noteProjection } from './collector'
import type { NoteProjection } from './collector'

/** The note fields the scan reads; a real `NotesStore` satisfies this. */
export interface NoteSource {
  list(): { notes: NoteProjection[] }
}

/** The chat fields the scan reads; a real `ChatStore` satisfies this. */
export interface ChatSource {
  historyThreads(): string[]
  historyTurns(
    threadId: string,
    afterSeq: number,
    bound: number,
    limit: number
  ): { turns: HistoryTurn[]; nextSeq: number; done: boolean }
  get(id: string): { title?: string }
}

/**
 * Bytes a single batch may carry. The helper's frame limit is 2 MiB and the batch
 * is wrapped in one request, so half of it is a comfortable ceiling; a row that
 * alone exceeds the budget still goes out on its own, because the body limit
 * (200 000 characters) keeps a single row well below the frame.
 */
export const HISTORY_BATCH_BYTES = 512 * 1024

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** Where a scan starts and where it may not look past. */
export interface HistoryBounds {
  noteBound: string | null
  chatBound: number | null
}

export function createHistoryPages(deps: {
  notes: () => NoteSource
  chats: () => ChatSource
  limit?: number
}): HistoryPages {
  const limit = deps.limit ?? 20
  return {
    notes(after, bound) {
      const rows = deps
        .notes()
        .list()
        .notes.map(noteProjection)
        .filter(note => note.polishStatus !== 'pending')
        .filter(note => noteBody(note) !== '')
        .filter(note => !bound || note.id <= bound)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const rest = after ? rows.filter(note => note.id > after) : rows
      const page: NoteProjection[] = []
      let budget = 0
      for (const note of rest) {
        if (page.length >= limit) break
        const text = noteBody(note)
        if (page.length > 0 && budget + bytes(text) > HISTORY_BATCH_BYTES) break
        page.push(note)
        budget += bytes(text)
      }
      return {
        rows: page.map(note => ({
          channel: 'note' as const,
          kind: 'note' as const,
          originRef: note.id,
          groupKey: note.id,
          title: note.title ?? noteBody(note).slice(0, 40),
          scope: '笔记',
          text: noteBody(note),
          at: note.updatedAt
        })),
        cursor: page.length ? page[page.length - 1]!.id : after,
        done: rest.length <= page.length
      }
    },

    chat(after, bound) {
      const boundSeq = bound ?? null
      if (boundSeq === null) return { rows: [], cursor: after, done: true }
      const [afterThread, afterSeq] = splitCursor(after)
      const threads = deps.chats().historyThreads()
      const rows: PublishInput[] = []
      let budget = 0
      let cursor = after
      for (const threadId of threads) {
        if (afterThread && threadId < afterThread) continue
        const start = afterThread === threadId ? afterSeq : 0
        let position = start
        for (;;) {
          const page = deps.chats().historyTurns(threadId, position, boundSeq, limit)
          for (const turn of page.turns) {
            const text = `${turn.question}\n\n${turn.answer}`
            if (rows.length > 0 && budget + bytes(text) > HISTORY_BATCH_BYTES) {
              return { rows, cursor, done: false }
            }
            rows.push({
              channel: 'chat',
              kind: 'chat',
              originRef: `${threadId}:${turn.userId}:${turn.answerId}`,
              groupKey: threadId,
              threadKey: threadId,
              title: deps.chats().get(threadId).title || turn.question.slice(0, 40),
              scope: '主界面问答',
              text,
              at: turn.at
            })
            budget += bytes(text)
            position = turn.seq
            cursor = `${threadId}:${position}`
            if (rows.length >= limit) return { rows, cursor, done: false }
          }
          if (page.done) break
          position = page.nextSeq
        }
        // Keep the sequence, never a bare thread id: a bare id would be read back
        // as "sequence 0 of that thread" and restart it from the beginning.
        cursor = `${threadId}:${position}`
      }
      return { rows, cursor, done: true }
    }
  }
}

function splitCursor(cursor: string | null): [string | null, number] {
  if (!cursor) return [null, 0]
  const at = cursor.lastIndexOf(':')
  if (at < 0) return [cursor, 0]
  const seq = Number(cursor.slice(at + 1))
  return [cursor.slice(0, at), Number.isInteger(seq) && seq >= 0 ? seq : 0]
}

export type { HistoryPage, HistoryPages }
