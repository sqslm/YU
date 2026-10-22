import { describe, expect, it, vi } from 'vitest'
import { SelectionEditor } from './selection-editor'

function harness() {
  const apply = vi.fn(async () => {})
  const deps = {
    capture: vi.fn(async () => ({ text: '原选区', context: { appName: 'Editor' }, apply })),
    transform: vi.fn(async () => ({ text: '修改后', promptName: '日常润色' })),
    busy: vi.fn(() => false), cancel: vi.fn(), show: vi.fn(), hide: vi.fn()
  }
  return { editor: new SelectionEditor(deps), deps, apply }
}

describe('selection preview lifecycle', () => {
  it('does not call a model until the operation is chosen and only edits after confirmation', async () => {
    const { editor, deps, apply } = harness()
    await editor.open()
    expect(deps.transform).not.toHaveBeenCalled()
    await editor.action('selection-polish')
    expect(deps.transform).toHaveBeenCalledWith('原选区', 'polish', { appName: 'Editor' })
    expect(apply).not.toHaveBeenCalled()
    expect(deps.show.mock.calls.at(-1)?.[0]).toMatchObject({ answer: '修改后', tools: ['日常润色'] })
    await editor.action('selection-replace')
    expect(apply).toHaveBeenCalledWith('修改后', false, expect.any(AbortSignal))
  })

  it('supports translation and explicit append; a failed target check leaves a usable preview', async () => {
    const { editor, deps, apply } = harness()
    apply.mockRejectedValueOnce(new Error('选区已变化'))
    await editor.open()
    await editor.action('selection-translate')
    await editor.action('selection-append')
    expect(apply).toHaveBeenCalledWith('修改后', true, expect.any(AbortSignal))
    expect(deps.show.mock.calls.at(-1)?.[0]).toMatchObject({ answer: '修改后', streaming: false, status: '选区已变化' })
  })

  it('stops an old operation without letting its late result overwrite the next operation', async () => {
    const { editor, deps } = harness()
    let finish!: (result: { text: string; promptName: string }) => void
    deps.transform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await editor.open()
    const old = editor.action('selection-polish')
    await editor.action('stop')
    await editor.action('selection-translate')
    finish({ text: '旧结果', promptName: '旧卡片' })
    await old
    expect(deps.cancel).toHaveBeenCalledOnce()
    expect(deps.show.mock.calls.at(-1)?.[0].answer).toBe('修改后')
    editor.cancel()
    await editor.action('selection-replace')
    expect(deps.hide).not.toHaveBeenCalled()
  })

  it('reports no selection or a busy voice task without starting a request', async () => {
    const { editor, deps } = harness()
    deps.busy.mockReturnValueOnce(true)
    await editor.open()
    expect(deps.capture).not.toHaveBeenCalled()
    deps.capture.mockRejectedValueOnce(new Error('没有选中文字'))
    await editor.open()
    expect(deps.show.mock.calls.at(-1)?.[0]).toMatchObject({ status: '没有选中文字', actions: [] })
    expect(deps.transform).not.toHaveBeenCalled()
  })
})
