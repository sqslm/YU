import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseIcs } from '@shared/calendar'
import { CalendarStore } from './calendar'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const event = (...fields: string[]) => ['BEGIN:VEVENT', 'UID:import-test', 'SUMMARY:Imported meeting', ...fields, 'END:VEVENT'].join('\r\n')
const calendar = (...events: string[]) => ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\r\n')

it.each([
  ['Asia/Tokyo', '20261102T090000', '2026-11-02T00:00:00.000Z'],
  ['America/New_York', '20260702T090000', '2026-07-02T13:00:00.000Z'],
  ['America/New_York', '20261102T090000', '2026-11-02T14:00:00.000Z']
])('converts %s using the offset on the event date', (zone, start, expected) => {
  expect(new Date(parseIcs(calendar(event(`DTSTART;TZID=${zone}:${start}`)))[0].start).toISOString()).toBe(expected)
})

it('rejects unknown zones and nonexistent DST times instead of moving the meeting', () => {
  expect(() => parseIcs(calendar(event('DTSTART;TZID=Unknown/Zone:20261102T090000')))).toThrow('不支持的日历时区')
  expect(() => parseIcs(calendar(event('DTSTART;TZID=America/New_York:20260308T023000')))).toThrow('不存在')
})

it('keeps a multi-day all-day event through storage, day queries and ICS export', () => {
  const root = mkdtempSync(join(tmpdir(), 'yu-ics-import-')); roots.push(root)
  const store = new CalendarStore(join(root, 'calendar.json'))
  store.importIcs(calendar(event('DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261105')))
  const row = store.list()[0]
  expect(row.end).toBe(new Date(2026, 10, 5).getTime())
  expect(store.exportIcs()).toContain('DTEND;VALUE=DATE:20261105')
  expect(new CalendarStore(join(root, 'calendar.json')).list()[0].end).toBe(row.end)
})

it.each(['RRULE:FREQ=DAILY;COUNT=3', 'RDATE:20261104T090000', 'EXDATE:20261103T090000', 'RECURRENCE-ID:20261103T090000'])(
  'rejects unsupported recurrence without a partial import: %s', rule => {
    const root = mkdtempSync(join(tmpdir(), 'yu-ics-import-')); roots.push(root)
    const store = new CalendarStore(join(root, 'calendar.json'))
    expect(() => store.importIcs(calendar(event('DTSTART:20261101T090000'), event('DTSTART:20261102T090000', rule)))).toThrow('重复日程')
    expect(store.list()).toEqual([])
  }
)
