import type { Reminder, TodoPriority } from '@shared/reminders'
import { normalizePriority, sortTodos } from '@shared/reminders'
import { historyDateBounds, type HistoryPeriod } from './historyView'

export type ReminderKind = 'all' | 'reminder' | 'todo'
export type ReminderPeriod = Exclude<HistoryPeriod, 'month'> | 'nextWeek'
/** `'all'` is the empty option of the 优先级 box, not a priority of its own. */
export type ReminderPriorityFilter = TodoPriority | 'all'

export interface ReminderViewOptions {
  status: string
  kind: ReminderKind
  query: string
  bounds: { start: number; end: number; error?: string }
  /** Omitted or `'all'` keeps every row, so callers that never set it stay valid. */
  priority?: ReminderPriorityFilter
}

export function reminderDateBounds(period: ReminderPeriod, from = '', to = '', now = Date.now()): ReturnType<typeof historyDateBounds> {
  if (period !== 'nextWeek') return historyDateBounds(period, from, to, now)
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 7)
  return { start: start.getTime(), end: end.getTime() }
}

/**
 * Filters, then hands the survivors to `sortTodos`.
 *
 * The sort is not re-implemented here on purpose: the main process already keeps
 * the store in `sortTodos` order, and a second ordering rule is how "the list the
 * assistant reads" and "the list the user sees" drift apart.
 */
export function reminderView(rows: readonly Reminder[], options: ReminderViewOptions): Reminder[] {
  const { status, kind, bounds, priority = 'all' } = options, query = options.query.trim().toLowerCase()
  if (bounds.error) return []
  return sortTodos(rows.filter(row => {
    const todo = row.dueAt === null, stamp = row.dueAt ?? row.deadlineAt ?? row.createdAt
    return (kind === 'all' || (kind === 'todo') === todo) &&
      (priority === 'all' || normalizePriority(row.priority) === priority) &&
      (status === 'all' || status === 'active' && ['pending', 'due'].includes(row.status) || status === 'upcoming' && row.status === 'pending' && !todo || status === row.status) &&
      stamp >= bounds.start && stamp < bounds.end && `${row.title}\n${row.description ?? ''}`.toLowerCase().includes(query)
  }))
}

/**
 * The body of the `截止 …` line: `10 月 27 日 17:00` / `Oct 27, 17:00`.
 *
 * Composed by hand rather than via `toLocaleString`, which renders
 * `2026/10/27 17:00` in zh-CN: a deadline is at most weeks away, so the year is
 * noise, and the line already reads as a deadline through its label.
 */
export function formatDeadline(at: number, language: 'zh' | 'en'): string {
  const date = new Date(at)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (language === 'en') return `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date)} ${time}`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}
