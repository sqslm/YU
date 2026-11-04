/**
 * The bounded, read-only projections the history scan walks.
 *
 * The renderer never supplies bodies — these readers are the only source of
 * "old content", and each page is bounded by `limit` so a large library is never
 * moved in one step. Both readers are cursor-based on values that survive
 * concurrent edits: a note is keyed by `updatedAt:id`, a chat turn by
 * `threadId:messageIndex`, so an insert or a delete during a scan can neither
 * skip a row nor repeat one.
 */

import type { PublishInput } from '@shared/knowledge'
import type { HistoryPage, HistoryPages } from './history'
import type { ChatDetail, ChatIndex } from '@shared/chat'
import { noteBody, noteProjection } from './collector'
import type { NoteProjection } from './collector'

/** The note fields the scan reads; a real `NotesStore` satisfies this. */
export interface NoteSource {
  list(): { notes: NoteProjection[] }
}

/** The chat fields the scan reads; a real `ChatStore` satisfies this. */
export interface ChatSource {
  list(): { threads: ChatIndex['threads'] }
  get(id: string, limit?: number): ChatDetail
}

const noteKey = (note: NoteProjection): string => `${note.updatedAt}:${note.id}`

export function createHistoryPages(deps: { notes: () => NoteSource; chats: () => ChatSource }): HistoryPages {
  return {
    notes(after, limit) {
      const rows = deps
        .notes()
        .list()
        .notes.map(noteProjection)
        .filter(note => note.polishStatus !== 'pending' && noteBody(note) !== '')
        .sort((left, right) => left.updatedAt - right.updatedAt || (left.id < right.id ? -1 : 1))
      const rest = after ? rows.filter(note => noteKey(note) > after) : rows
      const page = rest.slice(0, limit)
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
        cursor: page.length ? noteKey(page[page.length - 1]!) : after,
        done: rest.length <= limit
      }
    },

    chat(after, limit) {
      const [afterThread, afterIndex] = splitCursor(after)
      const threads = deps
        .chats()
        .list()
        .threads.filter(thread => !thread.memoryTemporary)
        .sort((left, right) => (left.id < right.id ? -1 : 1))
      const rows: PublishInput[] = []
      let cursor = after
      for (const thread of threads) {
        if (afterThread && thread.id < afterThread) continue
        if (afterThread && thread.id === afterThread && afterIndex === null) continue
        const start = afterThread === thread.id && afterIndex !== null ? afterIndex : 0
        const detail = deps.chats().get(thread.id, 10_000)
        for (let index = start; index + 1 < detail.messages.length; index += 1) {
          const question = detail.messages[index]!, answer = detail.messages[index + 1]!
          if (question.role !== 'user' || answer.role !== 'assistant') continue
          if (answer.state !== 'done' || !question.text.trim() || !answer.text.trim()) continue
          rows.push({
            channel: 'chat',
            kind: 'chat',
            originRef: `${thread.id}:${question.id}:${answer.id}`,
            groupKey: thread.id,
            threadKey: thread.id,
            title: thread.title || question.text.slice(0, 40),
            scope: '主界面问答',
            text: `${question.text.trim()}\n\n${answer.text.trim()}`,
            at: answer.createdAt
          })
          // A full page always names the exact message it stopped on, so the next
          // call resumes inside this thread instead of skipping its later turns.
          if (rows.length >= limit) return { rows, cursor: `${thread.id}:${index + 1}`, done: false }
        }
        cursor = thread.id
      }
      // The last page keeps what it collected: an unterminated page is not empty.
      return { rows, cursor, done: true }
    }
  }
}

function splitCursor(cursor: string | null): [string | null, number | null] {
  if (!cursor) return [null, null]
  const at = cursor.lastIndexOf(':')
  if (at < 0) return [cursor, null]
  const index = Number(cursor.slice(at + 1))
  return [cursor.slice(0, at), Number.isInteger(index) && index >= 0 ? index : 0]
}

export type { HistoryPage, HistoryPages }
