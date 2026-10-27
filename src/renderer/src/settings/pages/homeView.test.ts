import { describe, expect, it, vi } from 'vitest'
import type { TypelessApi } from '@shared/api'
import type { CalendarEvent } from '@shared/calendar'
import type { Reminder } from '@shared/reminders'
import type { HistoryEntry, NoteEntry } from '@shared/types'
import { emptyStats } from '@shared/stats'
import { loadHomeData, openTodos, recentActivity, todayAgenda, todoTime } from './homeView'

const now = new Date(2026, 9, 27, 12).getTime()
const event = (id: string, start: number, end: number, status: CalendarEvent['status'] = 'confirmed'): CalendarEvent => ({
  id, title: id, start, end, status, allDay: false, source: 'manual', createdAt: now, updatedAt: now
})
const todo = (id: string, patch: Partial<Reminder> = {}): Reminder => ({
  id, title: id, dueAt: null, deadlineAt: null, priority: 'normal', level: 'normal', recurrence: null,
  source: 'manual', createdAt: now, updatedAt: now, status: 'pending', deliveredAt: null, ...patch
})
const history = (patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: 'history', mode: 'ask', createdAt: now, transcript: 'Question', final: 'Answer', durationMs: 1000, app: '', ...patch
})
const note = (patch: Partial<NoteEntry> = {}): NoteEntry => ({
  id: 'note', title: 'My note', createdAt: now, updatedAt: now + 1, transcript: '', polished: '', durationMs: 0, polishStatus: 'ok', tags: [], ...patch
})

function api(): TypelessApi {
  return {
    life: { eventsBetween: vi.fn(async () => []), briefing: async () => ({ body: 'Today', empty: false }) },
    reminders: { list: async () => [todo('pending')] },
    notes: { list: async () => ({ notes: [note()], categories: [] }) },
    history: { list: async () => [history()] },
    workflow: { list: async () => [] }, stats: { get: async () => emptyStats() }
  } as unknown as TypelessApi
}

describe('workspace reads', () => {
  it('keeps successful stores and exposes errors instead of presenting failures as an empty day', async () => {
    const bridge = api()
    bridge.life.eventsBetween = async () => { throw new Error("Error invoking remote method 'life:events': Error: Calendar unavailable") }
    bridge.history.list = async () => { throw new Error('History unavailable') }
    const result = await loadHomeData(bridge, now)
    expect(result.data.events).toBeUndefined()
    expect(result.data.history).toBeUndefined()
    expect(result.data.todos).toHaveLength(1)
    expect(result.data.notes).toHaveLength(1)
    expect(result.data.briefing?.body).toBe('Today')
    expect(result.errors).toEqual([
      { section: 'events', message: 'Calendar unavailable' }, { section: 'history', message: 'History unavailable' }
    ])
  })

  it('does not overwrite a previous successful read on failure and clears errors after recovery', async () => {
    const bridge = api()
    bridge.life.eventsBetween = async () => [event('kept', now, now + 1)]
    const first = await loadHomeData(bridge, now)
    bridge.life.eventsBetween = async () => { throw new Error('offline') }
    const failed = await loadHomeData(bridge, now)
    expect({ ...first.data, ...failed.data }.events?.[0]?.id).toBe('kept')
    bridge.life.eventsBetween = async () => []
    const recovered = await loadHomeData(bridge, now)
    expect(recovered.errors).toEqual([])
    expect(recovered.data.events).toEqual([])
  })

  it('queries local calendar boundaries and treats genuine empty results as loaded data', async () => {
    const bridge = api()
    const result = await loadHomeData(bridge, now)
    expect(bridge.life.eventsBetween).toHaveBeenCalledWith(new Date(2026, 9, 27).getTime(), new Date(2026, 9, 28).getTime())
    expect(result.data.events).toEqual([])
    expect(result.errors).toEqual([])
  })
})

describe('today priorities', () => {
  it('hides cancelled and other-day events and brings unfinished events ahead of past events', () => {
    const rows = [event('past', now - 3000, now - 2000), event('later', now + 2000, now + 3000),
      event('cancelled', now, now + 2000, 'cancelled'), event('ongoing', now - 1000, now + 1000),
      event('tomorrow', new Date(2026, 9, 28, 9).getTime(), new Date(2026, 9, 28, 10).getTime())]
    expect(todayAgenda(rows, now).map(row => row.id)).toEqual(['ongoing', 'later', 'past'])
    expect(rows[0]?.id).toBe('past')
  })

  it('puts overdue work first, ignores closed tasks and respects explicit deadlines', () => {
    const rows = [todo('important', { priority: 'high', deadlineAt: now + 10 }),
      todo('overdue', { priority: 'low', deadlineAt: now - 1 }),
      todo('alerted', { dueAt: now - 1, deadlineAt: now + 20 }),
      todo('closed', { status: 'completed', deadlineAt: now - 1 })]
    expect(openTodos(rows, now).map(row => row.id)).toEqual(['overdue', 'important', 'alerted'])
  })

  it('shows the deadline date so tomorrow cannot be mistaken for today at the same hour', () => {
    const row = todo('tomorrow', { dueAt: now, deadlineAt: new Date(2026, 9, 28, 18).getTime() })
    expect(todoTime(row, 'zh')).toContain('10/28')
    expect(todoTime(row, 'zh')).toContain('18:00')
    expect(todoTime(todo('unscheduled'), 'en')).toBeNull()
  })
})

describe('recent activity', () => {
  it('merges updated notes and all input modes, excluding archived rows', () => {
    const rows = recentActivity([history(), history({ id: 'archived', status: 'archived', createdAt: now + 100 }),
      history({ id: 'translate', mode: 'translate', createdAt: now - 1 })], [note()])
    expect(rows.map(row => row.id)).toEqual(['note', 'history', 'translate'])
    expect(rows[1]?.kind).toBe('ask')
  })

  it('keeps actionable failures visible and falls back to the note text when its title is empty', () => {
    const rows = recentActivity([history({ final: '', transcript: '', status: 'error', error: 'Connection failed' })],
      [note({ title: ' ', polished: 'Draft' })])
    expect(rows[0]?.text).toBe('Draft')
    expect(rows[1]).toMatchObject({ text: 'Connection failed', failed: true })
  })
})
