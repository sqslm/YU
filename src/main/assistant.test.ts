import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { AssistantSession, ASSISTANT_TOOLS } from './assistant'
import { askAgent } from './agent'
import { runTool, toolSchemas } from './tools/registry'
import type { PersonalTools } from './tools/personal'
import { WindowsTools } from './tools/windows'

const settings = mergeSettings({ profiles: [{ id: 'text', kind: 'llm', name: 'Text', enabled: true,
  preset: '', baseUrl: 'https://example.com/v1', apiKey: 'private', model: 'model' }], chains: { llm: ['text'], asr: [], multimodal: [] } })
let now = 1000
let ask: ReturnType<typeof vi.fn<typeof askAgent>>
let changed: ReturnType<typeof vi.fn>
let session: AssistantSession
beforeEach(() => {
  now = 1000
  ask = vi.fn<typeof askAgent>().mockResolvedValue({ text: 'Actual answer', sources: [], searched: false })
  changed = vi.fn()
  session = new AssistantSession({ settings: () => settings, ask, changed, log: vi.fn(), now: () => now })
})

describe('assistant session', () => {
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
      confirm: vi.fn(), openPath: vi.fn(), openUrl: vi.fn() })
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
    expect(analyzeScreenshot).toHaveBeenCalledWith(context, 'Analyze this screenshot', false, expect.any(AbortSignal))
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
    expect(analyzeScreenshot).toHaveBeenLastCalledWith(context, 'Extract text from this image', true, expect.any(AbortSignal))
    await current.send('How do I fix that?')
    expect(ask.mock.calls.at(-1)?.[5]?.conversation?.toolNotes).toContain('Actual screen content')
    expect(ask.mock.calls.at(-1)?.[5]?.conversation?.toolNotes).toContain('"ok":true')
  })
  it('passes the original application snapshot to Ask without detecting another foreground window', async () => {
    const context = { appName: 'code', windowTitle: 'Original document', processId: 42, windowHandle: '1234' }
    await session.send('Which application am I using?', undefined, undefined, now, context)
    expect(ask.mock.calls[0][2]).toEqual(context)
  })
  it('uses the configured provider, existing Ask and its own bounded conversation', async () => {
    await session.send('Hello')
    const firstConversation = ask.mock.calls[0][5]!.conversation
    await session.send('Explain that')
    expect(ask.mock.calls[1][5]!.conversation).toBe(firstConversation)
    expect(ask.mock.calls[0][0].polish).toMatchObject({ model: 'model', apiKey: 'private' })
    expect(ask.mock.calls[0][2]).toEqual({})
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
