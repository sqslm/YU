import type { Reminder } from '@shared/reminders'
import { historyDateBounds, type HistoryPeriod } from './historyView'

export type ReminderKind = 'all' | 'reminder' | 'todo'
export type ReminderPeriod = Exclude<HistoryPeriod, 'month'> | 'nextWeek'
export function reminderDateBounds(period: ReminderPeriod, from = '', to = '', now = Date.now()): ReturnType<typeof historyDateBounds> {
  if (period !== 'nextWeek') return historyDateBounds(period, from, to, now)
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 7)
  return { start: start.getTime(), end: end.getTime() }
}
/** Reminders use their scheduled time; undated todos use their creation date. */
export function reminderView(rows: readonly Reminder[], options: { status: string; kind: ReminderKind; query: string; bounds: { start: number; end: number; error?: string } }): Reminder[] {
  const { status, kind, bounds } = options, query = options.query.trim().toLowerCase()
  if (bounds.error) return []
  return rows.filter(row => {
    const todo = row.dueAt === null, stamp = row.dueAt ?? row.createdAt
    return (kind === 'all' || (kind === 'todo') === todo) &&
      (status === 'all' || status === 'active' && ['pending', 'due'].includes(row.status) || status === 'upcoming' && row.status === 'pending' && !todo || row.status === status) &&
      stamp >= bounds.start && stamp < bounds.end && `${row.title}\n${row.description ?? ''}`.toLowerCase().includes(query)
  })
}
