import type { CalendarEvent, CalendarEventInput } from '@shared/calendar'
import { dayKeyOf, dayStart, shiftDayKey } from './calendarView'
import i18n from '../../i18n'

const DAY_MS = 24 * 60 * 60_000

export interface CalendarForm {
  title: string
  /** `YYYY-MM-DD`, the shape `<input type="date">` speaks. */
  date: string
  endDate: string
  /** `HH:MM`; ignored while `allDay` is on, kept so toggling back restores it. */
  start: string
  end: string
  allDay: boolean
  location: string
  notes: string
  /** `'default'`, `'none'`, or a number of minutes as a string. */
  lead: string
  /** Preserved on edit: editing an imported event must not orphan its ICS UID. */
  source: CalendarEventInput['source']
}

const pad = (value: number): string => String(value).padStart(2, '0')

const clockOf = (at: number): string => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Local epoch for a day key plus a `HH:MM` clock; the two halves the form edits. */
function stampOf(dayKey: string, clock: string): number {
  const day = dayStart(dayKey)
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock)
  if (day === null || !match) return Number.NaN
  const date = new Date(day)
  date.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return date.getTime()
}

export function emptyForm(dayKey: string, referenceTime = Date.now()): CalendarForm {
  const now = new Date(referenceTime)
  // Next hour on today, 09:00 elsewhere: a slot the user probably means, not midnight.
  const start = dayKey === dayKeyOf(now.getTime()) ? Math.min(23, now.getHours() + 1) : 9
  const end = new Date(stampOf(dayKey, `${pad(start)}:00`))
  end.setHours(end.getHours() + 1)
  return {
    title: '',
    date: dayKey,
    endDate: dayKeyOf(end.getTime()),
    start: `${pad(start)}:00`,
    end: clockOf(end.getTime()),
    allDay: false,
    location: '',
    notes: '',
    lead: 'none',
    source: 'manual'
  }
}

export function formOf(row: CalendarEvent): CalendarForm {
  return {
    title: row.title,
    date: dayKeyOf(row.start),
    endDate: dayKeyOf(row.end),
    start: clockOf(row.start),
    end: clockOf(row.end),
    allDay: row.allDay,
    location: row.location ?? '',
    notes: row.notes ?? '',
    lead: row.leadMinutes === undefined ? 'default' : row.leadMinutes === null ? 'none' : String(row.leadMinutes),
    source: row.source
  }
}

/** Moving the start date keeps the end on the same relative calendar day. */
export function withStartDate(form: CalendarForm, date: string): CalendarForm {
  const before = dayStart(form.date), after = dayStart(date)
  const endDate = before === null || after === null ? form.endDate
    : shiftDayKey(form.endDate, Math.round((after - before) / DAY_MS))
  return { ...form, date, endDate }
}

/** Form → IPC payload. Throws the message the dialog shows verbatim. */
export function toInput(form: CalendarForm): CalendarEventInput {
  const title = form.title.trim()
  if (!title) throw new Error(i18n.t('请填写日程标题'))
  const day = dayStart(form.date)
  if (day === null) throw new Error(i18n.t('请选择日期'))
  const leadMinutes = form.lead === 'default' ? undefined : form.lead === 'none' ? null : Number(form.lead)
  const details = {
    title,
    ...(form.location.trim() ? { location: form.location.trim() } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    leadMinutes,
    source: form.source
  }
  if (form.allDay) {
    // An all-day event is exactly one local day; the store normalises it the same way.
    return { ...details, start: day, end: day + DAY_MS, allDay: true }
  }
  const start = stampOf(form.date, form.start)
  const end = stampOf(form.endDate, form.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(i18n.t('请填写开始和结束日期及时间'))
  if (end <= start) throw new Error(i18n.t('结束时间要晚于开始时间'))
  return {
    ...details,
    start,
    end,
    allDay: false
  }
}
