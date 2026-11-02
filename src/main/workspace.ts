import type { LocalRecord } from '@shared/workspace'
import type { NoteEntry } from '@shared/types'
import type { Reminder } from '@shared/reminders'
import type { CalendarEvent } from '@shared/calendar'
import type { HistoryStore } from './history'
import type { ChatStore } from './chat-store'

export interface WorkspaceSources {
  notes(): NoteEntry[]
  history: Pick<HistoryStore, 'get' | 'list'>
  chat: ChatStore
  reminders(): Reminder[]
  events(): CalendarEvent[]
}

export function readWorkspaceRecord(sources: WorkspaceSources, input: LocalRecord): LocalRecord {
  let row: LocalRecord | undefined
  if (input?.kind === 'note') {
    const note = sources.notes().find(row => row.id === input.id)
    if (note) row = { kind: 'note', id: note.id, title: note.title || note.transcript.slice(0, 80), text: note.polished || note.transcript, at: note.createdAt }
  } else if (input?.kind === 'history') {
    const entry = sources.history.get(input.id)
    if (entry) row = { kind: 'history', id: entry.id, title: entry.app || entry.mode, text: entry.final || entry.transcript, at: entry.createdAt }
  } else if (input?.kind === 'reminder') {
    const reminder = sources.reminders().find(row => row.id === input.id)
    if (reminder) row = { kind: 'reminder', id: reminder.id, title: reminder.title, text: reminder.description || '', at: reminder.dueAt ?? reminder.createdAt }
  } else if (input?.kind === 'event') {
    const event = sources.events().find(row => row.id === input.id)
    if (event) row = { kind: 'event', id: event.id, title: event.title, text: event.notes || '', at: event.start }
  } else if (input?.kind === 'chat' && input.threadId) {
    const detail = sources.chat.get(input.threadId, 10000), message = detail.messages.find(row => row.id === input.id)
    if (message) row = { kind: 'chat', id: message.id, threadId: detail.id, title: detail.title, text: message.text, at: message.createdAt }
  }
  if (!row) throw new Error('原记录已不存在，请刷新后重试')
  return row
}
