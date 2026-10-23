import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { AssistantSession, ASSISTANT_TOOLS } from './assistant'
import { askAgent } from './agent'
import { runTool, toolSchemas } from './tools/registry'

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
