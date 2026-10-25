export type ReminderLevel = 'normal' | 'strong'
export type ReminderStatus = 'pending' | 'due' | 'completed' | 'cancelled'
export type TodoPriority = 'low' | 'normal' | 'high'
export const TODO_PRIORITIES: readonly TodoPriority[] = ['low', 'normal', 'high']
export function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === 'string' && (TODO_PRIORITIES as readonly string[]).includes(value)
}
/** Old rows carry no priority; an unknown or missing value must never invalidate the whole task. */
export const normalizePriority = (value: unknown, fallback: TodoPriority = 'normal'): TodoPriority => isTodoPriority(value) ? value : fallback
export const PRIORITY_LABELS: Record<TodoPriority, string> = { low: '低', normal: '普通', high: '高' }
/** Lower ranks sort first: urgent work must not hide under routine work. */
export const priorityRank = (priority: TodoPriority): number => priority === 'high' ? 0 : priority === 'normal' ? 1 : 2
export interface ReminderRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  hour: number
  minute: number
  /** Sunday = 0, matching the local calendar. */
  weekdays?: number[]
  interval?: number
  day?: number
  month?: number
  anchor?: number
  count?: number
  until?: number
}
export interface ReminderInput {
  title: string
  description?: string
  dueAt: number | null
  /** When the task must be finished. dueAt only fires the alert, so the two can differ. */
  deadlineAt?: number | null
  /** Optional on the way in; the store always reads back a concrete value. */
  priority?: TodoPriority
  level: ReminderLevel
  recurrence: ReminderRecurrence | null
  source: 'manual' | 'voice' | 'note'
  noteId?: string
  timeExpression?: string
}
export interface Reminder extends ReminderInput {
  /** Completed occurrences, including the first; snoozing does not consume one. */
  occurrences?: number
  id: string
  createdAt: number
  updatedAt: number
  status: ReminderStatus
  deliveredAt: number | null
  priority: TodoPriority
  deadlineAt: number | null
  /** An explicit elapsed-time snooze must survive local timezone rebasing. */
  snoozedUntil?: number
  lastCompletedAt?: number
  /** The exact occurrence missed while the app was stopped or asleep. */
  missedAt?: number
  missedAcknowledgedAt?: number
}
export const isMissedReminder = (row: Reminder): boolean => row.status === 'due' && row.dueAt !== null && row.missedAt === row.dueAt && row.missedAcknowledgedAt === undefined
const openStatus = (status: ReminderStatus): boolean => status === 'pending' || status === 'due'
/**
 * The moment a task becomes overdue.
 *
 * A deadline wins over the alert time: "meeting at 15:00, slides by 18:00" is
 * overdue at 18:00, not when the meeting reminder popped. Rows saved before
 * deadlines existed only have dueAt, so they keep their old meaning.
 */
export const effectiveDeadline = (row: Pick<Reminder, 'deadlineAt' | 'dueAt'>): number | null => row.deadlineAt ?? row.dueAt ?? null
/** A finished or cancelled task is never overdue, even if its own time has passed. */
export function isOverdue(reminder: Reminder, now: number): boolean {
  if (!openStatus(reminder.status)) return false
  const at = effectiveDeadline(reminder)
  return at !== null && at < now
}
export function sortTodos(rows: readonly Reminder[]): Reminder[] {
  const byDeadline = (a: Reminder, b: Reminder): number => {
    const left = effectiveDeadline(a) ?? Infinity, right = effectiveDeadline(b) ?? Infinity
    return left === right ? 0 : left < right ? -1 : 1
  }
  // Copy: callers hand in store-owned arrays and must keep their own order.
  return [...rows].sort((a, b) => Number(!openStatus(a.status)) - Number(!openStatus(b.status)) ||
    priorityRank(normalizePriority(a.priority)) - priorityRank(normalizePriority(b.priority)) ||
    byDeadline(a, b) || a.createdAt - b.createdAt)
}
export interface ReminderDraft {
  intent: 'create_reminder' | 'todo' | 'possible' | 'none'
  title: string
  description?: string
  time_expression: string | null
  level: ReminderLevel
  recurrence: ReminderRecurrence['frequency'] | null
  needs_confirmation: boolean
  dueAt: number | null
  rule: ReminderRecurrence | null
  /**
   * The model never invents these two; the calling tool fills them in from the
   * user's own words. They live on the draft so the voice path can carry them
   * to `saveMany` instead of dropping them when a row is not stored yet.
   */
  priority?: TodoPriority
  deadlineAt?: number | null
  issue?: string
}
export interface ReminderView { id?: string; drafts?: ReminderDraft[]; noteId?: string }
export type ReminderAction = 'complete' | 'cancel' | 'snooze' | 'restore'

/** datetime-local uses local components; toISOString would shift the editor's clock. */
export function localDateTime(value: number | null): string {
  if (value === null) return ''
  const d = new Date(value), pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
