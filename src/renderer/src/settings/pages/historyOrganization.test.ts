import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { historyDateBounds, historyDateView, historyNote, historySources, emptyStateKind } from './historyView'
const at = (day: number, hour = 0): number => new Date(2026, 9, day, hour).getTime()
const row = (id: string, createdAt: number): HistoryEntry => ({ id, createdAt, mode: 'ask', transcript: 'Question', final: '**Answer** [1][3]', durationMs: 1200, app: 'Editor' })

describe('history date filtering and ordering', () => {
  it('uses whole local days, including the last selected day and excluding the next day', () => {
    expect(historyDateBounds('today', '', '', at(23, 12))).toEqual({ start: at(23), end: at(24) })
    expect(historyDateBounds('week', '', '', at(23, 12))).toEqual({ start: at(17), end: at(24) })
    expect(historyDateBounds('month', '', '', at(23, 12))).toEqual({ start: new Date(2026, 8, 24).getTime(), end: at(24) })
    const entries = [row('before', at(22)), row('start', at(23)), row('end', at(24) - 1), row('next', at(24))]
    expect(historyDateView(entries, historyDateBounds('custom', '2026-10-23', '2026-10-23'), 'oldest').map(r => r.id)).toEqual(['start', 'end'])
  })
  it('supports open bounds, leap days and year boundaries, and rejects reversed or impossible dates', () => {
    expect(historyDateBounds('custom', '2024-02-29', '')).toEqual({ start: new Date(2024, 1, 29).getTime(), end: Infinity })
    expect(historyDateBounds('custom', '', '2026-12-31')).toEqual({ start: -Infinity, end: new Date(2027, 0, 1).getTime() })
    expect(historyDateBounds('custom', '2026-02-29', '').error).toBeTruthy()
    expect(historyDateBounds('custom', '2026-10-24', '2026-10-23').error).toBeTruthy()
    expect(historyDateBounds('custom').error).toBeTruthy()
    expect(emptyStateKind({ matches: 0, query: '', filter: 'all', dateFiltered: true })).toBe('date')
  })
  it('sorts without mutating loaded data and keeps equal-time records stable', () => {
    const entries = [row('recent', at(23)), row('old-a', at(22)), row('old-b', at(22))]
    const snapshot = structuredClone(entries), bounds = historyDateBounds('all')
    expect(historyDateView(entries, bounds, 'oldest').map(r => r.id)).toEqual(['old-a', 'old-b', 'recent'])
    expect(historyDateView(entries, bounds, 'newest').map(r => r.id)).toEqual(['recent', 'old-a', 'old-b'])
    expect(entries).toEqual(snapshot)
  })
})

it('preserves all safe source numbers and note content without local paths or model metadata', () => {
  const entry = { ...row('one', at(23)), appPath: 'private.exe', audioPath: 'private.wav', providerName: 'Private provider', sources: [
    { title: '<One>', url: 'https://example.com/one', snippet: 'private snippet' },
    { title: 'Unsafe', url: 'javascript:alert(1)', snippet: '' },
    { title: 'Three', url: 'https://example.com/three', snippet: '' }
  ] }
  expect(historySources(entry.sources).map(r => r.number)).toEqual([1, 3])
  const note = historyNote(entry)
  expect(note).toContain(entry.final); expect(note).toContain(entry.transcript)
  expect(note).toContain('1. \\<One\\>'); expect(note).toContain('3. Three')
  for (const value of ['javascript:', 'private.exe', 'private.wav', 'Private provider', 'private snippet']) expect(note).not.toContain(value)
})
