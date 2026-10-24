import { describe, expect, it } from 'vitest'
import type { Reminder } from '@shared/reminders'
import { reminderDateBounds, reminderView } from './reminderView'

const stamp = (day: number, hour = 12): number => new Date(2026, 9, day, hour).getTime()
const row = (id: string, dueAt: number | null, extra: Partial<Reminder> = {}): Reminder => ({ id, title: id, dueAt, createdAt: stamp(24), updatedAt: stamp(24), level: 'normal', status: 'pending', recurrence: null, deliveredAt: null, source: 'manual', ...extra })
const all = { status: 'active', kind: 'all' as const, query: '', bounds: reminderDateBounds('all') }
describe('reminder and todo views', () => {
  it('separates scheduled reminders and undated todos using the existing data model', () => {
    const rows = [row('meeting', stamp(24)), row('write report', null)]
    expect(reminderView(rows, { ...all, kind: 'reminder' }).map(row => row.id)).toEqual(['meeting'])
    expect(reminderView(rows, { ...all, kind: 'todo' }).map(row => row.id)).toEqual(['write report'])
  })
  it('filters today by scheduled time for reminders and creation time for todos', () => {
    const rows = [row('today', stamp(24)), row('tomorrow', stamp(25)), row('new todo', null), row('old todo', null, { createdAt: stamp(23) })]
    expect(reminderView(rows, { ...all, bounds: reminderDateBounds('today', '', '', stamp(24)) }).map(row => row.id)).toEqual(['today', 'new todo'])
  })
  it('supports the previous seven calendar days and next seven days without mixing them', () => {
    const week = reminderDateBounds('week', '', '', stamp(24)), next = reminderDateBounds('nextWeek', '', '', stamp(24))
    expect(week).toEqual({ start: stamp(18, 0), end: stamp(25, 0) })
    expect(next).toEqual({ start: stamp(24, 0), end: stamp(31, 0) })
  })
  it('includes the whole custom end date and rejects reversed or missing date ranges', () => {
    const bounds = reminderDateBounds('custom', '2026-10-23', '2026-10-24')
    expect(reminderView([row('last hour', stamp(24, 23)), row('next day', stamp(25, 0))], { ...all, bounds }).map(row => row.id)).toEqual(['last hour'])
    expect(reminderView([row('hidden', null)], { ...all, bounds: reminderDateBounds('custom', '2026-10-25', '2026-10-24') })).toEqual([])
    expect(reminderDateBounds('custom').error).toBeTruthy()
  })
  it('combines type, status, time and search filters before pagination', () => {
    const rows = [row('Call bank', stamp(24)), row('Call dentist', stamp(24), { status: 'completed' }), row('Call friend', null), row('Call next week', stamp(31))]
    expect(reminderView(rows, { ...all, kind: 'reminder', query: 'CALL', bounds: reminderDateBounds('today', '', '', stamp(24)) }).map(row => row.id)).toEqual(['Call bank'])
    expect(reminderView(rows, { ...all, status: 'completed' }).map(row => row.id)).toEqual(['Call dentist'])
  })
})
