import type { TypelessApi } from '@shared/api'
import { rangeFor, type CalendarEvent } from '@shared/calendar'
import { effectiveDeadline, isOverdue, sortTodos, type Reminder } from '@shared/reminders'
import type { Briefing } from '@shared/briefing'
import type { HistoryEntry, NoteEntry } from '@shared/types'
import type { StatsFile } from '@shared/stats'
import type { Workflow } from '@shared/workflow'
import { statusOf } from './historyView'

export interface HomeData {
  events: CalendarEvent[]
  todos: Reminder[]
  briefing: Briefing
  notes: NoteEntry[]
  history: HistoryEntry[]
  workflows: Workflow[]
  stats: StatsFile
}

/** Keep successful reads even when another store is unavailable. Omitted keys retain the last good data. */
export async function loadHomeData(api: TypelessApi, now: number): Promise<{
  data: Partial<HomeData>
  errors: Array<{ section: keyof HomeData; message: string }>
}> {
  const { from, until } = rangeFor('today', now)
  const reads = {
    events: () => api.life.eventsBetween(from, until),
    todos: () => api.reminders.list(),
    briefing: () => api.life.briefing(),
    notes: () => api.notes.list().then(store => store.notes),
    history: () => api.history.list(),
    workflows: () => api.workflow.list(),
    stats: () => api.stats.get()
  }
  const keys = Object.keys(reads) as Array<keyof HomeData>
  const results = await Promise.allSettled(keys.map(async key => reads[key]()))
  const data: Partial<HomeData> = {}
  const errors: Array<{ section: keyof HomeData; message: string }> = []
  results.forEach((result, index) => {
    const section = keys[index]!
    if (result.status === 'fulfilled') Object.assign(data, { [section]: result.value })
    else errors.push({ section, message: String(result.reason instanceof Error ? result.reason.message : result.reason)
      .replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  })
  return { data, errors }
}

export function todayAgenda(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  const { from, until } = rangeFor('today', now)
  return events.filter(event => event.status === 'confirmed' && event.start < until && event.end > from)
    .sort((a, b) => Number(a.end <= now) - Number(b.end <= now) || Number(b.allDay) - Number(a.allDay) || a.start - b.start)
}

/** Overdue work stays visible ahead of routine high-priority tasks. */
export function openTodos(rows: readonly Reminder[], now: number): Reminder[] {
  return sortTodos(rows.filter(row => row.status === 'pending' || row.status === 'due'))
    .sort((a, b) => Number(isOverdue(b, now)) - Number(isOverdue(a, now)))
}

export function todoTime(row: Reminder, language: string): string | null {
  const at = effectiveDeadline(row)
  return at === null ? null : new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(at)
}

export type Activity = { id: string; kind: 'note' | HistoryEntry['mode']; text: string; at: number; failed: boolean }

export function recentActivity(history: readonly HistoryEntry[], notes: readonly NoteEntry[]): Activity[] {
  return [
    ...history.filter(row => statusOf(row) !== 'archived').map(row => ({
      id: row.id, kind: row.mode, text: row.final.trim() || row.transcript.trim() || row.error || '',
      at: row.createdAt, failed: statusOf(row) === 'error'
    })),
    ...notes.map(row => ({ id: row.id, kind: 'note' as const,
      text: row.title?.trim() || row.polished.trim() || row.transcript.trim(), at: row.updatedAt, failed: false }))
  ].filter(row => row.text).sort((a, b) => b.at - a.at).slice(0, 4)
}
