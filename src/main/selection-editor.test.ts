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
