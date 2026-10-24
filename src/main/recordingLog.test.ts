import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordingLog } from './recordingLog'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'qinly-recordings-')); recordingLog.configure(directory); vi.useFakeTimers() })
afterEach(() => { recordingLog.configure(null); vi.useRealTimers(); rmSync(directory, { recursive: true }) })
it('reads real timestamps, mode and application from the existing JSONL format', () => {
  const startedAt = Date.parse('2026-10-24T09:42:11.123Z')
  vi.setSystemTime(startedAt)
  recordingLog.begin({ mode: 'dictation', appName: 'Feishu', windowTitle: 'Team chat' })
  vi.advanceTimersByTime(2500)
  recordingLog.end({ status: 'done', chars: 12 })
  expect(recordingLog.list()[0]).toMatchObject({ startedAt, endedAt: startedAt + 2500, mode: 'dictation', appName: 'Feishu', windowTitle: 'Team chat', status: 'done' })
})
it('reports newest takes in order and leaves an active take unfinished', () => {
  vi.setSystemTime(new Date('2026-10-24T09:42:11Z'))
  recordingLog.begin({ mode: 'translate', appName: 'Code', windowTitle: 'Editor' })
  recordingLog.end({ status: 'cancelled' })
  vi.advanceTimersByTime(60000)
  recordingLog.begin({ mode: 'ask', appName: 'Chrome', windowTitle: 'Page' })
  const rows = recordingLog.list()
  expect(rows.map(row => row.mode)).toEqual(['ask', 'translate'])
  expect(rows[0].endedAt).toBeNull()
  expect(rows[0].startedAt - rows[1].startedAt).toBe(60000)
})
it('notifies the interface after starts, ends and clears and removes disposed subscribers', () => {
  const listener = vi.fn(), off = recordingLog.onChanged(listener)
  recordingLog.begin({ mode: 'ask', appName: 'Code', windowTitle: 'Editor' })
  recordingLog.end({ status: 'done' })
  recordingLog.clear()
  expect(listener).toHaveBeenCalledTimes(3)
  off(); recordingLog.begin({ mode: 'dictation', appName: 'Code', windowTitle: 'Editor' })
  expect(listener).toHaveBeenCalledTimes(3)
})
