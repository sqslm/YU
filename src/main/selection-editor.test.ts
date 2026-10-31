import { describe, expect, it, vi } from 'vitest'
import { SelectionEditor } from './selection-editor'
function harness() {
  const apply = vi.fn(async () => {})
  const deps = { capture: vi.fn(async () => ({ text: '原选区', context: { appName: 'Editor' }, apply })),
    transform: vi.fn(async () => ({ text: '修改后', promptName: '日常润色' })),
    busy: vi.fn(() => false), cancel: vi.fn(), status: vi.fn() }
  return { editor: new SelectionEditor(deps), deps, apply }
}
describe('direct selection shortcuts', () => {
  it.each([['polish', false], ['translate', true]] as const)('runs %s and applies directly (append=%s)', async (operation, append) => {
    const { editor, deps, apply } = harness()
    await editor.run(operation, append)
    expect(deps.transform).toHaveBeenCalledWith('原选区', operation, { appName: 'Editor' })
    expect(apply).toHaveBeenCalledWith('修改后', append, expect.any(AbortSignal))
    expect(editor.isBusy).toBe(false)
  })
  it('reports an invalid target without retrying or overwriting it', async () => {
    const { editor, deps, apply } = harness()
    apply.mockRejectedValueOnce(new Error('选区已变化'))
    await editor.run('polish', false)
    expect(deps.status).toHaveBeenCalledWith('选区已变化', true)
    expect(apply).toHaveBeenCalledOnce()
  })
  it('ignores a late result after cancellation and permits another operation', async () => {
    const { editor, deps, apply } = harness()
    let finish!: (result: { text: string; promptName: string }) => void
    deps.transform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = editor.run('polish', false)
    await vi.waitFor(() => expect(deps.transform).toHaveBeenCalledOnce())
    editor.cancel()
    await editor.run('translate', true)
    finish({ text: '旧结果', promptName: '旧卡片' }); await first
    expect(deps.cancel).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith('修改后', true, expect.any(AbortSignal))
  })
  it('does not call a model without a selection or while a voice task is busy', async () => {
    const { editor, deps } = harness()
    deps.busy.mockReturnValueOnce(true); await editor.run('polish', false)
    expect(deps.capture).not.toHaveBeenCalled()
    deps.capture.mockRejectedValueOnce(new Error('没有选中文字')); await editor.run('translate', false)
    expect(deps.status).toHaveBeenCalledWith('没有选中文字', true)
    expect(deps.transform).not.toHaveBeenCalled()
  })
})

describe('selection edits reach history (需求5)', () => {
  /**
   * The deps of the shortcut path, plus the writer the app wires in. The editor
   * owns no store: it hands over the row's content once the text is in place.
   */
  function recording(overrides: Partial<{ result: Record<string, unknown>; context: Record<string, unknown> }> = {}) {
    const record = vi.fn()
    const apply = vi.fn(async () => {})
    type TransformResult = {
      text: string
      promptName: string
      promptId?: string
      promptKind?: 'polish'
      providerId?: string
      providerName?: string
    }
    const transform = vi.fn(async (): Promise<TransformResult | null> => ({
      text: '修改后',
      promptName: '日常润色',
      promptId: 'card-1',
      promptKind: 'polish' as const,
      providerId: 'llm-test',
      providerName: 'test-llm',
      ...overrides.result
    }))
    const deps = {
      capture: vi.fn(async () => ({ text: '原选区', context: overrides.context ?? { appName: 'Editor', windowTitle: 'index.ts' }, apply })),
      transform,
      busy: vi.fn(() => false), cancel: vi.fn(), status: vi.fn(), record
    }
    return { editor: new SelectionEditor(deps), deps, apply, record }
  }

  it.each([['polish', 'polish'], ['translate', 'translate']] as const)(
    'files a landed %s under its own operation and window',
    async (operation, expected) => {
      const { editor, record, apply } = recording()
      await editor.run(operation, false)
      expect(apply).toHaveBeenCalledWith('修改后', false, expect.any(AbortSignal))
      expect(record).toHaveBeenCalledOnce()
      expect(record).toHaveBeenCalledWith({
        operation,
        original: '原选区',
        result: '修改后',
        app: 'Editor',
        promptName: '日常润色',
        promptId: 'card-1',
        promptKind: 'polish',
        providerId: 'llm-test',
        providerName: 'test-llm',
        processingMs: expect.any(Number)
      })
      expect(record.mock.calls[0][0].operation).toBe(expected)
    }
  )

  it('files nothing when the selection could not be replaced', async () => {
    const { editor, record, apply, deps } = recording()
    apply.mockRejectedValueOnce(new Error('选区已变化'))
    await editor.run('polish', false)
    expect(record).not.toHaveBeenCalled()
    expect(deps.status).toHaveBeenCalledWith('选区已变化', true)
  })

  it('files nothing after a cancel, and nothing when the model returns no result', async () => {
    const cancelled = recording()
    let finish!: (value: { text: string; promptName: string }) => void
    cancelled.deps.transform.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve }))
    const running = cancelled.editor.run('polish', false)
    await vi.waitFor(() => expect(cancelled.deps.transform).toHaveBeenCalledOnce())
    cancelled.editor.cancel()
    finish({ text: '迟到结果', promptName: '卡片' })
    await running
    expect(cancelled.record).not.toHaveBeenCalled()

    const empty = recording()
    empty.deps.transform.mockResolvedValueOnce(null)
    await empty.editor.run('translate', false)
    expect(empty.record).not.toHaveBeenCalled()
  })

  it('stays quiet when the host has no history writer or the write fails', async () => {
    const wired = recording()
    wired.record.mockReset() // no record dep at all
    const noWriter = new SelectionEditor({
      capture: wired.deps.capture, transform: wired.deps.transform, busy: wired.deps.busy,
      cancel: wired.deps.cancel, status: wired.deps.status
    })
    await noWriter.run('polish', false)
    expect(wired.apply).toHaveBeenCalledOnce()

    const failing = recording()
    failing.record.mockRejectedValueOnce(new Error('disk full'))
    await failing.editor.run('polish', false)
    await Promise.resolve()
    // A history write is best effort: the edit already reached the document, so
    // its failure must not be reported as a failed edit.
    expect(failing.deps.status).toHaveBeenCalledWith('已替换选中文字')
    expect(failing.deps.status).not.toHaveBeenCalledWith(expect.stringContaining('disk full'), true)
    expect(failing.editor.isBusy).toBe(false)

    const throwing = recording()
    throwing.record.mockImplementationOnce(() => { throw new Error('store is closed') })
    await throwing.editor.run('translate', true)
    expect(throwing.deps.status).toHaveBeenCalledWith('已追加到选区末尾')
  })
})

