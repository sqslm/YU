import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  addToStats,
  appLabel,
  contributionOf,
  emptyStats,
  isUsageEntry,
  sanitizeStats,
  statsDayKey,
  statsFromEntries
} from './stats'

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'id-1',
    createdAt: new Date(2026, 9, 19, 12, 0, 0).getTime(),
    mode: 'dictation',
    transcript: '你好世界',
    final: '你好世界',
    durationMs: 4000,
    app: '与 Typeless 的差距 — DeepSeek Harness',
    ...overrides
  }
}

describe('contributionOf', () => {
  it('measures speech from ASR, never from a long generated answer', () => {
    const { totals } = contributionOf(entry({ mode: 'ask', transcript: '总结新闻', final: '新闻'.repeat(500), durationMs: 4000 }))
    expect(totals.measuredUnits).toBe(4)
    expect(totals.measuredMs).toBe(4000)
    expect(totals.savedMs).toBe(0)
  })
  it('does not roll invalid dates or unbounded durations into usage', () => {
    const stats = statsFromEntries([entry({ createdAt: NaN }), entry({ durationMs: Infinity })])
    expect(Object.keys(stats.days)).not.toContain('NaN-NaN-NaN')
    expect(stats.days['2026-10-19'].usedMs).toBe(0)
  })
  it('splits one usable take into the counters the page reads', () => {
    const { day, totals, app } = contributionOf(entry())

    expect(day).toBe('2026-10-19')
    expect(totals.entries).toBe(1)
    expect(totals.len).toBe(4)
    expect(totals.ms).toBe(4000)
    expect(totals.used).toBe(1)
    expect(totals.records).toBe(1)
    expect(totals.units).toBe(4)
    expect(totals.chars).toBe(4)
    expect(totals.usedMs).toBe(4000)
    expect(totals.measured).toBe(1)
    expect(totals.measuredMs).toBe(4000)
    // Typing four characters takes 6 s at 40 wpm; the take took 4 s.
    expect(totals.savedMs).toBe(2000)
    // The window title is stored, the app name is its trailing segment.
    expect(app).toBe('DeepSeek Harness')
  })

  it('counts a failed take in the chart figures but never as usage', () => {
    const { totals, app } = contributionOf(
      entry({ status: 'error', final: '', transcript: '', durationMs: 900 })
    )

    expect(totals.entries).toBe(1)
    expect(totals.ms).toBe(900)
    expect(totals.used).toBe(0)
    expect(totals.records).toBe(0)
    expect(totals.measured).toBe(0)
    expect(app).toBeNull()
  })

  it('keeps a take shorter than a second out of the rate sample', () => {
    const { totals } = contributionOf(entry({ durationMs: 400 }))

    expect(totals.records).toBe(1)
    expect(totals.usedMs).toBe(400)
    expect(totals.measured).toBe(0)
    expect(totals.savedMs).toBe(0)
  })

  it('drops language names that are not apps', () => {
    expect(appLabel({ app: '中文' })).toBe('')
    expect(appLabel({ app: 'Code.exe' })).toBe('Code')
    expect(appLabel({ app: '' })).toBe('')
  })
})

describe('addToStats', () => {
  it('accumulates days, records and the newest usable timestamp', () => {
    const stats = emptyStats()
    const first = entry()
    const second = entry({
      id: 'id-2',
      createdAt: new Date(2026, 9, 19, 18, 0, 0).getTime(),
      final: '一二',
      transcript: '一二'
    })
    const failed = entry({
      id: 'id-3',
      createdAt: new Date(2026, 9, 20, 9, 0, 0).getTime(),
      status: 'error',
      final: ''
    })

    addToStats(stats, first)
    addToStats(stats, second)
    addToStats(stats, failed)

    expect(Object.keys(stats.days).sort()).toEqual(['2026-10-19', '2026-10-20'])
    expect(stats.days['2026-10-19'].entries).toBe(2)
    expect(stats.days['2026-10-19'].records).toBe(2)
    expect(stats.days['2026-10-20'].entries).toBe(1)
    expect(stats.days['2026-10-20'].records).toBe(0)
    // The failed take is the newest row but not the newest *usage*.
    expect(stats.lastAt).toBe(second.createdAt)
    expect(stats.records).toBe(2)
    expect(stats.apps['DeepSeek Harness']).toBe(2)
  })

  it('rebuilds an identical file from the rows that produced it', () => {
    const rows = [entry(), entry({ id: 'b', createdAt: entry().createdAt + 7200000 })]
    expect(statsFromEntries(rows)).toEqual(statsFromEntries(rows))
    expect(statsFromEntries(rows).days[statsDayKey(entry().createdAt)].entries).toBe(2)
  })
})

describe('isUsageEntry', () => {
  it('treats missing status as completed and drops error/empty', () => {
    expect(isUsageEntry({})).toBe(true)
    expect(isUsageEntry({ status: 'completed' })).toBe(true)
    expect(isUsageEntry({ status: 'error' })).toBe(false)
    expect(isUsageEntry({ status: 'empty' })).toBe(false)
    expect(isUsageEntry({ status: 'dismissed' })).toBe(false)
    expect(isUsageEntry({ status: 'archived', archivedStatus: 'error' })).toBe(false)
  })
})

describe('sanitizeStats', () => {
  it('rejects impossible dates and non-integer counters and never trusts old output-based pace as ASR', () => {
    const stats = sanitizeStats({ days: {
      '2026-02-30': { entries: 1 },
      '2026-10-29': { entries: 2, units: Infinity, ms: -4, inputUnits: 3.5, inputMs: 4000, measuredUnits: 10000, measuredMs: 1000 }
    } })
    expect(Object.keys(stats.days)).toEqual(['2026-10-29'])
    expect(stats.days['2026-10-29']).toMatchObject({ units: 0, ms: 0, inputUnits: 0, inputMs: 0 })
  })
  it('keeps real counters and drops hand-edited rubbish', () => {
    const clean = sanitizeStats({
      version: 1,
      records: 7,
      lastAt: 1234,
      days: {
        '2026-10-19': { entries: 3, len: 30, ms: 9000, used: 2, records: 2, usedMs: 8000, units: 20 },
        'not-a-day': { entries: 4 },
        '2026-10-20': { entries: 0 }
      },
      apps: { 'DeepSeek Harness': 5, '': 2 }
    })

    expect(Object.keys(clean.days)).toEqual(['2026-10-19'])
    expect(clean.days['2026-10-19'].entries).toBe(3)
    // Missing fields degrade to zero instead of NaN.
    expect(clean.days['2026-10-19'].chars).toBe(0)
    expect(clean.days['2026-10-19'].savedMs).toBe(0)
    expect(clean.apps).toEqual({ 'DeepSeek Harness': 5 })
    expect(clean.records).toBe(7)
  })

  it('returns an empty rollup for anything that is not an object', () => {
    expect(sanitizeStats(null)).toEqual(emptyStats())
    expect(sanitizeStats('nope')).toEqual(emptyStats())
  })
})
