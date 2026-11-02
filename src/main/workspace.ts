import type { LocalRecord, WorkspaceSearchPage } from '@shared/workspace'
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
    const detail = sources.chat.get(input.threadId, 2, input.id), message = detail.messages.find(row => row.id === input.id)
    if (message) row = { kind: 'chat', id: message.id, threadId: detail.id, title: detail.title, text: message.text, at: message.createdAt }
  }
  if (!row) throw new Error('原记录已不存在，请刷新后重试')
  return row
}

/** Literal substring matching includes short Chinese terms and SQL wildcard characters. */
export function searchWorkspace(sources: WorkspaceSources, query: string, offset = 0): WorkspaceSearchPage {
  if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('无效的搜索请求')
  const needle = query.trim().toLowerCase()
  if (!needle) return { items: [], hasMore: false }
  const take = offset + 31, rows: LocalRecord[] = []
  const matches = (...values: string[]) => values.join('\n').toLowerCase().includes(needle)
  for (const note of sources.notes()) {
    if (matches(note.title || '', note.transcript, note.polished, note.tags.join(' '))) rows.push({ kind: 'note', id: note.id, title: note.title || note.transcript.slice(0, 80), text: [note.transcript, note.polished].filter(Boolean).join('\n'), at: note.updatedAt })
  }
  for (const entry of sources.history.list(query.trim(), take)) rows.push({ kind: 'history', id: entry.id, title: entry.app || entry.mode, text: [entry.final, entry.transcript].filter(Boolean).join('\n'), at: entry.createdAt })
  rows.push(...sources.chat.search(needle, take))
  for (const item of sources.reminders()) if (matches(item.title, item.description || '')) rows.push({ kind: 'reminder', id: item.id, title: item.title, text: item.description || '', at: item.updatedAt })
  for (const item of sources.events()) if (matches(item.title, item.notes || '', item.location || '')) rows.push({ kind: 'event', id: item.id, title: item.title, text: [item.notes, item.location].filter(Boolean).join('\n'), at: item.start })
  rows.sort((a, b) => b.at - a.at || a.kind.localeCompare(b.kind))
  return { hasMore: rows.length > offset + 30, items: rows.slice(offset, offset + 30).map(row => {
    const at = row.text.toLowerCase().indexOf(needle), start = Math.max(0, at - 50)
    return { ...row, text: (start ? '…' : '') + row.text.slice(start, start + 180) + (row.text.length > start + 180 ? '…' : '') }
  }) }
}
