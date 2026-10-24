import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setMainLanguage } from '@shared/mainI18n'
import {
  DEFAULT_CALENDAR_SETTINGS,
  MAX_EVENTS,
  formatEventTime,
  localDayKey,
  monthRangeFor,
  normalizeEventInput,
  overlaps,
  parseIcs,
  rangeFor,
  sortEvents,
  startOfLocalDay,
  toIcs,
  type CalendarEvent,
  type CalendarEventInput
} from '@shared/calendar'
import { CalendarScheduler, CalendarStore } from './calendar'

/**
 * The local schedule on disk: persistence, corruption isolation, day ranges and
 * the ICS bridge. The clock is injected so "today" is a fixed Wednesday.
 */

/** Wednesday 2026-10-21 09:00 local. */
const NOW = new Date(2026, 9, 21, 9, 0, 0).getTime()
const DAY = 86_400_000

function at(day: number, hour: number, minute = 0, second = 0): number {
  return new Date(2026, 9, day, hour, minute, second, 0).getTime()
}

function input(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return { title: '团队周会', start: at(21, 10), end: at(21, 11), ...overrides }
}

describe('calendar store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    setMainLanguage('zh')
    dir = mkdtempSync(join(tmpdir(), 'yu-cal-'))
    file = join(dir, 'calendar.json')
  })
  afterEach(() => {
    setMainLanguage('zh')
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty without a file and reloads what was saved', () => {
    const store = new CalendarStore(file, () => NOW)
    expect(store.list()).toEqual([])
    const saved = store.save(input({ title: '  体检  ' }))
    expect(saved.title).toBe('体检')
    expect(saved.status).toBe('confirmed')
    expect(saved.source).toBe('voice')
    expect(saved.createdAt).toBe(NOW)
    expect(saved.updatedAt).toBe(NOW)
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)

    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number; events: CalendarEvent[] }
    expect(document.version).toBe(1)
    expect(document.events).toHaveLength(1)

    const reloaded = new CalendarStore(file, () => NOW)
    expect(reloaded.get(saved.id)).toEqual(saved)
  })

  it('cancels, restores and removes without losing the row', () => {
    const store = new CalendarStore(file, () => NOW)
    const first = store.save(input({ title: '第一个', start: at(22, 9), end: at(22, 10) }))
    const second = store.save(input({ title: '第二个', start: at(21, 8), end: at(21, 9) }))
    // Start ascending, not insertion order.
    expect(store.list().map(row => row.id)).toEqual([second.id, first.id])

    expect(store.action(first.id, 'cancel').status).toBe('cancelled')
    expect(store.active().map(row => row.id)).toEqual([second.id])
    // Cancelling twice is idempotent and keeps the timestamp the user saw.
    expect(store.action(first.id, 'cancel').updatedAt).toBe(store.get(first.id)!.updatedAt)
    expect(store.list()).toHaveLength(2)
    expect(store.action(first.id, 'restore').status).toBe('confirmed')
    expect(store.active()).toHaveLength(2)

    store.remove(first.id)
    expect(store.get(first.id)).toBeUndefined()
    expect(store.list().map(row => row.id)).toEqual([second.id])
    expect(new CalendarStore(file, () => NOW).list().map(row => row.id)).toEqual([second.id])
  })

  it('rejects an unknown id and refuses to grow past the cap', () => {
    const store = new CalendarStore(file, () => NOW)
    expect(() => store.save(input(), 'missing-id')).toThrow('日程不存在')
    expect(() => store.action('missing-id', 'cancel')).toThrow('日程不存在')

    const rows: CalendarEvent[] = Array.from({ length: MAX_EVENTS }, (_unused, index) => ({
      id: `event-${index}`, title: `占位 ${index}`, start: at(21, 0) + index * 60_000, end: at(21, 1) + index * 60_000,
      allDay: false, source: 'manual', createdAt: NOW, updatedAt: NOW, status: 'confirmed'
    }))
    writeFileSync(file, JSON.stringify({ version: 1, events: rows }), 'utf8')
    const full = new CalendarStore(file, () => NOW)
    expect(full.list()).toHaveLength(MAX_EVENTS)
    expect(() => full.save(input())).toThrow('日程数量已达上限')
    // Editing an existing row is still allowed at the cap.
    expect(full.save({ ...input(), title: '改期' }, rows[0].id).title).toBe('改期')
  })

  it('quarantines a damaged file instead of throwing or overwriting it', () => {
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = new CalendarStore(file, () => NOW)
    expect(store.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
    const broken = readdirSync(dir).filter(name => name.startsWith('calendar.broken-'))
    expect(broken).toHaveLength(1)
    expect(readFileSync(join(dir, broken[0]), 'utf8')).toBe('{ this is not json')
    expect(store.damagedFile).toBe(join(dir, broken[0]))
    // The store stays usable and writes a fresh document.
    expect(store.save(input()).title).toBe('团队周会')
    expect(existsSync(file)).toBe(true)
  })

  it('quarantines a structurally wrong document too', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, events: [{ id: 'x' }] }), 'utf8')
    const store = new CalendarStore(file, () => NOW)
    expect(store.list()).toEqual([])
    expect(readdirSync(dir).some(name => name.includes('.broken-'))).toBe(true)
  })

  it('computes today, tomorrow, week and upcoming on local days', () => {
    expect(rangeFor('today', NOW)).toEqual({ from: new Date(2026, 9, 21).getTime(), until: new Date(2026, 9, 22).getTime() })
    expect(rangeFor('tomorrow', NOW)).toEqual({ from: new Date(2026, 9, 22).getTime(), until: new Date(2026, 9, 23).getTime() })
    expect(rangeFor('yesterday', NOW)).toEqual({ from: new Date(2026, 9, 20).getTime(), until: new Date(2026, 9, 21).getTime() })
    // Wednesday 2026-10-21 sits in the Monday-first week 10-19 .. 10-26.
    expect(rangeFor('week', NOW)).toEqual({ from: new Date(2026, 9, 19).getTime(), until: new Date(2026, 9, 26).getTime() })
    expect(rangeFor('upcoming', NOW)).toEqual({ from: NOW, until: NOW + 7 * DAY })

    const store = new CalendarStore(file, () => NOW)
    const late = store.save(input({ title: '今天 23:00', start: at(21, 23), end: at(21, 23, 30) }))
    const tomorrow = store.save(input({ title: '明天 00:00', start: at(22, 0), end: at(22, 1) }))
    expect(store.onDay('today').map(row => row.id)).toEqual([late.id])
    expect(store.onDay('tomorrow').map(row => row.id)).toEqual([tomorrow.id])
    const { from, until } = rangeFor('week', NOW)
    expect(store.range(from, until)).toHaveLength(2)
    // 'upcoming' starts at now, so a late-evening entry today still counts.
    expect(store.onDay('upcoming').map(row => row.id)).toEqual([late.id, tomorrow.id])
  })

  it('anchors the month grid to the month on screen, not to the clock', () => {
    // November 2026 starts on a Sunday, so its Monday-first grid opens on 10-26.
    expect(monthRangeFor(2026, 10)).toEqual({ from: new Date(2026, 9, 26).getTime(), until: new Date(2026, 11, 7).getTime() })
    // Without an anchor nothing changed: "month" still means the clock's month.
    expect(rangeFor('month', NOW)).toEqual(monthRangeFor(2026, 9))
    expect(rangeFor('month', NOW, { year: 2026, month: 10 })).toEqual(monthRangeFor(2026, 10))
    // The anchor is scoped to the month grid: paging must not move "today".
    expect(rangeFor('today', NOW, { year: 2026, month: 10 })).toEqual(rangeFor('today', NOW))
    // A malformed anchor falls back to the clock instead of blanking the page.
    expect(rangeFor('month', NOW, { year: Number.NaN, month: 42 })).toEqual(rangeFor('month', NOW))
  })

  it('answers onDay for an explicit YYYY-MM-DD key', () => {
    const store = new CalendarStore(file, () => NOW)
    const target = store.save(input({ title: '后天上午', start: at(23, 10), end: at(23, 11) }))
    store.save(input({ title: '今天', start: at(21, 10), end: at(21, 11) }))
    expect(store.onDay('2026-10-23').map(row => row.id)).toEqual([target.id])
    expect(store.onDay('2026-10-24')).toEqual([])
    expect(localDayKey(target.start)).toBe('2026-10-23')
    expect(startOfLocalDay(target.start)).toBe(new Date(2026, 9, 23).getTime())
    expect(() => store.onDay('23/10/2026')).toThrow('日期格式无效')
  })

  it('finds a cross-midnight event on both days it touches', () => {
    const store = new CalendarStore(file, () => NOW)
    const overnight = store.save(input({ title: '通宵值班', start: at(21, 22), end: at(22, 2) }))
    expect(overlaps(overnight, at(21, 0), at(22, 0))).toBe(true)
    expect(overlaps(overnight, at(22, 0), at(23, 0))).toBe(true)
    expect(overlaps(overnight, at(20, 0), at(21, 0))).toBe(false)
    expect(store.onDay('2026-10-21').map(row => row.id)).toEqual([overnight.id])
    expect(store.onDay('2026-10-22').map(row => row.id)).toEqual([overnight.id])
  })

  it('normalizes an all-day event to local midnight plus 24h', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '全天培训', allDay: true, start: at(21, 13) + 45 * 60_000, end: at(21, 14) + 45 * 60_000 }))
    expect(event.start).toBe(new Date(2026, 9, 21).getTime())
    expect(event.end).toBe(new Date(2026, 9, 22).getTime())
    expect(formatEventTime(event, 'zh')).toBe('全天')
    expect(formatEventTime(event, 'en')).toBe('All day')
  })

  it('falls back to a sane end when the range is backwards', () => {
    const store = new CalendarStore(file, () => NOW)
    const timed = store.save(input({ start: at(21, 10), end: at(21, 9) }))
    expect(timed.end - timed.start).toBe(60 * 60_000)
    expect(normalizeEventInput(input({ allDay: true, start: at(21, 10), end: at(21, 9) }), NOW).end)
      .toBe(new Date(2026, 9, 22).getTime())
    expect(() => normalizeEventInput(input({ title: '   ' }), NOW)).toThrow('请提供日程标题')
    expect(normalizeEventInput(input({ leadMinutes: 99_999 }), NOW).leadMinutes).toBe(1440)
    expect(normalizeEventInput(input({ leadMinutes: null }), NOW).leadMinutes).toBeNull()
    expect(normalizeEventInput(input({ title: 'x'.repeat(300) }), NOW).title).toHaveLength(200)
    expect(normalizeEventInput(input({ source: undefined }), NOW).source).toBe('voice')
    expect(DEFAULT_CALENDAR_SETTINGS.defaultLeadMinutes).toBe(10)
  })

  it('round-trips Chinese titles, escaping and all-day dates through ICS', () => {
    const store = new CalendarStore(file, () => NOW)
    const meeting = store.save(input({ title: '周会, 讨论; 计划', notes: '第一行\n第二行, 续', location: '三楼会议室' }))
    const allDay = store.save(input({ title: '国庆调休', allDay: true, start: at(22, 0), end: at(22, 0) }))
    const ics = store.exportIcs()

    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//YU//Calendar//ZH\r\nCALSCALE:GREGORIAN\r\n')).toBe(true)
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    expect(ics).not.toMatch(/[^\r]\n/)
    expect(ics).toContain('SUMMARY:周会\\, 讨论\\; 计划')
    expect(ics).toContain('DESCRIPTION:第一行\\n第二行\\, 续')
    expect(ics).toContain('LOCATION:三楼会议室')
    expect(ics).toContain(`UID:${meeting.id}`)
    expect(ics).toContain('DTSTART:20261021T100000')
    expect(ics).toContain('DTEND;VALUE=DATE:20261023')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261022')
    expect(ics).not.toContain('STATUS:CANCELLED')

    // Cancelled rows stay out of the export.
    store.action(meeting.id, 'cancel')
    expect(store.exportIcs()).not.toContain(meeting.id)
    store.action(meeting.id, 'restore')

    const parsed = parseIcs(ics)
    expect(parsed).toHaveLength(2)
    const [back] = parsed
    expect(back.title).toBe('周会, 讨论; 计划')
    expect(back.notes).toBe('第一行\n第二行, 续')
    expect(back.start).toBe(meeting.start)
    expect(back.end).toBe(meeting.end)
    expect(back.allDay).toBe(false)
    expect(parsed[1].allDay).toBe(true)
    expect(parsed[1].start).toBe(allDay.start)
    expect(parsed[1].end).toBe(allDay.end)
  })

  it('parses folded lines, TZID parameters, UTC stamps and DATE values', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:folded-1',
      'DTSTART;TZID=Asia/Shanghai:20261021T100000',
      'DTEND;TZID="Asia/Shanghai":20261021T113000',
      'SUMMARY:这是一个需要折行的很长很长的中文日程标题用来验证按 UTF-8 字节',
      ' 折行而不是按字符切分的事情会发生在一个很长的标题上面并且还要继续加内容',
      'DESCRIPTION:第一行\\n第二行\\, 逗号',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:utc-1',
      'DTSTART:20261021T020000Z',
      'DTEND:20261021T030000Z',
      'SUMMARY:UTC 事件',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:date-1',
      'DTSTART;VALUE=DATE:20261021',
      'DTEND;VALUE=DATE:20261022',
      'SUMMARY:全天',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:no-start',
      'SUMMARY:没有开始时间',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\n')

    const rows = parseIcs(ics)
    expect(rows).toHaveLength(3)
    expect(rows[0].title).toBe('这是一个需要折行的很长很长的中文日程标题用来验证按 UTF-8 字节折行而不是按字符切分的事情会发生在一个很长的标题上面并且还要继续加内容')
    expect(rows[0].notes).toBe('第一行\n第二行, 逗号')
    // TZID is read as local wall-clock time; the quote in TZID="..." must not break the key.
    expect(rows[0].start).toBe(new Date(2026, 9, 21, 10, 0, 0).getTime())
    expect(rows[0].end).toBe(new Date(2026, 9, 21, 11, 30, 0).getTime())
    expect(rows[1].start).toBe(Date.UTC(2026, 9, 21, 2, 0, 0))
    expect(rows[2].allDay).toBe(true)
    expect(rows[2].start).toBe(new Date(2026, 9, 21).getTime())
    expect(rows[2].end).toBe(new Date(2026, 9, 22).getTime())
    expect(rows.every(row => row.source === 'import')).toBe(true)
  })

  it('imports with uid deduplication and counts what it skipped', () => {
    const store = new CalendarStore(file, () => NOW)
    const first = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:shared-1',
      'DTSTART:20261022T090000',
      'DTEND:20261022T100000',
      'SUMMARY:外部日程',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:缺少开始时间',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    expect(store.importIcs(first)).toEqual({ added: 1, updated: 0, skipped: 1 })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].source).toBe('import')

    const second = first.replace('外部日程', '外部日程（改期）').replace('20261022T090000', '20261023T140000').replace('20261022T100000', '20261023T150000')
    expect(store.importIcs(second)).toEqual({ added: 0, updated: 1, skipped: 1 })
    const rows = store.list()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('外部日程（改期）')
    expect(rows[0].start).toBe(new Date(2026, 9, 23, 14, 0, 0).getTime())
    expect(rows[0].uid).toBe('shared-1')
    // The dedupe survives a reload: uid is persisted, not recomputed.
    expect(new CalendarStore(file, () => NOW).get(rows[0].id)?.uid).toBe('shared-1')
  })

  it('marks a reminder as delivered without rewriting the row timestamp', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input())
    store.markNotified(event.id, NOW + 60_000)
    const marked = store.get(event.id)!
    expect(marked.notifiedAt).toBe(NOW + 60_000)
    // A fired reminder is not an edit: the list must not reorder or relabel.
    expect(marked.updatedAt).toBe(event.updatedAt)
    expect(new CalendarStore(file, () => NOW).get(event.id)?.notifiedAt).toBe(NOW + 60_000)

    // The timer can race a delete; an unknown id must be a no-op, not a throw.
    expect(() => store.markNotified('missing-id', NOW)).not.toThrow()
    expect(store.list()).toHaveLength(1)

    // Editing the title keeps the stamp, moving the start clears it.
    expect(store.save({ ...input(), title: '改名' }, event.id).notifiedAt).toBe(NOW + 60_000)
    expect(store.save({ ...input(), start: at(22, 10), end: at(22, 11) }, event.id).notifiedAt).toBeUndefined()
  })

  it('keeps a cancellation through a full ICS round trip', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '已取消的评审', uid: 'cancel-roundtrip' }))
    store.action(event.id, 'cancel')

    // exportIcs drops cancelled rows, so feed the schedule itself back in.
    const ics = toIcs(store.list(), NOW)
    expect(ics).toContain('STATUS:CANCELLED')
    expect(parseIcs(ics)[0].status).toBe('cancelled')

    const target = new CalendarStore(join(dir, 'imported.json'), () => NOW)
    expect(target.importIcs(ics)).toEqual({ added: 1, updated: 0, skipped: 0 })
    expect(target.list()[0].status).toBe('cancelled')
    expect(target.active()).toEqual([])

    // A later confirmed copy from the outside must not resurrect it locally.
    expect(target.importIcs(ics.replace('STATUS:CANCELLED\r\n', ''))).toEqual({ added: 0, updated: 1, skipped: 0 })
    expect(target.list()[0].status).toBe('cancelled')
    expect(target.list()[0].uid).toBe('cancel-roundtrip')
  })

  it('formats event times in both languages', () => {
    expect(formatEventTime({ start: at(21, 9) + 5 * 60_000, end: at(21, 10) + 30 * 60_000, allDay: false }, 'zh'))
      .toBe('09:05–10:30')
    expect(formatEventTime({ start: at(21, 9), end: at(21, 10), allDay: false }, 'en')).toBe('09:00–10:00')
    expect(formatEventTime({ start: at(21, 0), end: at(22, 0), allDay: true }, 'en')).toBe('All day')
    // En dash U+2013, not a hyphen: the UI and the tests agree on one separator.
    expect(formatEventTime({ start: at(21, 9), end: at(21, 10), allDay: false }, 'zh')).toContain('\u2013')
  })

  it('folds long ICS lines by UTF-8 octets without splitting a character', () => {
    const title = '长标题测试'.repeat(24)
    const ics = toIcs([{
      id: 'long-1', title, start: at(21, 10), end: at(21, 11), allDay: false,
      source: 'manual', createdAt: NOW, updatedAt: NOW, status: 'confirmed'
    }], NOW)
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(73)
    // Every continuation line starts with the single space that marks a fold.
    expect(ics.split('\r\n').filter(line => line.startsWith(' ')).length).toBeGreaterThan(1)
    expect(parseIcs(ics)[0].title).toBe(title)
    expect(parseIcs(ics)[0].start).toBe(at(21, 10))
  })

  it('sorts a copy by start and then createdAt', () => {
    const base: CalendarEvent = { id: 'a', title: 'a', start: at(21, 12), end: at(21, 13), allDay: false, source: 'manual', createdAt: NOW, updatedAt: NOW, status: 'confirmed' }
    const later = { ...base, id: 'b', createdAt: NOW + 1 }
    const earlier = { ...base, id: 'c', start: at(21, 8), createdAt: NOW + 5 }
    const rows = [later, base, earlier]
    expect(sortEvents(rows).map(row => row.id)).toEqual(['c', 'a', 'b'])
    expect(rows.map(row => row.id)).toEqual(['b', 'a', 'c'])
  })
})

/**
 * Pre-event reminders. Timers are injected, so the tests advance the clock and
 * fire the queue by hand instead of waiting — the scheduler only ever sees a
 * clock function and a `setTimer`.
 */
describe('calendar reminder scheduler', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    setMainLanguage('zh')
    dir = mkdtempSync(join(tmpdir(), 'yu-cal-'))
    file = join(dir, 'calendar.json')
  })
  afterEach(() => {
    setMainLanguage('zh')
    rmSync(dir, { recursive: true, force: true })
  })

  type SchedulerSettings = { defaultLeadMinutes: number } | { calendar: { enabled: boolean; defaultLeadMinutes: number } }

  function rig(store: CalendarStore, settings: () => SchedulerSettings = () => ({ defaultLeadMinutes: 10 })) {
    const state = { clock: NOW, fail: false }
    const delivered: { id: string; at: number }[] = []
    const logs: string[] = []
    let queued: (() => void) | null = null
    let delay: number | null = null
    const scheduler = new CalendarScheduler({
      store,
      settings,
      now: () => state.clock,
      deliver: (event, at) => {
        if (state.fail) throw new Error('no notification window')
        delivered.push({ id: event.id, at })
      },
      log: line => logs.push(line),
      setTimer: (fn, ms) => {
        queued = fn
        delay = ms
        return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {
        queued = null
        delay = null
      }
    })
    return {
      state,
      delivered,
      logs,
      scheduler,
      delay: () => delay,
      queued: () => queued,
      tick: () => {
        const fn = queued
        queued = null
        fn?.()
      }
    }
  }

  it('fires the pre-reminder at start minus the default lead', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '评审', start: at(21, 10, 30), end: at(21, 11, 30) }))
    const r = rig(store)
    r.scheduler.start()

    // 80 minutes out: the scheduler bottoms out at its polling ceiling.
    expect(r.delay()).toBe(30_000)
    expect(r.scheduler.status().nextAt).toBe(at(21, 10, 20))
    expect(r.delivered).toEqual([])

    // Inside the ceiling it wakes exactly on the trigger instead of polling.
    r.state.clock = at(21, 10, 20) - 5_000
    r.scheduler.check()
    expect(r.delay()).toBe(5_000)

    r.state.clock = at(21, 10, 20)
    r.tick()
    expect(r.delivered).toEqual([{ id: event.id, at: at(21, 10, 20) }])
    expect(store.get(event.id)?.notifiedAt).toBe(at(21, 10, 20))
    expect(r.scheduler.status().nextAt).toBeNull()
    // The chain keeps running after a delivery, for the next event of the day.
    expect(r.delay()).toBe(30_000)
    r.scheduler.stop()
  })

  it('reminds for an all-day event on the morning of its own day, not the night before', () => {
    const store = new CalendarStore(file, () => NOW)
    // An all-day row stores local midnight, so a 10-minute lead used to fire at 23:50
    // the day before: a reminder for tomorrow delivered today.
    const event = store.save(input({ title: '全天培训', allDay: true, start: at(22, 13), end: at(22, 15) }))
    const r = rig(store)
    r.scheduler.start()
    expect(r.scheduler.status().nextAt).toBe(at(22, 8, 50))

    r.state.clock = at(22, 8, 50)
    r.tick()
    expect(r.delivered).toEqual([{ id: event.id, at: at(22, 8, 50) }])
    expect(store.get(event.id)?.notifiedAt).toBe(at(22, 8, 50))
    r.scheduler.stop()
  })

  it.each([[0, 9, 0], [30, 8, 30]] as const)('anchors an all-day event at 09:00 minus a %i-minute lead', (lead, hour, minute) => {
    const store = new CalendarStore(file, () => NOW)
    store.save(input({ title: '全天培训', allDay: true, leadMinutes: lead, start: at(22, 13), end: at(22, 15) }))
    const r = rig(store)
    r.scheduler.start()
    expect(r.scheduler.status().nextAt).toBe(at(22, hour, minute))
    r.scheduler.stop()
  })

  it('stays silent when the user turned the reminder off', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '不提醒的事', leadMinutes: null, start: at(21, 10), end: at(21, 11) }))
    const r = rig(store)
    r.scheduler.start()
    expect(r.scheduler.status().nextAt).toBeNull()

    r.state.clock = at(21, 10)
    r.scheduler.check()
    expect(r.delivered).toEqual([])
    expect(store.get(event.id)?.notifiedAt).toBeUndefined()
    r.scheduler.stop()
  })

  it('honours a custom lead next to the configured default', () => {
    const store = new CalendarStore(file, () => NOW)
    const early = store.save(input({ title: '提前 90 分钟', leadMinutes: 90, start: at(21, 11), end: at(21, 12) }))
    const plain = store.save(input({ title: '用默认', start: at(21, 12), end: at(21, 13) }))
    // The nested shape `settings.ts` will expose.
    const r = rig(store, () => ({ calendar: { enabled: true, defaultLeadMinutes: 10 } }))
    r.scheduler.start()
    expect(r.scheduler.status().nextAt).toBe(at(21, 9, 30))

    r.state.clock = at(21, 9, 30)
    r.scheduler.check()
    expect(r.delivered).toEqual([{ id: early.id, at: at(21, 9, 30) }])

    r.state.clock = at(21, 11, 50)
    r.scheduler.check()
    expect(r.delivered).toEqual([
      { id: early.id, at: at(21, 9, 30) },
      { id: plain.id, at: at(21, 11, 50) }
    ])
    r.scheduler.stop()
  })

  it('never repeats a reminder that already fired', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '只响一次', start: at(21, 10), end: at(21, 11) }))
    const r = rig(store)
    r.scheduler.start()
    r.state.clock = at(21, 9, 50)
    r.scheduler.check()
    expect(r.delivered).toHaveLength(1)

    r.state.clock = at(21, 9, 55)
    r.scheduler.check()
    r.tick()
    expect(r.delivered).toHaveLength(1)

    // The stamp is on disk, so restarting the app does not re-announce either.
    const reloaded = new CalendarStore(file, () => r.state.clock)
    expect(reloaded.get(event.id)?.notifiedAt).toBe(at(21, 9, 50))
    const second = rig(reloaded)
    second.scheduler.start()
    expect(second.delivered).toEqual([])
    second.scheduler.stop()
  })

  it('re-arms the reminder when the event is rescheduled', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '改期', start: at(21, 10), end: at(21, 11) }))
    const r = rig(store)
    r.scheduler.start()
    r.state.clock = at(21, 9, 50)
    r.scheduler.check()
    expect(r.delivered).toHaveLength(1)

    const moved = store.save({ title: '改期', start: at(22, 10), end: at(22, 11) }, event.id)
    // Keeping the old stamp would silence the new time forever.
    expect(moved.notifiedAt).toBeUndefined()
    expect(r.scheduler.status().nextAt).toBe(at(22, 9, 50))

    r.state.clock = at(22, 9, 50)
    r.scheduler.check()
    expect(r.delivered).toEqual([
      { id: event.id, at: at(21, 9, 50) },
      { id: event.id, at: at(22, 9, 50) }
    ])

    // Renaming alone must not re-notify.
    expect(store.save({ title: '再改名', start: at(22, 10), end: at(22, 11) }, event.id).notifiedAt).toBe(at(22, 9, 50))
    r.scheduler.stop()
  })

  it('logs a failed delivery and retries it on the next tick', () => {
    const store = new CalendarStore(file, () => NOW)
    const event = store.save(input({ title: '重试', start: at(21, 10), end: at(21, 11) }))
    const r = rig(store)
    r.scheduler.start()
    r.state.clock = at(21, 9, 50)
    r.state.fail = true
    r.scheduler.check()
    expect(r.delivered).toEqual([])
    // No stamp, so the retry is not suppressed.
    expect(store.get(event.id)?.notifiedAt).toBeUndefined()
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toContain(event.id)
    // The exception does not break the chain.
    expect(r.delay()).toBe(30_000)

    r.state.fail = false
    r.state.clock = at(21, 9, 50) + 30_000
    r.tick()
    expect(r.delivered).toEqual([{ id: event.id, at: at(21, 9, 50) }])
    expect(store.get(event.id)?.notifiedAt).toBe(at(21, 9, 50))
    r.scheduler.stop()
  })

  it('drops a reminder for an event that already started', () => {
    const store = new CalendarStore(file, () => NOW)
    const begun = store.save(input({ title: '已经开始 10 分钟', start: at(21, 8, 50), end: at(21, 9, 50) }))
    const r = rig(store)
    r.scheduler.start()
    expect(r.delivered).toEqual([])
    expect(r.scheduler.status().nextAt).toBeNull()
    r.state.clock = NOW + 30_000
    r.scheduler.check()
    expect(r.delivered).toEqual([])
    expect(store.get(begun.id)?.notifiedAt).toBeUndefined()

    // Inside the 5 minute grace a late reminder still counts: the meeting is on.
    const justStarted = store.save(input({ title: '刚开始', start: at(21, 8, 56), end: at(21, 9, 56) }))
    r.scheduler.check()
    expect(r.delivered).toEqual([{ id: justStarted.id, at: at(21, 8, 46) }])
    r.scheduler.stop()
  })

  it('stops the chain, including a callback that was already queued', () => {
    const store = new CalendarStore(file, () => NOW)
    store.save(input({ title: '停止', start: at(21, 10), end: at(21, 11) }))
    const r = rig(store)
    r.scheduler.start()
    const queued = r.queued()
    expect(queued).not.toBeNull()

    r.state.clock = at(21, 9, 50)
    r.scheduler.stop()
    expect(r.delay()).toBeNull()
    queued?.()
    expect(r.delivered).toEqual([])
    // A stopped scheduler never re-arms itself.
    expect(r.delay()).toBeNull()
  })

  it('respects the disabled switch and both settings shapes', () => {
    const store = new CalendarStore(file, () => NOW)
    store.save(input({ title: '关闭提醒', start: at(21, 10), end: at(21, 11) }))

    const off = rig(store, () => ({ calendar: { enabled: false, defaultLeadMinutes: 10 } }))
    off.scheduler.start()
    off.state.clock = at(21, 9, 50)
    off.scheduler.check()
    expect(off.delivered).toEqual([])
    expect(off.scheduler.status().nextAt).toBeNull()
    off.scheduler.stop()

    const flat = rig(store, () => ({ defaultLeadMinutes: 30 }))
    flat.scheduler.start()
    expect(flat.scheduler.status().nextAt).toBe(at(21, 9, 30))
    flat.scheduler.stop()
  })

  it('reminds exactly at start when the lead is zero, and skips cancelled rows', () => {
    const store = new CalendarStore(file, () => NOW)
    const onTime = store.save(input({ title: '零提前量', leadMinutes: 0, start: at(21, 10), end: at(21, 11) }))
    const cancelled = store.save(input({ title: '已取消', start: at(21, 10), end: at(21, 11) }))
    store.action(cancelled.id, 'cancel')
    const r = rig(store)
    r.scheduler.start()
    expect(r.scheduler.status().nextAt).toBe(at(21, 10))

    r.state.clock = at(21, 10)
    r.scheduler.check()
    expect(r.delivered).toEqual([{ id: onTime.id, at: at(21, 10) }])
    r.scheduler.stop()
  })
})
