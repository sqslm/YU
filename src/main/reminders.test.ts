import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ReminderInput } from '@shared/reminders'
import { ReminderScheduler, ReminderStore } from './reminders'
const base = new Date(2026, 9, 23, 8).getTime()
const entry = (dueAt: number | null): ReminderInput => ({ title: 'Call the technician', dueAt, level: 'normal', source: 'manual', recurrence: null })
afterEach(() => vi.useRealTimers())
describe('durable local reminders', () => {
  it('restores processed reminders without immediately redelivering an expired occurrence', () => {
    let now = base
    const store = new ReminderStore(':memory:', () => now)
    try {
      const expired = store.save({ ...entry(base + 60000), description: 'Keep details', source: 'note', noteId: 'note-1' })
      store.action(expired.id, 'complete'); now += 120000
      expect(store.action(expired.id, 'restore')).toMatchObject({ id: expired.id, status: 'pending', dueAt: null, description: 'Keep details', noteId: 'note-1', deliveredAt: null })
      const future = store.save(entry(now + 3600000)); store.action(future.id, 'cancel')
      expect(store.action(future.id, 'restore').dueAt).toBe(future.dueAt)
      const recurring = store.save({ ...entry(now + 60000), recurrence: { frequency: 'daily', hour: 9, minute: 0 } })
      store.action(recurring.id, 'cancel')
      expect(store.action(recurring.id, 'restore')).toMatchObject({ status: 'pending', dueAt: new Date(2026, 9, 23, 9).getTime() })
      expect(() => store.action(future.id, 'restore')).toThrow('仅可恢复已完成或已取消的提醒')
      const deliver = vi.fn(), scheduler = new ReminderScheduler(store, deliver, vi.fn(), () => now)
      scheduler.check(); scheduler.stop(); expect(deliver).not.toHaveBeenCalled()
    } finally { store.close() }
  })
  it('persists an occurrence snooze across restart, validates durations and returns to the original recurring time on completion', () => {
    let now = base
    const dir = mkdtempSync(join(tmpdir(), 'typeless-snooze-')), file = join(dir, 'reminders.sqlite')
    let store = new ReminderStore(file, () => now)
    try {
      const row = store.save({ ...entry(base + 60000), recurrence: { frequency: 'daily', hour: 8, minute: 1 } })
      now += 60000; store.markDue(row.id)
      for (const minutes of [0, -1, 1.5, NaN, 1441]) expect(() => store.action(row.id, 'snooze', minutes)).toThrow('稍后提醒时长无效')
      const snoozed = store.action(row.id, 'snooze', 60)
      store.close(); store = new ReminderStore(file, () => now)
      store.rebaseRecurrences()
      expect(store.get(row.id)).toMatchObject({ dueAt: now + 3600000, snoozedUntil: snoozed.dueAt, status: 'pending' })
      const completed = store.action(row.id, 'complete')
      expect(completed.dueAt).toBe(new Date(2026, 9, 24, 8, 1).getTime())
      expect(completed.snoozedUntil).toBeUndefined()
    } finally { store.close(); rmSync(dir, { recursive: true }) }
  })
  it('keeps an explicit snooze deadline when recurring schedules are rebased', () => {
    let now = base
    const store = new ReminderStore(':memory:', () => now)
    try {
      const row = store.save({ ...entry(base + 60000), recurrence: { frequency: 'daily', hour: 8, minute: 1 } })
      now += 60000; store.markDue(row.id)
      const snoozed = store.action(row.id, 'snooze', 15)
      store.rebaseRecurrences()
      expect(store.get(row.id)?.dueAt).toBe(snoozed.dueAt)
    } finally { store.close() }
  })
  it('persists descriptions and source expressions across restart, and preserves descriptions on older edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeless-reminder-details-')), file = join(dir, 'reminders.sqlite')
    let store = new ReminderStore(file, () => base)
    try {
      const row = store.save({ ...entry(null), source: 'note', noteId: 'source-note', description: 'Ask about the repair; do not replace parts.', timeExpression: 'before Friday' })
      store.close(); store = new ReminderStore(file, () => base)
      expect(store.get(row.id)).toMatchObject({ description: row.description, source: 'note', noteId: 'source-note', timeExpression: 'before Friday' })
      const { description: _description, ...olderInput } = row
      expect(store.save({ ...olderInput, title: 'Call repair shop' }, row.id).description).toBe(row.description)
      expect(() => store.save({ ...entry(null), description: 'x'.repeat(4001) })).toThrow('提醒备注不能超过 4000 字')
    } finally { store.close(); rmSync(dir, { recursive: true }) }
  })
  it('restores records after restart and delivers a missed occurrence only once', () => {
    let now = base
    const dir = mkdtempSync(join(tmpdir(), 'typeless-reminders-')), file = join(dir, 'reminders.sqlite')
    let store = new ReminderStore(file, () => now)
    try {
      const row = store.save(entry(now + 1200000)); store.close()
      now += 1500000; store = new ReminderStore(file, () => now)
      const deliver = vi.fn(), scheduler = new ReminderScheduler(store, deliver, vi.fn(), () => now)
      scheduler.check(); scheduler.check(); scheduler.stop()
      expect(deliver).toHaveBeenCalledOnce(); expect(store.get(row.id)?.status).toBe('due')
      store.close(); store = new ReminderStore(file, () => now)
      const restored = new ReminderScheduler(store, deliver, vi.fn(), () => now); restored.check(); restored.stop()
      expect(deliver).toHaveBeenCalledOnce()
    } finally { store.close(); rmSync(dir, { recursive: true }) }
  })
  it('uses a deadline timer and never delivers removed, cancelled, completed or untimed tasks', () => {
    vi.useFakeTimers(); vi.setSystemTime(base)
    const store = new ReminderStore(':memory:')
    const deliver = vi.fn(), changed = vi.fn(), scheduler = new ReminderScheduler(store, deliver, changed)
    try {
      const removed = store.save(entry(base + 1000)); store.remove(removed.id)
      const cancelled = store.save(entry(base + 1000)); store.action(cancelled.id, 'cancel')
      const complete = store.save(entry(base + 1000)); store.action(complete.id, 'complete')
      store.save(entry(null)); const valid = store.save(entry(base + 1000))
      scheduler.check(); vi.advanceTimersByTime(1000)
      expect(deliver).toHaveBeenCalledOnce(); expect(deliver.mock.calls[0]?.[0].id).toBe(valid.id)
      vi.advanceTimersByTime(120000); expect(deliver).toHaveBeenCalledOnce()
    } finally { scheduler.stop(); store.close() }
  })
  it('restores unhandled strong reminders and snoozes without losing recurrence', () => {
    let now = base
    const store = new ReminderStore(':memory:', () => now)
    try {
      const row = store.save({ ...entry(now + 60000), level: 'strong', recurrence: { frequency: 'daily', hour: 8, minute: 1 } })
      now += 60000; store.markDue(row.id)
      expect(store.list()[0]).toMatchObject({ status: 'due', level: 'strong' })
      const snoozed = store.action(row.id, 'snooze'); expect(snoozed.dueAt).toBe(now + 300000); expect(snoozed.recurrence).not.toBeNull()
      const next = store.action(row.id, 'complete'); expect(next.status).toBe('pending'); expect(next.dueAt).toBe(new Date(2026, 9, 24, 8, 1).getTime())
      store.action(row.id, 'cancel'); now += 86400000; expect(store.markDue(row.id)).toBeUndefined()
    } finally { store.close() }
  })
  it('rolls back the entire confirmed batch when one item is invalid', () => {
    const store = new ReminderStore(':memory:', () => base)
    try {
      expect(() => store.saveMany([entry(base + 1000), entry(base - 1000)])).toThrow()
      expect(store.list()).toHaveLength(0)
      const rows = store.saveMany([entry(base + 1000), entry(null)])
      expect(rows).toHaveLength(2); expect(new Set(rows.map(r => r.id)).size).toBe(2)
      expect(() => store.save({ ...entry(base + 1000), recurrence: { frequency: 'weekly', hour: 30, minute: 0, weekdays: [] } })).toThrow()
    } finally { store.close() }
  })
})

it('editing a completed reminder does not reactivate it; editing a due title does not notify again', () => {
  let now = base
  const store = new ReminderStore(':memory:', () => now)
  try {
    const completed = store.save(entry(base + 1000)); store.action(completed.id, 'complete')
    now += 2000
    expect(store.save({ ...completed, title: 'New title' }, completed.id).status).toBe('completed')
    const due = store.save(entry(now + 1000)); now += 1000; store.markDue(due.id)
    const edited = store.save({ ...due, title: 'Updated due task', level: 'strong' }, due.id)
    expect(edited.status).toBe('due'); expect(edited.deliveredAt).toBe(now)
    expect(store.markDue(due.id)).toBeUndefined()
    const recurring = store.save({ ...entry(now + 3600000), recurrence: { frequency: 'daily', hour: 9, minute: 0 } })
    expect(store.action(recurring.id, 'complete').dueAt).toBeGreaterThan(recurring.dueAt!)
  } finally { store.close() }
})
