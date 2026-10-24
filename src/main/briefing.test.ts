import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BRIEFING_SETTINGS, briefingDayKey, composeBriefing, nextBriefingAt, normalizeBriefingSettings, normalizeBriefingTime } from '@shared/briefing'
import type { Briefing, BriefingData, BriefingSettings } from '@shared/briefing'
import { BriefingScheduler } from './briefing'
import type { BriefingState } from './briefing'

/** 2026-08-25 08:00 local, so every expectation stays timezone independent. */
const NOW = new Date(2026, 7, 25, 8, 0).getTime()
const SLOT = new Date(2026, 7, 25, 8, 0).getTime()
const at = (day: number, hour: number, minute = 0, month = 7, year = 2026): number => new Date(year, month, day, hour, minute).getTime()

const data = (overrides: Partial<BriefingData> = {}): BriefingData =>
  ({ now: NOW, language: 'zh', events: [], tasks: [], overdue: [], tomorrow: [], ...overrides })

const fullZh = (): Partial<BriefingData> => ({
  events: [
    { id: 'e2', title: '评审', start: at(25, 16), end: at(25, 17), allDay: false },
    { id: 'e1', title: '项目讨论', start: at(25, 14), end: at(25, 15), allDay: false }
  ],
  tasks: [{ id: 't1', title: '交周报', dueAt: at(25, 16, 30), level: 'strong' }],
  overdue: [{ id: 't2', title: '体检', dueAt: at(24, 18), overdue: true }],
  tomorrow: [{ id: 'e3', title: '面试', start: at(26, 10), end: at(26, 11), allDay: false }],
  stats: { entries: 12, characters: 860, durationMs: 4200 }
})

const fullEn = (): Partial<BriefingData> => ({
  language: 'en',
  events: [
    { id: 'e2', title: 'Design review', start: at(25, 16), end: at(25, 17), allDay: false },
    { id: 'e1', title: 'Project sync', start: at(25, 14), end: at(25, 15), allDay: false }
  ],
  tasks: [{ id: 't1', title: 'File the weekly report', dueAt: at(25, 16, 30) }],
  overdue: [{ id: 't2', title: 'Medical checkup', dueAt: at(24, 18) }],
  tomorrow: [{ id: 'e3', title: 'Interview', start: at(26, 10), end: at(26, 11), allDay: false }],
  stats: { entries: 12, characters: 860, durationMs: 4200 }
})

describe('briefing settings', () => {
  it('pads valid clock values', () => {
    expect(normalizeBriefingTime('8:5')).toBe('08:05')
    expect(normalizeBriefingTime('14:00')).toBe('14:00')
    expect(normalizeBriefingTime(' 7:30 ')).toBe('07:30')
  })
  it.each(['25:00', '12:60', '', '8', 'morning', 800, null, undefined])('rejects usable-but-wrong clock value %s', value => {
    expect(normalizeBriefingTime(value)).toBe('08:00')
  })
  it('fills missing flags and keeps the ones it is given', () => {
    expect(normalizeBriefingSettings(undefined)).toEqual(DEFAULT_BRIEFING_SETTINGS)
    expect(normalizeBriefingSettings({ enabled: true, time: '7:5' })).toEqual({ enabled: true, time: '07:05', speak: false, notify: true, skipEmpty: true })
    expect(normalizeBriefingSettings({ enabled: 'yes', skipEmpty: false })).toMatchObject({ enabled: false, skipEmpty: false })
  })
})

describe('nextBriefingAt', () => {
  it('stays on today while the slot is still ahead', () => {
    expect(nextBriefingAt(NOW, '09:30')).toBe(at(25, 9, 30))
    expect(nextBriefingAt(NOW, '08:01')).toBe(at(25, 8, 1))
  })
  it('rolls to tomorrow once the slot has passed', () => {
    expect(nextBriefingAt(NOW, '07:00')).toBe(at(26, 7))
    expect(nextBriefingAt(SLOT, '08:00')).toBe(at(26, 8))
  })
  it('crosses a month boundary', () => {
    expect(nextBriefingAt(at(31, 9), '08:00')).toBe(new Date(2026, 8, 1, 8, 0).getTime())
  })
  it('crosses a year boundary', () => {
    expect(nextBriefingAt(new Date(2026, 11, 31, 9, 0).getTime(), '08:00')).toBe(new Date(2027, 0, 1, 8, 0).getTime())
  })
  it('derives local day keys', () => {
    expect(briefingDayKey(at(5, 0, 7))).toBe('2026-08-05')
  })
})

describe('composeBriefing', () => {
  it('assembles every Chinese section in order', () => {
    const briefing = composeBriefing(data(fullZh()))
    expect(briefing.title).toBe('8 月 25 日 · 今日简报')
    expect(briefing.language).toBe('zh')
    expect(briefing.empty).toBe(false)
    expect(briefing.sections).toEqual([
      '今天\n- 14:00–15:00 项目讨论\n- 16:00–17:00 评审',
      '待办\n- 16:30 交周报',
      '已经过期\n- 昨天 18:00 体检（已逾期）',
      '明天\n- 10:00 面试',
      '回顾\n昨天听写 12 条、共 860 字。'
    ])
    expect(briefing.body).toBe(briefing.sections.join('\n\n'))
  })
  it('assembles the same data in English without mixing languages', () => {
    const briefing = composeBriefing(data(fullEn()))
    expect(briefing.title).toBe('Aug 25 · Daily briefing')
    expect(briefing.sections).toEqual([
      'Today\n- 14:00–15:00 Project sync\n- 16:00–17:00 Design review',
      'To do\n- 16:30 File the weekly report',
      'Overdue\n- Yesterday 18:00 Medical checkup (overdue)',
      'Tomorrow\n- 10:00 Interview',
      'Recap\nYesterday: 12 notes, 860 characters.'
    ])
  })
  it('reports an empty day in one sentence', () => {
    const zh = composeBriefing(data())
    expect(zh).toMatchObject({ sections: [], empty: true, body: '今天没有安排。', title: '8 月 25 日 · 今日简报' })
    expect(composeBriefing(data({ language: 'en' }))).toMatchObject({ sections: [], empty: true, body: 'Nothing scheduled for today.', title: 'Aug 25 · Daily briefing' })
  })
  it('writes all-day events without a clock range', () => {
    const briefing = composeBriefing(data({ events: [{ id: 'e1', title: '团建', start: at(25, 0), end: at(26, 0), allDay: true }] }))
    expect(briefing.sections).toEqual(['今天\n- 全天 团建'])
  })
  it('sorts events by start regardless of input order', () => {
    const briefing = composeBriefing(data({
      events: [
        { id: 'c', title: 'C', start: at(25, 18), end: at(25, 19), allDay: false },
        { id: 'a', title: 'A', start: at(25, 9), end: at(25, 10), allDay: false },
        { id: 'b', title: 'B', start: at(25, 13), end: at(25, 14), allDay: false }
      ]
    }))
    expect(briefing.sections[0]).toBe('今天\n- 09:00–10:00 A\n- 13:00–14:00 B\n- 18:00–19:00 C')
  })
})

interface Harness {
  clock: { now: number }
  scheduler: BriefingScheduler
  settings: { value: BriefingSettings | { briefing: BriefingSettings } }
  deliver: ReturnType<typeof vi.fn>
  compose: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  saved: BriefingState[]
  state: BriefingState
  timers: Map<number, () => void>
  delays: number[]
  run: (advanceMs?: number) => void
}

function harness(options: { now?: number; settings?: BriefingSettings | { briefing: BriefingSettings }; briefing?: Briefing; state?: BriefingState } = {}): Harness {
  const clock = { now: options.now ?? SLOT - 60_000 }
  const timers = new Map<number, () => void>()
  const delays: number[] = []
  const saved: BriefingState[] = []
  const state: BriefingState = { ...options.state }
  const briefing = options.briefing ?? { title: '简报', body: '正文', sections: ['今天\n- 全天 团建'], empty: false, language: 'zh' as const }
  const deliver = vi.fn()
  const compose = vi.fn(() => briefing)
  const log = vi.fn()
  const settings = { value: options.settings ?? { ...DEFAULT_BRIEFING_SETTINGS, enabled: true } }
  let handle = 0
  const scheduler = new BriefingScheduler({
    settings: () => settings.value,
    now: () => clock.now,
    compose,
    deliver,
    load: () => state,
    save: next => {
      Object.assign(state, next)
      saved.push(next)
    },
    log,
    setTimer: (fn, ms) => {
      delays.push(ms)
      timers.set(++handle, fn)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: timer => {
      timers.delete(timer as unknown as number)
    }
  })
  const run = (advanceMs = 0): void => {
    clock.now += advanceMs
    const pending = [...timers.values()]
    timers.clear()
    for (const fn of pending) fn()
  }
  return { clock, scheduler, settings, deliver, compose, log, saved, state, timers, delays, run }
}

describe('BriefingScheduler', () => {
  it('does not arm anything while the briefing is disabled', () => {
    const h = harness({ settings: { ...DEFAULT_BRIEFING_SETTINGS, enabled: false } })
    h.scheduler.start()
    expect(h.timers.size).toBe(0)
    expect(h.scheduler.status()).toEqual({ enabled: false, nextAt: null, lastDay: undefined })
    expect(h.deliver).not.toHaveBeenCalled()
  })
  it('delivers once when the slot arrives and records the day', () => {
    const h = harness({ now: SLOT - 60_000 })
    h.scheduler.start()
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.scheduler.status().nextAt).toBe(SLOT)
    h.run(60_000)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver.mock.calls[0][1]).toBe(SLOT)
    expect(h.state.lastDay).toBe('2026-08-25')
    expect(h.saved).toHaveLength(1)
  })
  it('does not deliver twice on the same day', () => {
    const h = harness({ now: SLOT })
    h.scheduler.start()
    h.run(30_000)
    h.scheduler.check()
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.scheduler.status().nextAt).toBe(at(26, 8))
  })
  it('keeps the day open when delivery throws, then retries successfully', () => {
    const h = harness({ now: SLOT })
    h.deliver.mockImplementationOnce(() => {
      throw new Error('speaker busy')
    })
    h.scheduler.start()
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.saved).toHaveLength(0)
    expect(h.scheduler.status().lastDay).toBeUndefined()
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('speaker busy'))
    h.run(30_000)
    expect(h.deliver).toHaveBeenCalledTimes(2)
    expect(h.scheduler.status().lastDay).toBe('2026-08-25')
  })
  it('targets tomorrow when today was already sent', () => {
    const h = harness({ now: SLOT, state: { lastDay: '2026-08-25' } })
    h.scheduler.start()
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.scheduler.status()).toEqual({ enabled: true, nextAt: at(26, 8), lastDay: '2026-08-25' })
  })
  it('retargets tomorrow once the briefing time moves later today', () => {
    const h = harness({ now: SLOT, state: { lastDay: '2026-08-25' } })
    h.scheduler.start()
    h.settings.value = { ...DEFAULT_BRIEFING_SETTINGS, enabled: true, time: '20:00' }
    h.scheduler.check()
    expect(h.scheduler.status().nextAt).toBe(at(26, 20))
  })
  it('stops arming timers after stop(), including a queued callback', () => {
    const h = harness({ now: SLOT - 60_000 })
    h.scheduler.start()
    const queued = [...h.timers.values()][0]
    h.scheduler.stop()
    expect(h.timers.size).toBe(0)
    expect(h.scheduler.status().nextAt).toBeNull()
    h.clock.now = SLOT
    queued()
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.timers.size).toBe(0)
  })
  it('caps the poll interval so a resume after sleep cannot skip the day', () => {
    const h = harness({ now: SLOT - 10 * 60_000 })
    h.scheduler.start()
    expect(h.delays[0]).toBe(30_000)
    expect(h.scheduler.status().nextAt).toBe(SLOT)
  })
  it('recovers a slot that elapsed while the app was asleep', () => {
    const h = harness({ now: at(25, 11) })
    h.scheduler.start()
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver.mock.calls[0][1]).toBe(at(25, 11))
  })
  it('skips an empty briefing but still marks the day', () => {
    const h = harness({ now: SLOT, briefing: { title: '简报', body: '今天没有安排。', sections: [], empty: true, language: 'zh' } })
    h.scheduler.start()
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledWith('briefing: nothing scheduled')
    expect(h.scheduler.status().lastDay).toBe('2026-08-25')
  })
  it('delivers an empty briefing when skipEmpty is off', () => {
    const h = harness({ now: SLOT, settings: { ...DEFAULT_BRIEFING_SETTINGS, enabled: true, skipEmpty: false },
      briefing: { title: '简报', body: '今天没有安排。', sections: [], empty: true, language: 'zh' } })
    h.scheduler.start()
    expect(h.deliver).toHaveBeenCalledTimes(1)
  })
  it('accepts settings nested under briefing', () => {
    const h = harness({ now: SLOT, settings: { briefing: { ...DEFAULT_BRIEFING_SETTINGS, enabled: true, time: '08:00' } } })
    h.scheduler.start()
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.scheduler.status().enabled).toBe(true)
  })
  it('stops the timer chain when settings are switched off mid-flight', () => {
    const h = harness({ now: SLOT - 60_000 })
    h.scheduler.start()
    h.settings.value = { ...DEFAULT_BRIEFING_SETTINGS }
    h.scheduler.check()
    expect(h.timers.size).toBe(0)
    expect(h.scheduler.status()).toEqual({ enabled: false, nextAt: null, lastDay: undefined })
  })
})
