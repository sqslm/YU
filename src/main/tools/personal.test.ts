import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { NoteEntry } from '@shared/types'
import type { Reminder } from '@shared/reminders'
import { PERSONAL_TOOLS, personalCommand, type PersonalTools } from './personal'
import { runTool, toolSchemas, type ToolContext } from './registry'

let api: PersonalTools, ctx: ToolContext
beforeEach(() => {
  api = { remind: vi.fn().mockResolvedValue({ message: 'Please confirm the time' }), reminders: vi.fn().mockReturnValue([
    { id: 'task-1', title: 'Untimed task', dueAt: null, status: 'pending', level: 'normal' },
    { id: 'task-2', title: 'Done', dueAt: 1, status: 'completed', level: 'normal' }
  ] as Reminder[]), action: vi.fn(), notes: vi.fn().mockReturnValue([{ id: 'note-1', transcript: 'My idea', polished: '', tags: [], updatedAt: 1, createdAt: 1, durationMs: 0, polishStatus: 'skipped' }] as NoteEntry[]),
    createNote: vi.fn().mockResolvedValue({ id: 'saved-note' }), extract: vi.fn(), history: vi.fn().mockReturnValue([]), copy: vi.fn(), open: vi.fn(), confirm: vi.fn().mockResolvedValue(true) }
  ctx = { settings: mergeSettings({}), question: 'Remind me tomorrow morning', log: vi.fn(), allowedTools: PERSONAL_TOOLS, personal: api, cache: new Map(), signal: new AbortController().signal, onLocalResult: vi.fn(), submittedAt: Date.now() - 20_000 }
})

describe('personal tools share real application services', () => {
  it('keeps personal data tools out of ordinary Ask and denies missing capability context', async () => {
    expect(toolSchemas().map(t => (t.function as { name: string }).name)).not.toContain('search_notes')
    expect((await runTool('create_note', { text: 'x' }, { ...ctx, allowedTools: undefined })).ok).toBe(false)
    expect((await runTool('list_reminders', {}, { ...ctx, personal: undefined })).ok).toBe(false)
    expect(api.createNote).not.toHaveBeenCalled(); expect(api.reminders).not.toHaveBeenCalled()
  })
  it('uses the untouched user command, rejects timestamps and does not claim a review was saved', async () => {
    const result = await runTool('create_reminder', {}, ctx)
    expect(api.remind).toHaveBeenCalledWith(ctx.question, expect.any(AbortSignal), ctx.submittedAt)
    expect(result).toMatchObject({ ok: true, data: { confirmationRequired: true }, summary: 'Please confirm the time' })
    expect((await runTool('create_reminder', { dueAt: Date.now() + 60000 }, ctx)).ok).toBe(false)
  })
  it('does not duplicate a model-repeated create operation in one task', async () => {
    await runTool('create_note', { text: 'My note' }, ctx); await runTool('create_note', { text: 'My note' }, ctx)
    expect(api.createNote).toHaveBeenCalledExactlyOnceWith('My note')
    expect(ctx.onLocalResult).toHaveBeenCalledWith(expect.objectContaining({ tool: 'create_note', items: undefined }))
  })
  it('queries actual active untimed todos and excludes completed items by default', async () => {
    const result = await runTool('list_reminders', {}, ctx)
    expect(result.data).toMatchObject({ total: 1, items: [expect.objectContaining({ id: 'task-1', dueAt: null })] })
    expect((await runTool('list_reminders', { status: 'all' }, ctx)).data.total).toBe(2)
  })
  it('requires permission for reading notes or history and never reads after denial', async () => {
    vi.mocked(api.confirm).mockResolvedValue(false)
    expect((await runTool('search_notes', {}, ctx)).ok).toBe(false)
    expect((await runTool('search_history', {}, ctx)).ok).toBe(false)
    expect(api.notes).not.toHaveBeenCalled(); expect(api.history).not.toHaveBeenCalled()
    expect((await runTool('create_note', { text: 'Injected side effect' }, ctx)).ok).toBe(false)
    expect(api.createNote).not.toHaveBeenCalled()
  })
  it('reuses extraction with note ID and review, rather than changing the original note', async () => {
    const result = await runTool('extract_note_tasks', { id: 'note-1' }, ctx)
    expect(api.extract).toHaveBeenCalledWith('note-1', expect.any(AbortSignal))
    expect(result.data.confirmationRequired).toBe(true); expect(api.createNote).not.toHaveBeenCalled()
  })
  it('confirms mutations against a real reminder ID and rejects a guessed ID', async () => {
    expect((await runTool('manage_reminder', { id: 'unknown', action: 'delete' }, ctx)).ok).toBe(false)
    expect(api.action).not.toHaveBeenCalled()
    await runTool('manage_reminder', { id: 'task-1', action: 'complete' }, ctx)
    expect(api.confirm).toHaveBeenCalled(); expect(api.action).toHaveBeenCalledWith('task-1', 'complete', undefined)
  })
  it('only opens a registered existing page, and copies after authorization', async () => {
    expect((await runTool('open_page', { page: 'calendar' }, ctx)).ok).toBe(false)
    await runTool('open_page', { page: 'history' }, ctx); expect(api.open).toHaveBeenCalledExactlyOnceWith('history')
    await runTool('copy_to_clipboard', { text: 'Answer' }, ctx); expect(api.copy).toHaveBeenCalledExactlyOnceWith('Answer')
  })
  it('cancellation prevents reads and writes', async () => {
    const controller = new AbortController(); controller.abort()
    expect((await runTool('create_note', { text: 'No' }, { ...ctx, signal: controller.signal })).ok).toBe(false)
    expect(api.createNote).not.toHaveBeenCalled()
  })
})

it('distinguishes application pages from system applications and data questions', () => {
  expect(personalCommand('打开历史记录页面')).toEqual({ name: 'open_page', args: { page: 'history' } })
  expect(personalCommand('Open the settings page')).toEqual({ name: 'open_page', args: { page: 'settings' } })
  expect(personalCommand('今天有哪些提醒待办？')).toBeNull()
  expect(personalCommand('打开 VS Code')).toBeNull()
})
