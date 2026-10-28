import { expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { runTool, type ToolContext } from './registry'
import { LIFE_TOOLS, type LifeTools } from './life'
import { PERSONAL_TOOLS, type PersonalTools } from './personal'
import { WINDOWS_TOOLS, WindowsTools } from './windows'
import { attachTask, createTask } from '../task-context'
import { readAloudCommand } from '../read-aloud-command'
import { directVoiceIntent } from '../voice-intent'

function harness(question: string) {
  const speak = vi.fn().mockResolvedValue({ spoken: 4, skipped: false })
  const notes = vi.fn().mockReturnValue([{ id: 'note', title: '优化点', polished: '完整正文', transcript: '原始正文', createdAt: 1 }])
  const native = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Actual article', text: 'Real browser body' })
  const ctx: ToolContext = { question, settings: mergeSettings({}), log: vi.fn(),
    life: { speak, ttsEnabled: () => true, briefing: () => ({ title: '简报', body: '实际简报', empty: false }) } as unknown as LifeTools,
    personal: { notes, readClipboard: () => '剪贴板原文' } as unknown as PersonalTools,
    windows: new WindowsTools({ native, folders: { downloads: '', desktop: '', documents: '' }, openPath: vi.fn(), openUrl: vi.fn() }),
    allowedTools: [...LIFE_TOOLS, ...PERSONAL_TOOLS, ...WINDOWS_TOOLS, 'get_selection', 'read_webpage'],
    taskContext: attachTask({}, createTask('voice', { windowHandle: '123', processId: 42, appName: 'ego', windowTitle: 'Actual page' })),
    readSelection: async () => '选区原文' }
  return { ctx, speak, notes, native }
}

it.each([
  ['帮我朗读一下随记里面标题为优化点的内容', { source: 'note', title: '优化点' }],
  ['朗读随记里标题叫做“优化点”的内容', { source: 'note', title: '优化点' }],
  ['朗读最新随记', { source: 'note', latest: true }],
  ['把刚才的润色结果读给我听', { source: 'result', mode: 'dictation' }],
  ['朗读翻译结果', { source: 'result', mode: 'translate' }],
  ['朗读这个回答', { source: 'answer' }],
  ['读一下当前网页', { source: 'current_content' }],
  ['朗读今天的日程', { source: 'calendar', day: 'today' }],
  ['朗读明天的待办', { source: 'reminders', day: 'tomorrow' }],
  ['朗读：https://example.com/', { source: 'webpage', url: 'https://example.com/' }],
  ['read my latest polished result aloud', { source: 'result', mode: 'dictation' }],
  ['please read the note titled Optimization', { source: 'note', title: 'Optimization' }]
])('resolves an explicit source and routes it as an assistant task: %s', (text, args) => {
  expect(readAloudCommand(text)).toEqual({ name: 'read_aloud', args })
  expect(directVoiceIntent(text)?.kind).toBe('assistant')
})

it.each(['不要朗读这个网页', '给 Codex 写提示词：朗读随记', '明天提醒我朗读随记', 'How do I add read aloud to my app?'])('does not treat other intents as immediate narration: %s', text => {
  expect(directVoiceIntent(text)?.kind).not.toBe('assistant')
})

it.each(['search_notes', 'speak_text', 'read_aloud'])('honors disabled tools before reading or playing a note: %s', async name => {
  const h = harness('朗读随记里标题为优化点的内容')
  h.ctx.settings.assistantAccess.disabledTools = [name]
  expect((await runTool('read_aloud', { source: 'note', title: '优化点' }, h.ctx)).ok).toBe(false)
  expect(h.notes).not.toHaveBeenCalled(); expect(h.speak).not.toHaveBeenCalled()
})

it.each([{ rows: [] }, { rows: [{ id: 'a', title: '优化点' }, { id: 'b', title: '优化点' }] }])('asks for clarification for a missing or duplicate title', async ({ rows }) => {
  const h = harness('朗读随记里标题为优化点的内容')
  h.notes.mockReturnValue(rows)
  const result = await runTool('read_aloud', { source: 'note', title: '优化点' }, h.ctx)
  expect(result.status).toBe('awaiting_confirmation'); expect(h.speak).not.toHaveBeenCalled()
})

it.each([
  ['朗读当前网页', 'current_content', 'Real browser body'],
  ['朗读选中的文字', 'selection', '选区原文'],
  ['朗读剪贴板', 'clipboard', '剪贴板原文'],
  ['朗读今日简报', 'briefing', '实际简报']
])('reads actual source data through the existing tools: %s', async (question, source, text) => {
  const h = harness(question)
  const result = await runTool('read_aloud', { source }, h.ctx)
  expect(result.ok).toBe(true); expect(h.speak).toHaveBeenCalledWith(text, expect.any(AbortSignal))
})

it('reads the preserved answer and never substitutes a missing one', async () => {
  const h = harness('朗读这个回答')
  h.ctx.taskContext!.task!.recentExchange = { question: 'Q', answer: '实际回答' }
  expect((await runTool('read_aloud', { source: 'answer' }, h.ctx)).ok).toBe(true)
  expect(h.speak).toHaveBeenCalledWith('实际回答', expect.any(AbortSignal))
  h.speak.mockClear(); delete h.ctx.taskContext!.task!.recentExchange
  expect((await runTool('read_aloud', { source: 'answer' }, h.ctx)).status).toBe('awaiting_confirmation')
  expect(h.speak).not.toHaveBeenCalled()
})

it('does not let a model source argument authorize clipboard or selection reads', async () => {
  const h = harness('你好')
  for (const source of ['clipboard', 'selection']) expect((await runTool('read_aloud', { source }, h.ctx)).ok).toBe(false)
  expect(h.speak).not.toHaveBeenCalled()
})
