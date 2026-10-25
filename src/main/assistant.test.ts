import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import {
  AssistantSession, ASSISTANT_TOOLS, referenceBlock, referenceContextFrom, referenceContextFromNotes, referenceEditHint,
  resolveReference
} from './assistant'
import type { ReferenceContext, ReferenceItem } from './assistant'
import { askAgent } from './agent'
import { runTool, toolSchemas } from './tools/registry'
import type { AssistantState } from '@shared/assistant'
import type { PersonalTools } from './tools/personal'
import type { LifeTools } from './tools/life'
import { WindowsTools } from './tools/windows'

const settings = mergeSettings({ profiles: [{ id: 'text', kind: 'llm', name: 'Text', enabled: true,
  preset: '', baseUrl: 'https://example.com/v1', apiKey: 'private', model: 'model' }], chains: { llm: ['text'], asr: [], multimodal: [] } })
let now = 1000
let ask: ReturnType<typeof vi.fn<typeof askAgent>>
let changed: ReturnType<typeof vi.fn<(state: AssistantState) => void>>
let session: AssistantSession
beforeEach(() => {
  now = 1000
  ask = vi.fn<typeof askAgent>().mockResolvedValue({ text: 'Actual answer', sources: [], searched: false })
  changed = vi.fn()
  session = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), now: () => now })
})

describe('assistant session', () => {
  it.each([true, false])('accepts an unavailable Everything probe only when a later built-in search succeeds: %s', async recovered => {
    const windows = new WindowsTools({ folders: { downloads: '.', desktop: '.', documents: '.' }, native: vi.fn(), openPath: vi.fn(), openUrl: vi.fn() })
    ask.mockImplementationOnce(async (...args) => {
      args[5]?.onLocalResult?.({ tool: 'search_files_everything', ok: false, fallback: true, summary: 'Index unavailable' })
      if (recovered) args[5]?.onLocalResult?.({ tool: 'search_files', ok: true, summary: 'Built-in search finished' })
      return { text: 'Actual built-in results', sources: [], searched: false }
    })
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), windows })
    await current.send('Find the notes in my downloads')
    expect(current.snapshot().turns.at(-1)?.state).toBe(recovered ? 'done' : 'error')
  })
  it.each(['把我框选区域里的文字提取出来。', '我想让你分析这张截图，但先给我看一下准备发送的内容。'])('preserves the complete region/preview request for the screenshot boundary: %s', async input => {
    const analyzeScreenshot = vi.fn().mockResolvedValue('Local editor opened; no image sent')
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), analyzeScreenshot })
    await current.send(input)
    expect(analyzeScreenshot).toHaveBeenCalledWith(expect.objectContaining({task: expect.objectContaining({source: 'text'})}), input, input.includes('提取'), expect.any(AbortSignal))
    expect(ask).not.toHaveBeenCalled()
  })
  it('re-reads stored reminders for persistence questions instead of trusting a previous answer', async () => {
    const reminders = vi.fn().mockReturnValue([])
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), personal: { reminders } as unknown as PersonalTools })
    current.rememberAnswer('创建提醒', '旧的提醒已保存', { savedReminder: { id: 'old', title: 'Old', dueAt: 123, level: 'strong' } })
    await current.send('我重启软件后，刚才的强提醒还在吗？')
    expect(reminders).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0][5]?.conversation?.toolNotes).toContain('"total":0')
    expect(current.snapshot().turns.at(-1)?.localResults).toContainEqual(expect.objectContaining({ tool: 'list_reminders', ok: true }))
  })
  it('stops speech directly and persists a text-only request without waiting for a model', async () => {
    const stopSpeaking = vi.fn(), setTtsEnabled = vi.fn().mockResolvedValue(undefined)
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), life: { stopSpeaking, setTtsEnabled } as unknown as LifeTools })
    await current.send('别说话了，后面都只显示文字。')
    expect(stopSpeaking).toHaveBeenCalledOnce()
    expect(setTtsEnabled).toHaveBeenCalledExactlyOnceWith(false)
    expect(ask).not.toHaveBeenCalled()
    expect(current.snapshot().turns.at(-1)?.state).toBe('done')
  })
  it('honors the intent model decision for ambiguous follow-ups and self-contained requests', async () => {
    session.rememberAnswer('Old question', 'Actual old answer')
    await session.send('How long does it take to boil an egg?', undefined, undefined, now, {}, false)
    expect(ask.mock.calls.at(-1)?.[5]?.conversation).toEqual({ messages: [], toolNotes: '' })
    session.rememberAnswer('Weather in Paris', 'Actual weather result')
    await session.send('And tomorrow?', undefined, undefined, now, {}, true)
    expect(JSON.stringify(ask.mock.calls.at(-1)?.[5]?.conversation)).toContain('Actual weather result')
  })
  it('answers consecutive current-window questions from each take, without a model or old ChatGPT context', async () => {
    const windows = new WindowsTools({ folders: { downloads: '.', desktop: '.', documents: '.' }, native: vi.fn(),
      openPath: vi.fn(), openUrl: vi.fn() })
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), windows })
    await current.send('这是什么窗口？', undefined, undefined, now, { appName: 'ChatGPT', windowTitle: 'ChatGPT conversation', processId: 123 })
    expect(current.snapshot().turns.at(-1)?.answer).toContain('ChatGPT')
    await current.send('这是什么窗口？', undefined, undefined, now, { appName: '飞书', windowTitle: '项目群', processId: 456 })
    expect(current.snapshot().turns.at(-1)?.answer).toContain('飞书')
    expect(current.snapshot().turns.at(-1)?.answer).not.toContain('ChatGPT')
    expect(ask).not.toHaveBeenCalled()
  })

  it('uses conversation only for references and follow-ups, not a fresh self-contained task', async () => {
    session.rememberAnswer('Old question', 'Private old answer', { savedNote: { id: 'old-note' } })
    await session.send('What is the capital of France?')
    expect(ask.mock.calls.at(-1)?.[5]?.conversation).toEqual({ messages: [], toolNotes: '' })
    session.rememberAnswer('Recent question', 'Actual recent answer')
    await session.send('Explain that answer in more detail')
    expect(JSON.stringify(ask.mock.calls.at(-1)?.[5]?.conversation)).toContain('Actual recent answer')
  })
  it('never displays a model-only cancellation as an executed mutation', async () => {
    const action = vi.fn(), reminders = () => [{ id: 'real-task', title: 'Clean', level: 'normal', status: 'pending', dueAt: null }]
    const personal = { reminders, action } as unknown as PersonalTools
    ask.mockResolvedValueOnce({ text: '已经取消了这条提醒。', sources: [], searched: false })
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), personal })
    await current.send('算了，这个提醒不要了。')
    expect(current.snapshot().turns[0]).toMatchObject({ state: 'error', answer: '本次未修改提醒或待办，请明确事项后重试' })
    expect(action).not.toHaveBeenCalled(); expect(reminders()[0].status).toBe('pending')
  })
  it('queries current task IDs for edits without a new model round or a second selector', async () => {
    const reminders = vi.fn().mockReturnValue([{ id: 'actual-strong-id', title: 'Call', level: 'strong', status: 'pending', dueAt: null }])
    const personal = { reminders } as unknown as PersonalTools
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), personal })
    await current.send('刚才那个强提醒改成普通提醒。')
    expect(reminders).toHaveBeenCalledOnce(); expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0][5]?.conversation?.toolNotes).toContain('actual-strong-id')
    expect(current.snapshot().turns[0].localResults).toContainEqual(expect.objectContaining({ tool: 'list_reminders', ok: true }))
  })
  it('keeps saved IDs available to follow-ups without showing raw receipts as the answer', async () => {
    session.rememberAnswer('Save my idea', 'Note saved', { savedNote: { id: 'actual-note-id' } })
    expect(session.snapshot().turns[0].answer).toBe('Note saved')
    await session.send('Tag that note')
    expect(JSON.stringify(ask.mock.calls[0][5]?.conversation?.messages)).toContain('actual-note-id')
    session.clear()
    expect(session.snapshot().turns).toEqual([])
  })
  it('only offers screenshot capture for explicit screen/image requests, preserving the original target', async () => {
    const analyzeScreenshot = vi.fn().mockResolvedValue('Actual screen content')
    const current = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), analyzeScreenshot })
    await current.send('Explain KISS')
    expect(ask.mock.calls[0][5]?.allowedTools).not.toContain('analyze_screenshot')
    const context = { appName: 'code', processId: 42, windowHandle: '1234' }
    await current.send('Analyze this screenshot', undefined, undefined, now, context)
    expect(ask).toHaveBeenCalledOnce()
    expect(analyzeScreenshot).toHaveBeenCalledWith(expect.objectContaining(context), 'Analyze this screenshot', false, expect.any(AbortSignal))
    expect(current.snapshot().turns.at(-1)?.answer).toBe('Actual screen content')
    await current.send('截一下当前窗口，帮我看看这个错误。', undefined, undefined, now, context)
    expect(analyzeScreenshot).toHaveBeenCalledTimes(2)
    await current.send('这张图表里的数据主要反映什么？', undefined, undefined, now, context)
    expect(analyzeScreenshot).toHaveBeenCalledTimes(3)
    await current.send('What is a screenshot?')
    expect(analyzeScreenshot).toHaveBeenCalledTimes(3)
    await current.send('Which application is this window?')
    expect(analyzeScreenshot).toHaveBeenCalledTimes(3)
    await current.send('Extract text from this image', undefined, undefined, now, context)
    expect(analyzeScreenshot).toHaveBeenLastCalledWith(expect.objectContaining(context), 'Extract text from this image', true, expect.any(AbortSignal))
    await current.send('How do I fix that?')
    expect(ask.mock.calls.at(-1)?.[5]?.conversation?.toolNotes).toContain('Actual screen content')
    expect(ask.mock.calls.at(-1)?.[5]?.conversation?.toolNotes).toContain('"ok":true')
  })
  it('passes the original application snapshot to Ask without detecting another foreground window', async () => {
    const context = { appName: 'code', windowTitle: 'Original document', processId: 42, windowHandle: '1234' }
    await session.send('Which application am I using?', undefined, undefined, now, context)
    expect(ask.mock.calls[0][2]).toMatchObject(context)
    expect(ask.mock.calls[0][2].task?.target).toMatchObject(context)
  })
  it('uses the configured provider, existing Ask and its own bounded conversation', async () => {
    await session.send('Hello')
    const firstConversation = ask.mock.calls[0][5]!.conversation
    await session.send('Explain that')
    expect(ask.mock.calls[1][5]!.conversation).toBe(firstConversation)
    expect(ask.mock.calls[0][0].polish).toMatchObject({ model: 'model', apiKey: 'private' })
    expect(ask.mock.calls[0][2].task).toMatchObject({ source: 'text', originalInput: 'Hello' })
    expect(ask.mock.calls[0][5]?.allowedTools).toEqual(ASSISTANT_TOOLS)
    expect(session.snapshot().turns.map(t => t.state)).toEqual(['done', 'done'])
    const snapshot = session.snapshot(); snapshot.turns[0].answer = 'modified'
    expect(session.snapshot().turns[0].answer).toBe('Actual answer')
  })

  it('keeps only 12 visible turns and expires idle context without polling', async () => {
    for (let i = 0; i < 15; i++) await session.send(`Question ${i}`)
    expect(session.snapshot().turns).toHaveLength(12)
    now += 15 * 60_000
    expect(session.snapshot().turns).toEqual([])
    expect(ask.mock.calls.at(-1)![5]!.conversation?.messages).toEqual([])
  })

  it('does not start a request for empty, oversized or unconfigured input', async () => {
    await expect(session.send(' ')).rejects.toThrow()
    await expect(session.send('x'.repeat(10001))).rejects.toThrow()
    const empty = new AssistantSession({ settings: () => mergeSettings({}), ask, changed, log: vi.fn() })
    await expect(empty.send('hello')).rejects.toThrow()
    expect(ask).not.toHaveBeenCalled()
  })

  it('cancels partial output and ignores late results after a fresh request', async () => {
    let release!: (result: Awaited<ReturnType<typeof askAgent>>) => void
    ask.mockImplementationOnce(async (_s, _q, _c, _signal, _log, options) => {
      options?.onDelta?.('Partial')
      return new Promise(resolve => { release = resolve })
    })
    const old = session.send('First')
    await expect(session.send('Concurrent')).rejects.toThrow()
    session.cancel()
    expect(ask.mock.calls[0][3]?.aborted).toBe(true)
    expect(session.snapshot().turns[0]).toMatchObject({ answer: 'Partial', state: 'cancelled' })
    await session.send('Second')
    release({ text: 'Stale', searched: false, sources: [] }); await old
    expect(session.snapshot().turns.at(-1)?.answer).toBe('Actual answer')
    expect(session.busy).toBe(false)
  })

  it('external recording cancellation cancels the assistant and clearing removes all context', async () => {
    ask.mockImplementationOnce(async (_s, _q, _c, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    }))
    const controller = new AbortController()
    const sending = session.send('Voice', controller.signal)
    controller.abort()
    await sending
    expect(session.busy).toBe(false)
    expect(session.snapshot().turns[0].state).toBe('cancelled')
    session.clear()
    expect(session.snapshot().turns).toEqual([])
  })

  it('shows provider errors and permits a clean retry', async () => {
    ask.mockRejectedValueOnce(Error('Offline'))
    await session.send('Question')
    expect(session.snapshot().turns[0]).toMatchObject({ state: 'error', answer: 'Offline' })
    await session.send('Retry')
    expect(session.snapshot().turns[1].state).toBe('done')
  })

  it('reports a saved calendar event when a later reminder fails', async () => {
    ask.mockImplementationOnce(async (_s, _q, _c, _signal, _log, options) => {
      options?.onLocalResult?.({ tool: 'create_event', ok: true, summary: '日程已保存：讨论' })
      options?.onLocalResult?.({ tool: 'create_reminder', ok: false, summary: '提醒时间不明确' })
      throw Error('提醒时间不明确')
    })
    await session.send('帮我安排明天下午的讨论，然后提醒我带资料')
    const turn = session.snapshot().turns.at(-1)!
    expect(turn.state).toBe('error')
    expect(turn.answer).toContain('日程已保存：讨论')
    expect(turn.answer).toContain('提醒时间不明确')
    expect(turn.answer).toContain('已完成的操作：')
  })
})

it('filters tool schemas and rejects unauthorized selection access before touching the clipboard', async () => {
  const readClipboard = vi.fn()
  expect(toolSchemas(ASSISTANT_TOOLS).map(t => (t.function as { name: string }).name)).not.toContain('get_selection')
  const result = await runTool('get_selection', {}, { settings, question: 'read', log: vi.fn(),
    allowedTools: ASSISTANT_TOOLS, selectionDeps: { readClipboard } })
  expect(result.ok).toBe(false)
  expect(readClipboard).not.toHaveBeenCalled()
})


it('shares only completed Ask answers with the bounded temporary session', async () => {
  session.rememberAnswer('Why?', 'Actual explanation')
  session.rememberAnswer('Why?', 'Actual explanation')
  expect(session.snapshot().turns).toHaveLength(1)
  await session.send('Save that answer to my notes')
  expect(ask.mock.calls[0][5]?.conversation?.messages).toEqual([
    { role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Actual explanation' }
  ])
  now += 15 * 60_000
  expect(session.snapshot().turns).toEqual([])
})

describe('life capabilities in the ask prompt', () => {
  it('still tells the model the capability is missing when no life tools are wired', async () => {
    const quiet = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), now: () => now })
    await quiet.send('Explain caching')
    const prompt = ask.mock.calls.at(-1)?.[0].polish.askPrompt ?? ''
    expect(prompt).toContain('not connected as assistant tools yet')
    expect(prompt).not.toContain('long-term memory')
    expect(prompt.trim().endsWith('report the actual failure.')).toBe(true)
  })
})

/** 2026-08-25, so the duration hints stay timezone independent. */
const at = (hour: number, minute = 0): number => new Date(2026, 7, 25, hour, minute).getTime()

const rows = (): ReferenceItem[] => [
  { id: 'e1', title: '项目讨论', fields: { id: 'e1', title: '项目讨论', start: at(14), end: at(15), allDay: false } },
  { id: 'e2', title: '评审', fields: { id: 'e2', title: '评审', start: at(16), end: at(17), allDay: false } },
  { id: 'e3', title: '面试', fields: { id: 'e3', title: '面试', start: at(18), end: at(18, 30), allDay: false } }
]

const thread = (items: ReferenceItem[] = rows(), lastObject?: ReferenceItem): ReferenceContext => ({ tool: 'list_events', items, lastObject })

describe('resolveReference', () => {
  it('reads a Chinese and an Arabic ordinal the same way', () => {
    expect(resolveReference('第二条改成十一点', thread())).toMatchObject({ kind: 'ordinal', index: 1, item: { id: 'e2' } })
    expect(resolveReference('把第 2 条改成十一点', thread())).toMatchObject({ kind: 'ordinal', index: 1, item: { id: 'e2' } })
    expect(resolveReference('第一个', thread())).toMatchObject({ kind: 'ordinal', index: 0, item: { id: 'e1' } })
    expect(resolveReference('第十二条', thread(Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, title: `T${index}`, fields: {} })))))
      .toMatchObject({ kind: 'ordinal', index: 11 })
  })
  it('counts English ordinals too', () => {
    expect(resolveReference('Change the second one to 11am', thread())).toMatchObject({ kind: 'ordinal', index: 1 })
  })
  it('treats "最后一个" as the tail of the same list', () => {
    expect(resolveReference('最后一个改成十一点', thread())).toMatchObject({ kind: 'last', index: 2, item: { id: 'e3' } })
  })
  it('asks instead of guessing when there is no context at all', () => {
    const outcome = resolveReference('第二个改成十一点', null)
    expect(outcome).toMatchObject({ kind: 'clarify' })
    expect(outcome.kind === 'clarify' ? outcome.question : '').toContain('哪一条')
  })
  it('asks when the ordinal points past the list the user saw', () => {
    const outcome = resolveReference('第五个', thread())
    expect(outcome).toMatchObject({ kind: 'clarify' })
    expect(outcome.kind === 'clarify' ? outcome.question : '').toContain('3')
  })
  it('asks when several rows could be "刚才那条"', () => {
    const outcome = resolveReference('刚才那条改成下午三点', thread())
    expect(outcome).toMatchObject({ kind: 'clarify' })
    expect(outcome.kind === 'clarify' ? outcome.question : '').toContain('项目讨论')
  })
  it('resolves "刚才那条" to the single object the last turn wrote', () => {
    const written: ReferenceItem = { id: 'e9', title: '周会', fields: { id: 'e9', title: '周会', start: at(9), end: at(10) } }
    expect(resolveReference('刚才那条改成十一点', thread([], written))).toMatchObject({ kind: 'ambient', item: { id: 'e9' } })
    expect(resolveReference('上一个改成十一点', thread([], written))).toMatchObject({ kind: 'ambient', item: { id: 'e9' } })
  })
  it('never treats dictated or quoted text as a pointer', () => {
    expect(resolveReference('"第二个"用英文怎么说', thread())).toEqual({ kind: 'none' })
    expect(resolveReference('这段需求：第二个改成十一点', thread())).toEqual({ kind: 'none' })
  })
  it('ignores an ambient word that asks for nothing', () => {
    expect(resolveReference('这个日程是什么意思', thread())).toEqual({ kind: 'none' })
  })
  it('declines a time ordinal such as "第一次"', () => {
    expect(resolveReference('第一次提醒是什么时候', thread())).toEqual({ kind: 'none' })
  })
})

describe('referenceEditHint', () => {
  it('keeps the duration when only a new start is given', () => {
    const hint = referenceEditHint(rows()[0]) ?? ''
    expect(hint).toContain('14:00')
    expect(hint).toContain('15:00')
    expect(hint).toContain('时长 60 分钟')
    expect(hint).toContain('只改开始时间')
  })
  it('offers no schedule rule for a row without an end', () => {
    expect(referenceEditHint({ id: 't1', title: '交周报', fields: { id: 't1', title: '交周报', dueAt: at(16) } })).toBeNull()
  })
})

describe('referenceBlock', () => {
  it('lists the rows in the order the user saw them, with real ids', () => {
    const block = referenceBlock(thread(), resolveReference('第二个', thread()))
    expect(block).toContain('1. 项目讨论（id=e1）')
    expect(block).toContain('2. 评审（id=e2）')
    expect(block).toContain('「第 2 条」= 评审（id=e2）')
    expect(block).toContain('"start"')
    expect(block).toContain('时长 60 分钟')
  })
  it('says nothing when there is neither context nor a pointer', () => {
    expect(referenceBlock(null, { kind: 'none' })).toBe('')
  })
})

describe('referenceContextFrom', () => {
  it('keeps list rows in order and leaves a list without a written object', () => {
    const context = referenceContextFrom({ ok: true, data: { items: [{ id: 'e1', title: 'A' }, { id: 'e2', title: 'B' }] } }, 'list_events')
    expect(context).toMatchObject({ tool: 'list_events' })
    expect(context?.items.map(item => item.id)).toEqual(['e1', 'e2'])
    expect(context?.lastObject).toBeUndefined()
  })
  it('takes the written row rather than the values it replaced', () => {
    const context = referenceContextFrom({ ok: true, data: {
      item: { id: 'e7', title: 'C', start: at(9), end: at(10) },
      before: { id: 'e7', title: 'C', start: at(8), end: at(9) }
    } }, 'manage_event')
    expect(context?.lastObject).toMatchObject({ id: 'e7', fields: { start: at(9) } })
  })
  it('ignores rows without an id or a title', () => {
    expect(referenceContextFrom({ ok: true, data: { items: [{ id: 'x' }, { title: 'y' }] } })).toBeNull()
  })
  it('reads rows back out of the rendered thread notes', () => {
    const notes = `[1] list_events\n{"ok":true,"data":{"items":[{"id":"e1","title":"项目讨论","start":${at(14)},"end":${at(15)}}]}}`
    expect(referenceContextFromNotes(notes)?.items.map(item => item.id)).toEqual(['e1'])
    expect(referenceContextFromNotes('')).toBeNull()
    expect(referenceContextFromNotes('{not json')).toBeNull()
  })
})

describe('assistant session references', () => {
  it('hands the resolved id and its fields to the model for "第二个"', async () => {
    session.rememberAnswer('我的日程', '两个日程', { name: 'list_events', ok: true,
      data: { items: rows().map(row => row.fields) } })
    await session.send('把第二个改成十一点')
    const prompt = ask.mock.calls.at(-1)?.[0].polish.askPrompt ?? ''
    expect(prompt).toContain('「第 2 条」= 评审（id=e2）')
    expect(prompt).toContain(String(at(16)))
    expect(prompt).toContain('时长 60 分钟')
    expect(prompt).toContain('最近 3 轮对话')
    expect(session.snapshot().turns.at(-1)?.state).toBe('done')
  })
  it('asks the user instead of calling the model when a pointer has no rows', async () => {
    await session.send('第二个改成十一点')
    expect(ask).not.toHaveBeenCalled()
    expect(session.snapshot().turns[0]).toMatchObject({ state: 'done' })
    expect(session.snapshot().turns[0].answer).toContain('哪一条')
  })
  it('asks which one when the last turn left several rows and no single object', async () => {
    session.rememberAnswer('我的日程', '三个日程', { name: 'list_events', ok: true, data: { items: rows().map(row => row.fields) } })
    await session.send('刚才那条改成下午三点')
    expect(ask).not.toHaveBeenCalled()
    expect(session.snapshot().turns.at(-1)?.answer).toContain('项目讨论')
  })
})
