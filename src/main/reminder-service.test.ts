import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings } from '@shared/defaults'
import type { ReminderDraft } from '@shared/reminders'
const mock = vi.hoisted(() => ({ notices: [] as Array<any>, windows: [] as Array<any>, extract: vi.fn(), handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Notification extends EventEmitter { static isSupported = () => true; show = vi.fn(); close = vi.fn(); constructor(public options: unknown) { super(); mock.notices.push(this) } }
  return { Notification, ipcMain: { handle: (id: string, callback: any) => mock.handlers.set(id, callback), on: vi.fn() } }
})
vi.mock('./reminder-parser', () => ({ extractReminders: mock.extract }))
vi.mock('./windows', () => ({ createReminderWindow: () => {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send: vi.fn() }, close: vi.fn(), destroy: vi.fn() })
  mock.windows.push(win); return win
} }))
import { ReminderService } from './reminder-service'
const dirs: string[] = []
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'typeless-reminder-service-')); dirs.push(dir)
  const open = vi.fn(), changed = vi.fn(), settings = mergeSettings({})
  const service = new ReminderService(join(dir, 'reminders.sqlite'), () => settings, open, changed, vi.fn())
  return { service, open, settings, changed }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); vi.useRealTimers(); vi.clearAllMocks(); mock.notices.length = 0; mock.windows.length = 0; mock.handlers.clear() })
const draft = (overrides: Partial<ReminderDraft> = {}): ReminderDraft => ({ title: 'Clean up', intent: 'create_reminder', level: 'normal', time_expression: 'in 20 minutes', dueAt: Date.now() + 1200000, rule: null, recurrence: null, needs_confirmation: false, ...overrides })
describe('shared reminder delivery and entry points', () => {
  it('passes a one-time snooze duration through IPC without changing the configured default', () => {
    vi.useFakeTimers(); const now = Date.now()
    const { service, settings } = harness()
    try {
      settings.reminders.snoozeMinutes = 10
      service.registerIpc({ list: () => ({ notes: [] }) } as never)
      const row = service.save({ title: 'Task', dueAt: now + 60000, level: 'normal', source: 'manual', recurrence: null })
      mock.handlers.get('reminders:action')!(null, row.id, 'snooze', 15)
      expect(service.store.get(row.id)?.dueAt).toBe(now + 900000)
      mock.handlers.get('reminders:action')!(null, row.id, 'snooze')
      expect(service.store.get(row.id)?.dueAt).toBe(now + 600000)
      expect(settings.reminders.snoozeMinutes).toBe(10)
      service.action(row.id, 'cancel'); service.action(row.id, 'restore')
      expect(service.store.get(row.id)?.status).toBe('pending')
    } finally { service.stop() }
  })
  it('uses the nonblank note text when the transcript contains only whitespace', async () => {
    const { service } = harness()
    try {
      service.registerIpc({ list: () => ({ notes: [{ id: 'blank-note', transcript: '  \n ', polished: 'Call tomorrow at 10 AM' }] }) } as never)
      mock.extract.mockResolvedValue([draft()])
      await mock.handlers.get('reminders:extract-note')!(null, 'blank-note')
      expect(mock.extract.mock.calls[0][1]).toBe('Call tomorrow at 10 AM')
    } finally { service.stop() }
  })
  it.each(['deleted', 'edited'])('does not open stale extraction when the note was %s during parsing', async change => {
    const { service, open } = harness()
    let notes = [{ id: 'changing-note', transcript: 'Call tomorrow at 10 AM', polished: '' }]
    try {
      service.registerIpc({ list: () => ({ notes }) } as never)
      mock.extract.mockImplementationOnce(async () => {
        notes = change === 'deleted' ? [] : [{ ...notes[0], transcript: 'Cancel that call' }]
        return [draft()]
      })
      await expect(mock.handlers.get('reminders:extract-note')!(null, 'changing-note')).rejects.toThrow()
      expect(open).not.toHaveBeenCalled()
      expect(service.store.list()).toHaveLength(0)
    } finally { service.stop() }
  })
  it('creates an explicit voice reminder once with a working undo', async () => {
    const { service, open } = harness()
    try {
      mock.extract.mockResolvedValue([draft()]); const response = await service.voice('Remind me in twenty minutes to clean up', new AbortController().signal)
      expect(response.undo).toBe(true); expect(service.store.list()).toHaveLength(1); expect(open).not.toHaveBeenCalled()
      service.undo(); expect(service.store.list()).toHaveLength(0)
    } finally { service.stop() }
  })
  it('opens an editor for missing time, never saves a guess, and ignores ordinary statements', async () => {
    const { service, open } = harness()
    try {
      mock.extract.mockResolvedValue([draft({ dueAt: null, needs_confirmation: true })]); await service.voice('Remind me to call', new AbortController().signal)
      expect(service.store.list()).toHaveLength(0); expect(open).toHaveBeenCalledOnce()
      mock.extract.mockResolvedValue([draft({ intent: 'possible' })]); await expect(service.voice('Maybe I will call tomorrow', new AbortController().signal)).rejects.toThrow()
      mock.extract.mockRejectedValue(new Error('LLM unavailable')); await expect(service.voice('Remind me', new AbortController().signal)).rejects.toThrow('LLM unavailable')
      expect(service.store.list()).toHaveLength(0)
    } finally { service.stop() }
  })
  it('saves an explicit untimed todo without requiring a notification time and can undo it', async () => {
    const { service, open } = harness()
    try {
      mock.extract.mockResolvedValue([draft({ intent: 'todo', dueAt: null, time_expression: null })])
      const result = await service.voice('添加待办：检查数据库备份', new AbortController().signal)
      expect(result).toMatchObject({ undo: true, reminder: { dueAt: null, status: 'pending' } })
      expect(service.store.list()).toHaveLength(1); expect(open).not.toHaveBeenCalled()
      service.undo(); expect(service.store.list()).toHaveLength(0)
    } finally { service.stop() }
  })
  it('does not persist a cancelled parser response', async () => {
    const { service } = harness(), controller = new AbortController()
    try { mock.extract.mockResolvedValue([draft()]); controller.abort(); await expect(service.voice('提醒我', controller.signal)).rejects.toThrow(); expect(service.store.list()).toHaveLength(0) }
    finally { service.stop() }
  })
  it('keeps refinement details when saving and reports a withdrawn request without an error or record', async () => {
    const { service, open } = harness(), progress = vi.fn()
    try {
      mock.extract.mockResolvedValueOnce([draft({ description: 'Ask whether the repair is complete; do not replace parts yet.' })])
      await service.voice('Remind me to call', new AbortController().signal, progress)
      expect(service.store.list()[0].description).toBe('Ask whether the repair is complete; do not replace parts yet.')
      expect(mock.extract.mock.calls[0][4]).toBe(progress)
      mock.extract.mockResolvedValueOnce([])
      await expect(service.voice('Never mind, cancel that', new AbortController().signal)).resolves.toEqual({ message: '没有可创建的提醒，本次未保存' })
      expect(service.store.list()).toHaveLength(1); expect(open).not.toHaveBeenCalled()
    } finally { service.stop() }
  })
  it('reviews a to-do from the explicit reminder entry instead of dropping it', async () => {
    const { service, open } = harness()
    try {
      mock.extract.mockResolvedValue([draft({ intent: 'todo' })])
      await expect(service.voice('Clean up in 20 minutes', new AbortController().signal)).resolves.toEqual({ message: '请确认提醒事项与时间' })
      expect(open).toHaveBeenCalledWith({ drafts: [expect.objectContaining({ intent: 'todo' })] })
      expect(service.store.list()).toHaveLength(0)
    } finally { service.stop() }
  })
  it('sends one normal notification with click navigation, queues strong reminders in one window and permits snooze', () => {
    vi.useFakeTimers(); const base = new Date(2026, 9, 23, 8).getTime(); vi.setSystemTime(base)
    const { service, open } = harness()
    try {
      const make = (level: 'normal' | 'strong') => service.save({ title: level, dueAt: base + 1000, level, recurrence: null, source: 'manual' })
      const normal = make('normal'), first = make('strong'); make('strong'); vi.advanceTimersByTime(1000)
      expect(mock.notices).toHaveLength(1); expect(mock.notices[0].show).toHaveBeenCalledOnce()
      mock.notices[0].emit('click'); expect(open).toHaveBeenCalledWith({ id: normal.id })
      expect(mock.windows).toHaveLength(1); expect(service.strongRows()).toHaveLength(2)
      service.action(first.id, 'snooze'); expect(service.store.get(first.id)?.dueAt).toBe(base + 301000)
      service.refresh(); expect(mock.notices).toHaveLength(1)
      mock.windows[0].emit('closed'); expect(service.strongRows()).toHaveLength(0)
      expect(service.store.list().some(row => row.level === 'strong' && row.status === 'due')).toBe(true)
    } finally { service.stop() }
  })
  it('extracts several note items without creating any until an explicit batch save', async () => {
    const { service, open } = harness()
    try {
      service.registerIpc({ list: () => ({ notes: [{ id: 'note-1', transcript: 'Call tomorrow; report before Friday', polished: 'do not overwrite' }] }) } as never)
      mock.extract.mockResolvedValue([draft(), draft({ intent: 'todo', title: 'Submit report', dueAt: null, needs_confirmation: true })])
      await mock.handlers.get('reminders:extract-note')!(null, 'note-1')
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'note-1', drafts: expect.any(Array) }))
      expect(service.store.list()).toHaveLength(0)
      mock.handlers.get('reminders:save-many')!(null, [{ title: 'Submit report', dueAt: null, level: 'normal', recurrence: null, source: 'note', noteId: 'note-1' }])
      expect(service.store.list()[0]).toMatchObject({ source: 'note', noteId: 'note-1', dueAt: null })
    } finally { service.stop() }
  })
})
