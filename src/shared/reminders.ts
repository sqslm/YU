export type ReminderLevel = 'normal' | 'strong'
export type ReminderStatus = 'pending' | 'due' | 'completed' | 'cancelled'
export interface ReminderRecurrence {
  frequency: 'daily' | 'weekly'
  hour: number
  minute: number
  /** Sunday = 0, matching the local calendar. */
  weekdays?: number[]
}
export interface ReminderInput {
  title: string
  description?: string
  dueAt: number | null
  level: ReminderLevel
  recurrence: ReminderRecurrence | null
  source: 'manual' | 'voice' | 'note'
  noteId?: string
  timeExpression?: string
}
export interface Reminder extends ReminderInput {
  id: string
  createdAt: number
  updatedAt: number
  status: ReminderStatus
  deliveredAt: number | null
  /** An explicit elapsed-time snooze must survive local timezone rebasing. */
  snoozedUntil?: number
  lastCompletedAt?: number
}
export interface ReminderDraft {
  intent: 'create_reminder' | 'todo' | 'possible' | 'none'
  title: string
  description?: string
  time_expression: string | null
  level: ReminderLevel
  recurrence: 'daily' | 'weekly' | null
  needs_confirmation: boolean
  dueAt: number | null
  rule: ReminderRecurrence | null
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
