import { describe, expect, it, vi } from 'vitest'
import { composeBriefing, narrateBriefing, type BriefingData } from './briefing'

/** 2026-08-25 08:00 local, so the fixture does not depend on the runner's zone. */
const NOW = new Date(2026, 7, 25, 8, 0).getTime()
const at = (day: number, hour: number): number => new Date(2026, 7, day, hour).getTime()

/** A day with real content, so `narrateBriefing` actually calls the provider. */
const busyDay: BriefingData = {
  now: NOW,
  language: 'zh',
  events: [{ id: 'e1', title: '项目讨论', start: at(25, 14), end: at(25, 15), allDay: false }],
  tasks: [{ id: 't1', title: '交周报', dueAt: at(25, 16) }],
  overdue: [],
  tomorrow: []
}

const narration = (): string => '今天下午两点项目讨论，四点前把周报交上去，两件事都别拖到晚上。'.padEnd(140, '好')

describe('narrateBriefing owns its own ceiling', () => {
  it('returns the template when the provider never settles its promise', async () => {
    const log = vi.fn()
    // A provider that ignores `signal` entirely: the exact hazard the race exists
    // for, because the scheduler in the main process only clears `settling` when
    // this promise settles.
    const ask = vi.fn(() => new Promise<string>(() => {}))
    const started = Date.now()
    const briefing = await narrateBriefing(busyDay, { ask, timeoutMs: 30, log })
    expect(Date.now() - started).toBeLessThan(230)
    expect(briefing.source).toBe('template')
    expect(briefing.body).toBe(composeBriefing(busyDay).body)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('narration failed'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })
  it('aborts the signal it handed out, so a provider that does listen can stop', async () => {
    const handed: { signal?: AbortSignal } = {}
    const ask = (_prompt: string, options: { signal: AbortSignal }) => {
      handed.signal = options.signal
      return new Promise<string>(() => {})
    }
    const briefing = await narrateBriefing(busyDay, { ask, timeoutMs: 20 })
    expect(briefing.source).toBe('template')
    expect(handed.signal?.aborted).toBe(true)
  })
  it('still ships a narration that arrives inside the ceiling', async () => {
    const briefing = await narrateBriefing(busyDay, { ask: async () => narration(), timeoutMs: 2000 })
    expect(briefing.source).toBe('model')
    expect(briefing.body).toBe(narration())
  })
})
