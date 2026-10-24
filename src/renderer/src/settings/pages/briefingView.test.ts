import { describe, expect, it } from 'vitest'
import type { BriefingRecord, BriefingSettings } from '@shared/briefing'
import { DEFAULT_BRIEFING_SETTINGS } from '@shared/briefing'
import {
  bodyLines,
  briefingHint,
  formatBriefingDay,
  formatGeneratedAt,
  groupHistory,
  isEmptyHistory,
  quietSummary
} from './briefingView'

/** Fixed clock: relative prefixes must never depend on when the suite runs. */
const NOW = new Date(2026, 9, 25, 10, 30).getTime()

const settings = (patch: Partial<BriefingSettings> = {}): BriefingSettings => ({ ...DEFAULT_BRIEFING_SETTINGS, ...patch })

const record = (dayKey: string, createdAt: number, body = '内容'): BriefingRecord => ({ dayKey, title: `${dayKey} 的简报`, body, createdAt })

describe('briefing day heading', () => {
  it('marks today and yesterday in Chinese and keeps the weekday readable', () => {
    expect(formatBriefingDay('2026-10-25', 'zh', NOW)).toBe('今天 · 10 月 25 日 周日')
    expect(formatBriefingDay('2026-10-24', 'zh', NOW)).toBe('昨天 · 10 月 24 日 周六')
  })
  it('drops the relative prefix once the day is older than yesterday', () => {
    expect(formatBriefingDay('2026-10-20', 'zh', NOW)).toBe('10 月 20 日 周二')
    expect(formatBriefingDay('2026-10-20', 'en', NOW)).toBe('Tue, Oct 20')
    expect(formatBriefingDay('2026-10-25', 'en', NOW)).toBe('Today · Sun, Oct 25')
  })
  it('shows a malformed or impossible day key as it arrived instead of guessing', () => {
    expect(formatBriefingDay('不是日期', 'zh', NOW)).toBe('不是日期')
    expect(formatBriefingDay('2026-02-31', 'zh', NOW)).toBe('2026-02-31')
    expect(formatBriefingDay('', 'en', NOW)).toBe('')
  })
})

describe('briefing history grouping', () => {
  it('lists the newest day first', () => {
    const rows = groupHistory([record('2026-10-20', 1), record('2026-10-25', 2), record('2026-10-24', 3)])
    expect(rows.map(row => row.dayKey)).toEqual(['2026-10-25', '2026-10-24', '2026-10-20'])
  })
  it('keeps one row per day and shows the newest delivery of that day', () => {
    const rows = groupHistory([record('2026-10-25', 100, '旧'), record('2026-10-25', 200, '新')])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dayKey: '2026-10-25', body: '新', createdAt: 200 })
  })
  it('drops unusable records and honours the history limit', () => {
    const rows = groupHistory([record('', 5), record('2026-10-25', 4), record('2026-10-24', 3), record('2026-10-23', 2)], 2)
    expect(rows.map(row => row.dayKey)).toEqual(['2026-10-25', '2026-10-24'])
    expect(groupHistory([record('2026-10-25', 1)], 0)).toEqual([])
  })
  it('treats an empty or junk-only list as empty', () => {
    expect(isEmptyHistory([])).toBe(true)
    expect(isEmptyHistory(null)).toBe(true)
    expect(isEmptyHistory([record('', 1)])).toBe(true)
    expect(isEmptyHistory([record('2026-10-25', 1)])).toBe(false)
  })
})

describe('briefing settings summary', () => {
  it('summarises the generation time and the quiet window', () => {
    expect(quietSummary(settings({ time: '08:00' }), 'zh')).toBe('每天 08:00 · 免打扰 22:00–07:30')
    expect(quietSummary(settings({ time: '08:00' }), 'en')).toBe('Daily 08:00 · Quiet 22:00–07:30')
  })
  it('says the quiet window is off instead of hiding it', () => {
    const off = settings({ time: '06:30', quietHours: { enabled: false, start: '22:00', end: '07:30' } })
    expect(quietSummary(off, 'zh')).toBe('每天 06:30 · 免打扰已关闭')
    expect(quietSummary(off, 'en')).toBe('Daily 06:30 · Quiet hours off')
  })
  it('falls back to the default clock for junk stored in settings', () => {
    expect(quietSummary(settings({ time: '25:99' }), 'zh')).toBe('每天 08:00 · 免打扰 22:00–07:30')
  })
  it('tells the reader where to turn a disabled briefing back on', () => {
    expect(briefingHint(settings({ enabled: true, time: '08:00' }), 'zh')).toBe('每天 08:00 自动生成')
    expect(briefingHint(settings({ enabled: false }), 'zh')).toBe('简报已关闭，到点在设置里打开')
    expect(briefingHint(settings({ enabled: false }), 'en')).toBe('Off. Turn it on in Settings when you want it.')
  })
})

describe('briefing body rendering', () => {
  it('keeps line breaks, collapses blank runs and trims the edges', () => {
    expect(bodyLines('\n\n上午 3 件事\n\n\n\n下午 1 件事\n\n')).toEqual(['上午 3 件事', '', '下午 1 件事'])
  })
  it('normalises CRLF and renders an empty body as no lines at all', () => {
    expect(bodyLines('甲\r\n乙')).toEqual(['甲', '乙'])
    expect(bodyLines('')).toEqual([])
    expect(bodyLines('   \n\n  ')).toEqual([])
  })
})

describe('briefing timestamps', () => {
  it('formats the generation time in both languages', () => {
    const at = new Date(2026, 9, 25, 8, 5).getTime()
    expect(formatGeneratedAt(at, 'zh')).toBe('10 月 25 日 08:05')
    expect(formatGeneratedAt(at, 'en')).toBe('Oct 25, 08:05')
  })
  it('renders nothing for a missing timestamp', () => {
    expect(formatGeneratedAt(0, 'zh')).toBe('')
    expect(formatGeneratedAt(Number.NaN, 'zh')).toBe('')
  })
})
