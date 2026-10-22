import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextOccurrence, resolveReminderTime } from './reminder-time'
import { parseReminderOutput } from './reminder-parser'
const now = new Date(2026, 9, 23, 8, 0).getTime()
afterEach(() => vi.unstubAllEnvs())
const local = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime()
function draft(time_expression: string | null, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ items: [{ intent: 'create_reminder', title: '打扫卫生', time_expression, level: 'normal', recurrence: null, needs_confirmation: false, ...overrides }] })
}
describe('bilingual reminder time interpretation', () => {
  it.each(['20分钟后', '二十分钟后', 'in 20 minutes', 'in twenty minutes', '20 minutes from now'])('calculates %s locally', text => {
    expect(resolveReminderTime(text, now)).toMatchObject({ dueAt: now + 20 * 60000, recurrence: null })
  })
  it.each(['两小时后', '2小时后', 'in 2 hours', 'in two hours'])('supports hours: %s', text => expect(resolveReminderTime(text, now).dueAt).toBe(now + 2 * 3600000))
  it.each([['一个半小时后', 90], ['一個半小時後', 90], ['一刻钟后', 15], ['一刻鐘後', 15], ['再过四十五分钟', 45], ['再過四十五分鐘', 45], ['in one and a half hours', 90], ['in an hour and a half', 90]] as const)('preserves spoken relative amounts: %s', (text, minutes) => {
    expect(resolveReminderTime(text, now).dueAt).toBe(now + minutes * 60000)
  })
  it.each(['明天上午10点', '明天上午十点', 'tomorrow at 10 AM'])('resolves a calendar date: %s', text => expect(resolveReminderTime(text, now).dueAt).toBe(local(24, 10)))
  it.each(['每周一上午9点', '每週一上午9點', 'every Monday at 9 AM'])('calculates repeating weekday: %s', text => {
    expect(resolveReminderTime(text, now)).toMatchObject({ dueAt: local(26, 9), recurrence: { frequency: 'weekly', weekdays: [1], hour: 9, minute: 0 } })
  })
  it.each(['每天下午三点半', 'every day at 3:30 PM'])('supports daily recurrence: %s', text => expect(resolveReminderTime(text, now)).toMatchObject({ dueAt: local(23, 15, 30), recurrence: { frequency: 'daily', hour: 15, minute: 30 } }))
  it.each([null, '明天', 'tomorrow', '周五之前', 'before Friday', '三点半', 'at 3:30', 'tomorrow morning', '2026-02-30 at 10 AM', '03/04 at 10am', '今天上午7点'])('requires confirmation for %s', text => expect(resolveReminderTime(text, now).dueAt).toBeNull())
  it('does not advance a weekly recurrence by a fixed 7*24-hour duration', () => {
    expect(nextOccurrence({ frequency: 'weekly', weekdays: [1], hour: 9, minute: 0 }, local(26, 10))).toBe(new Date(2026, 10, 2, 9).getTime())
  })
  it.each(['每天上午9点，持续7天', 'every day at 9 AM for seven days', 'every Monday at 9 AM until November 1', '每周一三五晚上9点', 'every Monday and Wednesday at 9 AM'])('does not silently weaken unsupported recurrence: %s', text => {
    expect(resolveReminderTime(text, now)).toMatchObject({ dueAt: null, recurrence: null })
  })
  it('validates reminder intent, level, missing times and final corrected expressions', () => {
    expect(parseReminderOutput(draft('20分钟后'), now)[0]).toMatchObject({ level: 'normal', dueAt: now + 1200000, needs_confirmation: false })
    expect(parseReminderOutput(draft('20分钟后', { level: 'strong' }), now)[0]?.level).toBe('strong')
    expect(parseReminderOutput(draft('明天下午三点半'), now)[0]?.dueAt).toBe(local(24, 15, 30))
    expect(parseReminderOutput(draft('tomorrow at 3:30 PM'), now)[0]?.dueAt).toBe(local(24, 15, 30))
    expect(parseReminderOutput(draft(null), now)[0]).toMatchObject({ dueAt: null, needs_confirmation: true })
    expect(parseReminderOutput(draft('every Monday at 9 AM', { recurrence: 'weekly' }), now)[0]?.needs_confirmation).toBe(false)
    expect(() => parseReminderOutput(draft('20分钟后', { level: 'severe' }), now)).toThrow()
    expect(() => parseReminderOutput('{"items":[{"title":"fake","dueAt":9999999999999}]}', now)).toThrow()
  })
  it('handles English spoken clock numbers, noon, calendar months and a half hour', () => {
    expect(resolveReminderTime('tomorrow at three thirty PM', now).dueAt).toBe(local(24, 15, 30))
    expect(resolveReminderTime('tomorrow at twelve PM', now).dueAt).toBe(local(24, 12))
    expect(resolveReminderTime('in half an hour', now).dueAt).toBe(now + 1800000)
    expect(resolveReminderTime('November 5 at 10 AM', now).dueAt).toBe(new Date(2026, 10, 5, 10).getTime())
    expect(resolveReminderTime('every Tuesday at noon', now).recurrence).toMatchObject({ weekdays: [2], hour: 12 })
    expect(resolveReminderTime('明天三点半', now).dueAt).toBeNull()
    expect(resolveReminderTime('every month on the 1st at 9AM', now).dueAt).toBeNull()
  })
  it('keeps local calendar recurrence across daylight saving and rejects nonexistent one-off times', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const before = new Date(2026, 2, 7, 9).getTime()
    expect(nextOccurrence({ frequency: 'daily', hour: 9, minute: 0 }, before) - before).toBe(23 * 3600000)
    expect(nextOccurrence({ frequency: 'weekly', hour: 2, minute: 30, weekdays: [0] }, new Date(2026, 2, 7, 8).getTime()))
      .toBe(new Date(2026, 2, 15, 2, 30).getTime())
    expect(resolveReminderTime('March 8 2026 at 2:30 AM', new Date(2026, 2, 7, 8).getTime()).dueAt).toBeNull()
  })
})
