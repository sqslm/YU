import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CalendarStore } from '../../../../main/calendar'
import type { CalendarEvent } from '@shared/calendar'
import { emptyForm, formOf, toInput, withStartDate } from './calendarForm'

const at = (day: number, hour = 0): number => new Date(2026, 9, day, hour).getTime()
const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event', title: 'Original', start: at(29, 9), end: at(29, 10), allDay: false,
  notes: 'Bring the plan', location: 'Room A', source: 'import', uid: 'external-uid',
  status: 'confirmed', createdAt: at(27), updatedAt: at(27), ...patch
})
let directory: string | undefined
afterEach(() => { if (directory) { rmSync(directory, { recursive: true, force: true }); directory = undefined } })
function edit(original: CalendarEvent): CalendarEvent {
  directory = mkdtempSync(join(tmpdir(), 'yu-calendar-form-'))
  const store = new CalendarStore(join(directory, 'calendar.json'), () => at(27, 12))
  store.put(original)
  const saved = store.save(toInput({ ...formOf(original), title: 'Renamed' }), original.id)
  return new CalendarStore(join(directory, 'calendar.json')).get(saved.id)!
}

describe('calendar form round trips', () => {
  it.each([false, true])('preserves notes, location and UID when only the title changes; allDay=%s', allDay => {
    const original = event(allDay ? { allDay, start: at(29), end: at(30) } : {})
    expect(edit(original)).toMatchObject({ title: 'Renamed', notes: original.notes, location: original.location, uid: original.uid })
  })

  it.each([undefined, null, 0, 30])('preserves inherited, disabled and explicit reminder settings: %s', leadMinutes => {
    const saved = edit(event({ leadMinutes }))
    expect(saved.leadMinutes).toBe(leadMinutes)
  })

  it('keeps the exact end date of an overnight event when editing its title', () => {
    const original = event({ start: at(29, 23), end: at(30, 1) })
    expect(edit(original)).toMatchObject({ start: original.start, end: original.end })
  })

  it('keeps a multi-day event across a year boundary', () => {
    const original = event({ start: new Date(2026, 11, 31, 23).getTime(), end: new Date(2027, 0, 2, 1).getTime() })
    expect(edit(original)).toMatchObject({ start: original.start, end: original.end })
  })

  it.each(['start', 'end'] as const)('rejects a cleared %s time instead of saving midnight', field => {
    const form = { ...formOf(event()), [field]: '' }
    expect(() => toInput(form)).toThrow()
  })

  it('keeps deliberate midnight valid', () => {
    const original = event({ start: at(29), end: at(29, 1) })
    expect(toInput(formOf(original)).start).toBe(original.start)
  })

  it('allows clearing notes and location explicitly', () => {
    const form = { ...formOf(event()), notes: '', location: '' }
    expect(toInput(form)).toMatchObject({ title: 'Original' })
    expect(toInput(form).notes).toBeUndefined()
    expect(toInput(form).location).toBeUndefined()
  })

  it('keeps the existing new-event reminder default', () => {
    expect(emptyForm('2026-10-29').lead).toBe('none')
  })

  it('offers a valid one-hour slot near midnight', () => {
    const form = { ...emptyForm('2026-10-27', at(27, 23)), title: 'Late work' }
    expect(form.endDate).toBe('2026-10-28')
    expect(toInput(form).end - toInput(form).start).toBe(3600_000)
  })

  it('reschedules an overnight event without leaving its end on the previous date', () => {
    const form = formOf(event({ start: at(29, 23), end: at(30, 1) }))
    const moved = withStartDate(form, '2026-11-01')
    expect(moved.endDate).toBe('2026-11-02')
    expect(toInput(moved).end - toInput(moved).start).toBe(2 * 3600_000)
  })

  it.each(['25:00', '09:60', 'invalid'])('rejects invalid clocks: %s', start => {
    expect(() => toInput({ ...formOf(event()), start })).toThrow()
  })

  it('rejects a missing end date', () => {
    expect(() => toInput({ ...formOf(event()), endDate: '' })).toThrow()
  })
})
