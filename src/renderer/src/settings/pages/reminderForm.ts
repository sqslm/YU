import type { Reminder, ReminderDraft, ReminderInput, TodoPriority, ReminderRecurrence } from '@shared/reminders'
import { localDateTime, normalizePriority } from '@shared/reminders'

export interface Form { kind: 'reminder' | 'todo'; title: string; description: string; timeExpression: string; date: string; level: 'normal' | 'strong'; repeat: 'none' | ReminderRecurrence['frequency']; weekday: number; weekdays: number[]; priority: TodoPriority; deadline: string; interval: number; count: string; until: string }
const limits = (rule?: ReminderRecurrence | null) => ({interval:rule?.interval??1,count:rule?.count?.toString()??'',until:rule?.until?localDateTime(rule.until).slice(0,10):''})
export const empty = (kind: Form['kind'] = 'reminder'): Form => ({ ...limits(), kind, title: '', description: '', timeExpression: '', date: '', level: 'normal', repeat: 'none', weekday: 1, weekdays: [], priority: 'normal', deadline: '' })
export const fromReminder = (row: Reminder): Form => ({ ...limits(row.recurrence), kind: row.dueAt === null ? 'todo' : 'reminder', title: row.title, description: row.description ?? '', timeExpression: row.timeExpression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.recurrence?.frequency ?? 'none', weekday: row.recurrence?.weekdays?.[0] ?? 1, weekdays: row.recurrence?.weekdays ?? [], priority: normalizePriority(row.priority), deadline: localDateTime(row.deadlineAt ?? null) })
export const fromDraft = (row: ReminderDraft): Form => ({ ...limits(row.rule), kind: row.dueAt === null ? 'todo' : 'reminder', title: row.title, description: row.description ?? '', timeExpression: row.time_expression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.dueAt === null ? 'none' : row.rule?.frequency ?? row.recurrence ?? 'none', weekday: row.rule?.weekdays?.[0] ?? -1, weekdays: row.rule?.weekdays ?? [], priority: 'normal', deadline: '' })

export function input(form: Form, source: ReminderInput['source'], noteId?: string, original?: Reminder): ReminderInput {
  const sameDate = original && form.date === localDateTime(original.dueAt)
  const dueAt = form.kind === 'todo' ? null : sameDate ? original.dueAt : form.date ? new Date(form.date).getTime() : null
  if (form.kind === 'reminder' && dueAt === null) throw new Error('请选择提醒时间')
  if (!form.title.trim()) throw new Error('请输入提醒事项')
  if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt <= Date.now() && !(sameDate && original.status !== 'pending'))) throw new Error('请选择将来的提醒时间')
  if (form.repeat !== 'none' && dueAt === null) throw new Error('重复提醒需要具体时刻')
  if (form.repeat === 'weekly' && form.weekday < 0) throw new Error('请选择每周的星期')
  // An empty box means "no deadline", which the store spells `null`; a filled one
  // may legitimately be in the past (an overdue task being edited), so only the
  // parse is validated here.
  const deadlineAt = form.deadline ? new Date(form.deadline).getTime() : null
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) throw new Error('截止时间格式不正确')
  const date = new Date(dueAt ?? Date.now())
  const previous = original && fromReminder(original)
  // A snoozed occurrence has a different clock from its series. Metadata edits
  // must retain the stored rule, including anchors and exact end timestamps.
  const sameRule = sameDate && previous && form.repeat === previous.repeat && form.weekday === previous.weekday
    && form.weekdays.join(',') === previous.weekdays.join(',') && form.interval === previous.interval
    && form.count === previous.count && form.until === previous.until
  return { title: form.title, description: form.description, timeExpression: form.timeExpression || undefined, dueAt, level: form.kind === 'todo' ? 'normal' : form.level, source, noteId,
    priority: form.priority, deadlineAt,
    recurrence: form.repeat === 'none' ? null : sameRule ? original.recurrence : { frequency: form.repeat, hour: date.getHours(), minute: date.getMinutes(),
      ...(sameDate && original.recurrence?.anchor ? {anchor:original.recurrence.anchor}:{}),
      ...(form.repeat === 'weekly' ? { weekdays: form.weekdays.includes(form.weekday) ? form.weekdays : [form.weekday] } : {}),
      ...(['monthly','yearly'].includes(form.repeat)?{day:sameDate?original.recurrence?.day??date.getDate():date.getDate()}:{}),
      ...(form.repeat==='yearly'?{month:date.getMonth()+1}:{}),
      ...(form.interval!==1?{interval:form.interval}:{}),...(form.count?{count:Number(form.count)}:{}),
      ...(form.until?{until:new Date(`${form.until}T23:59:59.999`).getTime()}:{}) } }
}
