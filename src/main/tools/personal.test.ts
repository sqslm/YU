import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { NoteEntry } from '@shared/types'
import type { Reminder } from '@shared/reminders'
import { PERSONAL_TOOLS, personalCommand, type PersonalTools } from './personal'
import { runTool, toolSchemas, type ToolContext } from './registry'
import { setMainLanguage } from '@shared/mainI18n'

let api: PersonalTools, ctx: ToolContext
beforeEach(() => {
  api = { remind: vi.fn().mockResolvedValue({ message: 'Please confirm the time' }), reminders: vi.fn().mockReturnValue([
    { id: 'task-1', title: 'Untimed task', dueAt: null, status: 'pending', level: 'normal' },
    { id: 'task-2', title: 'Done', dueAt: 1, status: 'completed', level: 'normal' }
  ] as Reminder[]), action: vi.fn(), saveReminder: vi.fn((input, id) => ({ ...input, id } as Reminder)), updateNoteTags: vi.fn(), notes: vi.fn().mockReturnValue([{ id: 'note-1', transcript: 'My idea', polished: '', tags: [], updatedAt: 1, createdAt: 1, durationMs: 0, polishStatus: 'skipped' }] as NoteEntry[]),
    createNote: vi.fn().mockResolvedValue({ id: 'saved-note' }), extract: vi.fn().mockResolvedValue('已保存 1 个事项'), history: vi.fn().mockReturnValue([]), copy: vi.fn(), readClipboard: vi.fn().mockReturnValue('Clipboard text'), open: vi.fn(), updateNote: vi.fn(async(id, patch)=>({...api.notes()[0], ...patch, id})), categories: vi.fn().mockReturnValue([]), saveCategories: vi.fn(async categories=>categories) }
  ctx = { settings: mergeSettings({}), question: 'Remind me tomorrow morning', log: vi.fn(), allowedTools: PERSONAL_TOOLS, personal: api, cache: new Map(), signal: new AbortController().signal, onLocalResult: vi.fn(), submittedAt: Date.now() - 20_000 }
})
afterEach(() => { vi.useRealTimers(); setMainLanguage('zh') })

describe('personal tools share real application services', () => {
  it('passes only an exact reminder clause from a compound command, and rejects invented text', async () => {
    const question = '先记下整理照片的想法，再加个待办，周末研究一下。'
    await runTool('create_reminder', { text: '加个待办，周末研究一下。' }, { ...ctx, question })
    expect(api.remind).toHaveBeenCalledWith('加个待办，周末研究一下。', expect.any(AbortSignal), ctx.submittedAt)
    await runTool('create_reminder', { text: '周末研究一下。' }, { ...ctx, question, cache: new Map() })
    expect(api.remind).toHaveBeenLastCalledWith('待办：周末研究一下。', expect.any(AbortSignal), ctx.submittedAt)
    vi.mocked(api.remind).mockClear()
    expect((await runTool('create_reminder', { text: '提醒我明天上午八点买东西' }, { ...ctx, question })).ok).toBe(false)
    expect(api.remind).not.toHaveBeenCalled()
    expect((await runTool('create_reminder', { text: '提醒我明天上午八点买东西' }, { ...ctx, question: '提醒我明天上午八点买东西，改成后天上午九点。' })).ok).toBe(false)
  })
  it('keeps personal data tools out of ordinary Ask and denies missing capability context', async () => {
    expect(toolSchemas().map(t => (t.function as { name: string }).name)).not.toContain('search_notes')
    expect((await runTool('create_note', { text: 'x' }, { ...ctx, allowedTools: undefined })).ok).toBe(false)
    expect((await runTool('list_reminders', {}, { ...ctx, personal: undefined })).ok).toBe(false)
    expect(api.createNote).not.toHaveBeenCalled(); expect(api.reminders).not.toHaveBeenCalled()
  })
  it('uses the untouched user command, rejects timestamps and does not claim a review was saved', async () => {
    const result = await runTool('create_reminder', {}, ctx)
    expect(api.remind).toHaveBeenCalledWith(ctx.question, expect.any(AbortSignal), ctx.submittedAt)
    expect(result).toMatchObject({ ok: false, summary: 'Please confirm the time', data: { saved: 0, needsClarification: true } })
    expect((await runTool('create_reminder', { dueAt: Date.now() + 60000 }, ctx)).ok).toBe(false)
  })
  it.each(['每天八点给我当天的任务简报。', 'Schedule a project meeting tomorrow.', '把明天取东西的提醒改成下午两点。', '记住，我喜欢简单的方案。'])('does not let a model substitute new reminders for a different action: %s', async question => {
    expect((await runTool('create_reminder', {}, { ...ctx, question })).ok).toBe(false)
    expect(api.remind).not.toHaveBeenCalled()
  })
  it('does not duplicate a model-repeated create operation in one task', async () => {
    await runTool('create_note', { text: 'My note' }, ctx); await runTool('create_note', { text: 'My note' }, ctx)
    expect(api.createNote).toHaveBeenCalledExactlyOnceWith('My note')
    expect(ctx.onLocalResult).toHaveBeenCalledWith(expect.objectContaining({ tool: 'create_note', items: undefined }))
  })
  it('renames and categorizes a real note without changing its raw text, and reuses category IDs', async () => {
    vi.mocked(api.categories).mockReturnValue([{id:'work',name:'Work'}])
    expect((await runTool('update_note', {id:'note-1',title:'Project plan',category_name:'work'},ctx)).ok).toBe(true)
    expect(api.updateNote).toHaveBeenCalledWith('note-1',{title:'Project plan',categoryId:'work'})
    expect(api.saveCategories).not.toHaveBeenCalled()
    expect(api.notes()[0].transcript).toBe('My idea')
    expect((await runTool('update_note',{id:'note-1',category_name:'灵感'},ctx)).ok).toBe(true)
    expect(api.saveCategories).toHaveBeenCalledWith([{id:'work',name:'Work'},{id:expect.any(String),name:'灵感'}])
    expect((await runTool('update_note',{id:'missing',title:'No'},ctx)).ok).toBe(false)
    expect((await runTool('update_note',{id:'note-1',category_id:'work',category_name:'Work'},ctx)).ok).toBe(false)
  })
  it('queries actual active untimed todos and excludes completed items by default', async () => {
    const result = await runTool('list_reminders', {}, ctx)
    expect(result.data).toMatchObject({ total: 1, items: [expect.objectContaining({ id: 'task-1', dueAt: null })] })
    expect((await runTool('list_reminders', { status: 'all' }, ctx)).data.total).toBe(2)
  })
  it('executes safe reads and writes directly without confirmation and refuses irreversible deletion', async () => {
    expect((await runTool('search_notes', {}, ctx)).ok).toBe(true)
    expect((await runTool('search_history', {}, ctx)).ok).toBe(true)
    expect((await runTool('create_note', {text:'Explicit note'}, ctx)).ok).toBe(true)
    expect((await runTool('manage_reminder', {id:'task-1',action:'delete'},ctx)).ok).toBe(false)
    expect(api.action).not.toHaveBeenCalled()
  })
  it('returns real extraction receipts without confirmation or changing the note', async () => {
    const result = await runTool('extract_note_tasks', { id: 'note-1' }, ctx)
    expect(api.extract).toHaveBeenCalledWith('note-1', expect.any(AbortSignal))
    expect(result.summary).toBe('已保存 1 个事项'); expect(result.data.confirmationRequired).toBeUndefined(); expect(api.createNote).not.toHaveBeenCalled()
  })
  it('confirms mutations against a real reminder ID and rejects a guessed ID', async () => {
    expect((await runTool('manage_reminder', { id: 'unknown', action: 'delete' }, ctx)).ok).toBe(false)
    expect(api.action).not.toHaveBeenCalled()
    await runTool('manage_reminder', { id: 'task-1', action: 'complete' }, ctx)
    expect(api.action).toHaveBeenCalledWith('task-1', 'complete', undefined)
  })
  it('only opens a registered existing page, and copies after authorization', async () => {
    expect((await runTool('open_page', { page: 'nowhere' }, ctx)).ok).toBe(false)
    await runTool('open_page', { page: 'history' }, ctx); expect(api.open).toHaveBeenCalledExactlyOnceWith('history')
    await runTool('copy_to_clipboard', { text: 'Answer' }, ctx); expect(api.copy).toHaveBeenCalledExactlyOnceWith('Answer')
  })
  it('cancellation prevents reads and writes', async () => {
    const controller = new AbortController(); controller.abort()
    expect((await runTool('create_note', { text: 'No' }, { ...ctx, signal: controller.signal })).ok).toBe(false)
    expect(api.createNote).not.toHaveBeenCalled()
  })
  it('returns absolute trigger times, live remaining seconds, levels and untimed todos for today', async () => {
    vi.useFakeTimers(); const now = new Date(2026, 9, 23, 10).getTime(); vi.setSystemTime(now)
    vi.mocked(api.reminders).mockReturnValue([
      { id: 'todo', title: 'Untimed', dueAt: null, status: 'pending', level: 'normal' },
      { id: 'due', title: 'Late', dueAt: now - 60000, status: 'due', level: 'strong', timeExpression: 'in 20 minutes' },
      { id: 'future', title: 'Next', dueAt: now + 120000, status: 'pending', level: 'normal' },
      { id: 'tomorrow', title: 'Tomorrow', dueAt: now + 86400000, status: 'pending', level: 'normal' }
    ] as Reminder[])
    const result = await runTool('list_reminders', { today: true }, ctx)
    // Ordered by the shared todo order: open work by deadline, untimed work last.
    expect(result.data.items).toMatchObject([
      { id: 'due', level: 'strong', remainingSeconds: -60, overdue: true, triggerTime: expect.any(String), priorityLabel: '普通' },
      { id: 'future', remainingSeconds: 120 },
      { id: 'todo', kind: 'todo', remainingSeconds: null }
    ])
    expect((await runTool('list_reminders', { kind: 'todo' }, ctx)).data.total).toBe(1)
    expect((await runTool('list_reminders', { today: true, kind: 'reminder' }, ctx)).data.total).toBe(2)
  })
  it.each(['下午两点', '2 PM', 'at two PM'])('edits the original reminder at %s without moving its date or losing its note link', async time => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 8))
    const row = { id: 'pickup', title: 'Pickup', description: 'Receipt', noteId: 'source-note', source: 'note',
      dueAt: new Date(2026, 9, 24, 8).getTime(), recurrence: null, status: 'pending', level: 'strong', updatedAt: 1 } as Reminder
    vi.mocked(api.reminders).mockReturnValue([row])
    const result = await runTool('manage_reminder', { id: row.id, action: 'update', time_expression: time, level: 'normal' }, ctx)
    expect(result.ok).toBe(true)
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ title: 'Pickup', noteId: 'source-note', description: 'Receipt',
      dueAt: new Date(2026, 9, 24, 14).getTime(), level: 'normal' }), row.id)
    expect(api.action).not.toHaveBeenCalled()
    expect(result.data).toMatchObject({ before: { level: 'strong', dueAt: row.dueAt }, item: { level: 'normal' } })
    expect(result.summary).toContain('Pickup')
  })
  it('preserves all weekdays when changing a repeating reminder clock', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 8))
    vi.mocked(api.reminders).mockReturnValue([{ id: 'weekly', title: 'Exercise', dueAt: new Date(2026, 9, 23, 9).getTime(), level: 'normal',
      recurrence: { frequency: 'weekly', weekdays: [1, 3, 5], hour: 9, minute: 0 } }] as Reminder[])
    const result = await runTool('manage_reminder', { id: 'weekly', action: 'update', time_expression: '下午两点' }, ctx)
    expect(result.ok).toBe(true)
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ recurrence: { frequency: 'weekly', weekdays: [1, 3, 5], hour: 14, minute: 0 } }), 'weekly')
  })
  it('rejects ambiguous times, missing edit fields and a target changed during authorization', async () => {
    expect((await runTool('manage_reminder', { id: 'task-1', action: 'update' }, ctx)).ok).toBe(false)
    expect((await runTool('manage_reminder', { id: 'task-1', action: 'update', time_expression: 'tomorrow' }, ctx)).ok).toBe(false)
    vi.mocked(api.reminders).mockReturnValueOnce(api.reminders()).mockReturnValue([])
    expect((await runTool('manage_reminder', { id: 'task-1', action: 'update', level: 'strong' }, ctx)).ok).toBe(false)
    expect(api.saveReminder).not.toHaveBeenCalled()
  })
  it('reports the original reminder details on cancellation instead of a generic update message', async () => {
    const result = await runTool('manage_reminder', { id: 'task-1', action: 'cancel' }, ctx)
    expect(result.summary).toContain('Untimed task')
    expect(result.data).toMatchObject({ action: 'cancel', before: { id: 'task-1', dueAt: null, level: 'normal' } })
  })
  it('selects the latest/previous note by creation time, preserving tags and tolerating brand homophones in search only', async () => {
    const notes = [
      { id: 'old', transcript: 'Old', polished: '', tags: [], updatedAt: 99, createdAt: 1 },
      { id: 'middle', transcript: '轻令项目', polished: '', tags: ['work'], updatedAt: 2, createdAt: 2 },
      { id: 'new', transcript: 'New', polished: '', tags: [], updatedAt: 3, createdAt: 3 }
    ] as NoteEntry[]
    vi.mocked(api.notes).mockReturnValue(notes)
    expect((await runTool('search_notes', { position: 'latest' }, ctx)).data.items).toMatchObject([{ id: 'new' }])
    expect((await runTool('search_notes', { position: 'previous' }, ctx)).data.items).toMatchObject([{ id: 'middle', tags: ['work'] }])
    expect((await runTool('search_notes', { query: '清令' }, ctx)).data.total).toBe(1)
    expect(notes[1].transcript).toBe('轻令项目')
  })
  it('updates only note tags without creating a duplicate note or losing existing tags', async () => {
    vi.mocked(api.notes).mockReturnValue([{ id: 'note', transcript: 'Original', polished: 'Edited', tags: ['keep', 'remove'], updatedAt: 1 }] as NoteEntry[])
    vi.mocked(api.updateNoteTags).mockResolvedValue({ id: 'note', tags: ['keep', 'work'] } as NoteEntry)
    expect((await runTool('update_note_tags', { id: 'note', add_tags: ['work'], remove_tags: ['remove'] }, ctx)).ok).toBe(true)
    expect(api.updateNoteTags).toHaveBeenCalledExactlyOnceWith('note', ['keep', 'work'])
    expect(api.createNote).not.toHaveBeenCalled()
    expect((await runTool('update_note_tags', { id: 'note', add_tags: [12] }, ctx)).ok).toBe(false)
  })
  it('passes a local calendar date range to history storage, never using yesterday as a text keyword', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 8))
    await runTool('search_history', { day: 'yesterday' }, ctx)
    expect(api.history).toHaveBeenCalledExactlyOnceWith('', { from: +new Date(2026, 9, 22), until: +new Date(2026, 9, 23) })
    expect((await runTool('search_history', { day: '2026-02-30' }, ctx)).ok).toBe(false)
  })
  it('localizes reminder editing receipts in English', async () => {
    setMainLanguage('en')
    const result = await runTool('manage_reminder', { id: 'task-1', action: 'update', level: 'strong' }, ctx)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/[\u4e00-\u9fff]/)
  })
  it('reads only explicitly requested current clipboard text without a confirmation popup', async () => {
    expect((await runTool('read_clipboard', {}, { ...ctx, question:'Read the clipboard' })).ok).toBe(true)
    expect(api.readClipboard).toHaveBeenCalledOnce()
  })
  it('records an explicit priority and an independently parsed deadline without moving the alert', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    const reminder = { id: 'new', title: 'Take the slides', dueAt: new Date(2026, 9, 24, 14, 50).getTime(), level: 'normal',
      recurrence: null, source: 'manual', status: 'pending', createdAt: 1, updatedAt: 1, deliveredAt: null, priority: 'normal', deadlineAt: null } as Reminder
    vi.mocked(api.remind).mockResolvedValue({ message: '提醒已创建', reminder })
    const result = await runTool('create_reminder', { priority: 'high', deadline: '今天18点' }, ctx)
    const deadlineAt = new Date(2026, 9, 23, 18).getTime()
    expect(result.ok).toBe(true)
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'new', dueAt: reminder.dueAt, priority: 'high', deadlineAt }), 'new')
    expect(result.data).toMatchObject({ item: { priority: 'high', priorityLabel: '高', deadlineAt, dueAt: reminder.dueAt } })
    expect(result.summary).toContain('高优先级'); expect(result.summary).toContain('截止')
  })
  it('keeps an unrecognisable deadline from failing the whole reminder', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    const result = await runTool('create_reminder', { deadline: '尽快' }, ctx)
    // The parser still needs a time; an unclear deadline must not turn that into success.
    expect(result.ok).toBe(false)
    expect(api.remind).toHaveBeenCalledWith(ctx.question, expect.any(AbortSignal), ctx.submittedAt)
    expect(api.saveReminder).not.toHaveBeenCalled()
    expect(result.summary).toBe('Please confirm the time')
  })
  it('turns a bare date deadline into the end of that day', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    const reminder = { id: 'new', title: 'Send the deck', dueAt: new Date(2026, 9, 24, 14, 50).getTime(), level: 'normal',
      recurrence: null, source: 'manual', status: 'pending', createdAt: 1, updatedAt: 1, deliveredAt: null, priority: 'normal', deadlineAt: null } as Reminder
    vi.mocked(api.remind).mockResolvedValue({ message: '提醒已创建', reminder })
    const result = await runTool('create_reminder', { deadline: '明天' }, ctx)
    const deadlineAt = new Date(2026, 9, 24, 23, 59, 59, 999).getTime()
    expect(result.ok).toBe(true)
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt, dueAt: reminder.dueAt }), 'new')
    expect(result.summary).toContain('截止 明天 23:59')
  })
  it('moves the alert onto a deadline that would otherwise never fire', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    const reminder = { id: 'new', title: 'File the report', dueAt: null, level: 'normal',
      recurrence: null, source: 'manual', status: 'pending', createdAt: 1, updatedAt: 1, deliveredAt: null, priority: 'normal', deadlineAt: null } as Reminder
    vi.mocked(api.remind).mockResolvedValue({ message: '待办已创建', reminder })
    const result = await runTool('create_reminder', { deadline: '今天18点' }, ctx)
    const deadlineAt = new Date(2026, 9, 23, 18).getTime()
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ dueAt: deadlineAt, deadlineAt }), 'new')
    expect(result.summary).toContain('会在截止时提醒')
    expect(result.data).toMatchObject({ item: { dueAt: deadlineAt, deadlineAt } })
  })
  it('never claims a priority or deadline it could not store', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    // Pending confirmation: the extractor stored nothing, so the fields have nowhere to go.
    vi.mocked(api.remind).mockResolvedValue({ message: '请补充明确的事项和提醒时间，本次未保存' })
    const result = await runTool('create_reminder', { priority: 'high', deadline: '今天18点' }, ctx)
    expect(api.remind).toHaveBeenCalledWith(ctx.question, expect.any(AbortSignal), ctx.submittedAt,
      { priority: 'high', deadlineAt: new Date(2026, 9, 23, 18).getTime() })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('本次未保存')
    expect(result.data.item).toBeUndefined()
  })
  it('reports a multi-item take as stored instead of assuming nothing happened', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    vi.mocked(api.remind).mockResolvedValue({ message: '已创建 2 个待办', saved: 2 })
    const result = await runTool('create_reminder', { priority: 'high', deadline: '今天18点' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('优先级和截止时间已应用到本次的 2 个事项')
  })
  it('judges list_reminders overdue on the deadline and reports the priority label', async () => {
    vi.useFakeTimers(); const now = new Date(2026, 9, 23, 18, 30).getTime(); vi.setSystemTime(now)
    vi.mocked(api.reminders).mockReturnValue([
      { id: 'late', title: 'Slides', dueAt: now - 3600000, deadlineAt: now - 1800000, priority: 'high', status: 'pending', level: 'normal' },
      { id: 'finished', title: 'Done', dueAt: now - 3600000, deadlineAt: now - 1800000, priority: 'high', status: 'completed', level: 'normal' },
      { id: 'soon', title: 'Notes', dueAt: now - 600000, deadlineAt: now + 3600000, priority: 'low', status: 'due', level: 'normal' },
      { id: 'plain', title: 'Untimed', dueAt: null, status: 'pending', level: 'normal' }
    ] as Reminder[])
    const result = await runTool('list_reminders', { status: 'all' }, ctx)
    // High first, then normal (untimed included), then low; finished work last.
    expect(result.data.items).toMatchObject([
      { id: 'late', priority: 'high', priorityLabel: '高', overdue: true },
      { id: 'plain', priority: 'normal', priorityLabel: '普通', deadlineAt: null, overdue: false },
      { id: 'soon', priority: 'low', priorityLabel: '低', overdue: false },
      { id: 'finished', overdue: false }
    ])
  })
  it('edits priority and deadline in place without moving the alert time', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 23, 10))
    const row = { id: 'plan', title: 'Plan', dueAt: new Date(2026, 9, 24, 9).getTime(), deadlineAt: null, priority: 'normal',
      recurrence: null, status: 'pending', level: 'normal', source: 'manual', createdAt: 1, updatedAt: 1, deliveredAt: null } as Reminder
    vi.mocked(api.reminders).mockReturnValue([row])
    const result = await runTool('manage_reminder', { id: 'plan', action: 'update', priority: 'high', deadline: '今天18点' }, ctx)
    const deadlineAt = new Date(2026, 9, 23, 18).getTime()
    expect(result.ok).toBe(true)
    expect(api.saveReminder).toHaveBeenCalledWith(expect.objectContaining({ dueAt: row.dueAt, priority: 'high', deadlineAt }), 'plan')
    expect(result.summary).toContain('优先级 普通 → 高'); expect(result.summary).toContain('截止')
    expect(result.data).toMatchObject({ item: { priority: 'high', deadlineAt } })
  })
  it('rejects a priority outside the declared values before any work happens', async () => {
    expect((await runTool('create_reminder', { priority: 'urgent' }, ctx)).ok).toBe(false)
    expect((await runTool('manage_reminder', { id: 'task-1', action: 'update', priority: 'P1' }, ctx)).ok).toBe(false)
    expect(api.remind).not.toHaveBeenCalled(); expect(api.saveReminder).not.toHaveBeenCalled()
  })
})

it('distinguishes application pages from system applications and data questions', () => {
  expect(personalCommand('打开历史记录页面')).toEqual({ name: 'open_page', args: { page: 'history' } })
  expect(personalCommand('Open the settings page')).toEqual({ name: 'open_page', args: { page: 'settings' } })
  expect(personalCommand('今天有哪些提醒待办？')).toBeNull()
  expect(personalCommand('打开 VS Code')).toBeNull()
})
