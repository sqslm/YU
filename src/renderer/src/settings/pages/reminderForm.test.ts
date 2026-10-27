import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReminderStore } from '../../../../main/reminders'
import type { ReminderRecurrence } from '@shared/reminders'
import { fromReminder, input } from './reminderForm'

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime()
afterEach(() => vi.useRealTimers())

describe('editing recurring reminders', () => {
  it.each(['daily', 'weekly', 'monthly', 'yearly'] as const)('keeps the %s series and consumed count after snoozing and renaming', frequency => {
    vi.useFakeTimers(); vi.setSystemTime(at(27, 8))
    const store = new ReminderStore(':memory:')
    try {
      const recurrence: ReminderRecurrence = { frequency, hour: 9, minute: 0, count: 3,
        ...(frequency === 'weekly' ? { weekdays: [new Date(at(27, 9)).getDay()] } : {}),
        ...(['monthly', 'yearly'].includes(frequency) ? { day: 27 } : {}),
        ...(frequency === 'yearly' ? { month: 10 } : {}) }
      const first = store.save({ title: 'Series', dueAt: at(27, 9), level: 'normal', source: 'manual', recurrence })
      vi.setSystemTime(first.dueAt!); store.markDue(first.id)
      const next = store.action(first.id, 'complete')
      vi.setSystemTime(next.dueAt!); store.markDue(first.id)
      const snoozed = store.action(first.id, 'snooze', 5)
      const saved = store.save(input({ ...fromReminder(snoozed), title: 'Renamed' }, 'manual', undefined, snoozed), first.id)
      expect(saved).toMatchObject({ recurrence: snoozed.recurrence, dueAt: snoozed.dueAt, snoozedUntil: snoozed.snoozedUntil, occurrences: 1 })
      vi.setSystemTime(saved.dueAt!); store.markDue(first.id)
      const following = store.action(first.id, 'complete')
      expect(new Date(following.dueAt!).getMinutes()).toBe(0)
      expect(following.occurrences).toBe(2)
      vi.setSystemTime(following.dueAt!); store.markDue(first.id)
      expect(store.action(first.id, 'complete').status).toBe('completed')
    } finally { store.close() }
  })

  it('keeps an exact recurrence end timestamp when editing metadata', () => {
    vi.useFakeTimers(); vi.setSystemTime(at(27, 8))
    const store = new ReminderStore(':memory:')
    try {
      const original = store.save({ title: 'Series', dueAt: at(27, 9), level: 'normal', source: 'manual',
        recurrence: { frequency: 'daily', hour: 9, minute: 0, until: at(30, 12) } })
      const saved = store.save(input({ ...fromReminder(original), description: 'New description' }, 'manual', undefined, original), original.id)
      expect(saved.recurrence).toEqual(original.recurrence)
    } finally { store.close() }
  })

  it('allows an intentional time change to reset the series', () => {
    vi.useFakeTimers(); vi.setSystemTime(at(27, 8))
    const store = new ReminderStore(':memory:')
    try {
      const original = store.save({ title: 'Series', dueAt: at(27, 9), level: 'normal', source: 'manual', recurrence: { frequency: 'daily', hour: 9, minute: 0 } })
      const saved = store.save(input({ ...fromReminder(original), date: '2026-10-27T10:30' }, 'manual', undefined, original), original.id)
      expect(saved.recurrence).toMatchObject({ hour: 10, minute: 30 })
      expect(saved.dueAt).toBe(at(27, 10, 30))
    } finally { store.close() }
  })
})
