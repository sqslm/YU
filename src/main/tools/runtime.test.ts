import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings } from '@shared/defaults'
import { CalendarStore } from '../calendar'
import { createTask, attachTask } from '../task-context'
import { runTool, getTool, toolSchemas, type ToolContext } from './registry'
import type { LifeTools } from './life'
import type { WindowsTools } from './windows'
import type { PersonalTools } from './personal'

let root = ''
it('keeps unknown tool names out of diagnostic logs', async () => {
  const log = vi.fn(), ctx = { ...context(), log }
  await runTool('private clipboard secret', {}, ctx)
  expect(JSON.stringify(log.mock.calls)).not.toContain('private clipboard secret')
  expect(JSON.stringify(log.mock.calls)).toContain('tool=unknown')
})
it.each(['今天天气如何', '十分钟后提醒我截图', '不要读取当前屏幕'])('does not capture screenshots without authority: %s', async question => {
  const analyzeScreenshot = vi.fn(), ctx = { ...context(), question, analyzeScreenshot, allowedTools: ['analyze_screenshot'] }
  expect(toolSchemas(ctx.allowedTools, ctx)).toEqual([])
  expect((await runTool('analyze_screenshot', { question: 'model-requested capture' }, ctx)).status).toBe('awaiting_confirmation')
  expect(analyzeScreenshot).not.toHaveBeenCalled()
})
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); root = '' })
const context = (): ToolContext => ({ settings: mergeSettings({}), question: '安排明天下午三点讨论', log: () => {}, taskContext: attachTask({}, createTask('text')) })

it('deduplicates real calendar writes across callers sharing a task, while separate tasks remain independent', async () => {
  root = await mkdtemp(join(tmpdir(), 'yu-runtime-'))
  const store = new CalendarStore(join(root, 'calendar.json'))
  const life = { saveEvent: (input, id) => store.save(input, id) } as Pick<LifeTools, 'saveEvent'> as LifeTools
  const ctx = { ...context(), life, allowedTools: ['create_event'] }
  const args = { title: '讨论', start: '明天下午三点' }
  const [one, two] = await Promise.all([runTool('create_event', args, ctx), runTool('create_event', args, { ...ctx, cache: new Map() })])
  expect(one.status).toBe('completed'); expect(two.status).toBe('completed'); expect(two.reused).toBe(true)
  expect(store.list()).toHaveLength(1)
  expect(one.taskId).toBe(ctx.taskContext!.task!.id)
  expect(ctx.taskContext!.task!.receipts).toHaveLength(1)
  await runTool('create_event', args, { ...context(), life, allowedTools: ['create_event'] })
  expect(store.list()).toHaveLength(2)
})

it('validates schema before reaching a native adapter and advertises only connected enabled tools', async () => {
  const run = vi.fn(), ctx = { ...context(), windows: { run } as unknown as WindowsTools, allowedTools: ['search_files', 'open_folder'] }
  expect((await runTool('search_files', { minBytes: 1.5 }, ctx)).status).toBe('failed')
  expect((await runTool('search_files', { minBytes: -1 }, ctx)).status).toBe('failed')
  expect((await runTool('open_folder', { folder: 'downloads', shell: 'calc.exe' }, ctx)).status).toBe('failed')
  expect(run).not.toHaveBeenCalled()
  ctx.settings.assistantAccess.disabledTools = ['open_folder']
  const names = toolSchemas(ctx.allowedTools, ctx).map(row => (row.function as { name: string }).name)
  expect(names).toEqual(['search_files'])
  expect((await runTool('open_folder', {}, ctx)).status).toBe('unsupported')
  expect((await runTool('execute_shell', { command: 'calc.exe' }, ctx)).status).toBe('unsupported')
})

it('rechecks current tool permissions between steps and hides disconnected optional services', async () => {
  const ctx = context(), access = { ...ctx.settings.assistantAccess, disabledTools: [] as string[] }
  ctx.access = () => access
  expect((await runTool('get_datetime', {}, ctx)).status).toBe('completed')
  access.disabledTools.push('get_datetime')
  expect((await runTool('get_datetime', {}, ctx)).status).toBe('unsupported')
  const names = toolSchemas(['create_event', 'send_briefing'], { ...ctx, life: { saveEvent: () => { throw Error('not invoked') } } as unknown as LifeTools }).map(row => (row.function as { name: string }).name)
  expect(names).toEqual(['create_event'])
})

it('distinguishes confirmation, cancelled and timed out operations', async () => {
  const ctx = context()
  expect((await runTool('replace_selection', { text: 'preview only' }, ctx)).status).toBe('awaiting_confirmation')
  const controller = new AbortController(); controller.abort()
  expect((await runTool('get_datetime', {}, { ...ctx, signal: controller.signal })).status).toBe('cancelled')
  const tool = getTool('get_datetime')!
  vi.spyOn(tool, 'run').mockImplementation((_args, current) => new Promise((_resolve, reject) => current.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true })))
  expect((await runTool('get_datetime', {}, { ...ctx, timeouts: { get_datetime: 5 } })).status).toBe('timeout')
})

it.each(['今天有什么安排？', '不要读取剪贴板', '解释“读取剪贴板”是什么意思', '十分钟后提醒我读取剪贴板'])('never reads private resources from an unrelated, negated or quoted request: %s', async question => {
  const readClipboard = vi.fn(), readSelection = vi.fn()
  const ctx = { ...context(), question, personal: { readClipboard } as unknown as PersonalTools, readSelection, allowedTools: ['read_clipboard', 'get_selection'] }
  expect((await runTool('read_clipboard', {}, ctx)).status).toBe('awaiting_confirmation')
  expect((await runTool('get_selection', {}, ctx)).status).toBe('awaiting_confirmation')
  expect(readClipboard).not.toHaveBeenCalled(); expect(readSelection).not.toHaveBeenCalled()
})
