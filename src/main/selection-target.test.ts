import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'

const mocks = vi.hoisted(() => ({
  foreground: 10, pid: 42, exists: true, restore: true,
  selected: vi.fn(), insert: vi.fn(), key: vi.fn(), release: vi.fn()
}))
vi.mock('koffi', () => ({ default: {
  address: (handle: number) => handle,
  load: () => ({ func: (declaration: string) => {
    if (declaration.includes('GetForegroundWindow')) return () => mocks.foreground
    if (declaration.includes('SetForegroundWindow')) return (handle: number) => { if (mocks.restore) mocks.foreground = handle; return mocks.restore ? 1 : 0 }
    if (declaration.includes('GetWindowThreadProcessId')) return (_handle: number, buffer: Buffer) => { buffer.writeUInt32LE(mocks.pid); return 1 }
    if (declaration.includes('IsWindow')) return () => mocks.exists ? 1 : 0
    return mocks.key
  } })
} }))
vi.mock('./foreground', () => ({ foregroundWindow: () => ({ appName: 'Editor', title: 'Document', pid: 42, appPath: 'editor.exe' }) }))
vi.mock('./tools/selection', () => ({ getSelection: mocks.selected }))
vi.mock('./insert', () => ({ insertText: mocks.insert, releaseStuckModifiers: mocks.release }))
import { createTask, attachTask } from './task-context'
import { captureSelectionTarget, applyAnswerSelection } from './selection-target'

describe('applying a captured selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks, { foreground: 10, pid: 42, exists: true, restore: true })
    mocks.selected.mockResolvedValue({ ok: true, text: 'selected' })
  })
  it('restores the original window and checks the selection before replacing', async () => {
    const target = await captureSelectionTarget(mergeSettings({}))
    mocks.foreground = 99
    await target.apply('rewritten', false, new AbortController().signal)
    expect(mocks.foreground).toBe(10)
    expect(mocks.insert).toHaveBeenCalledWith('rewritten', expect.objectContaining({ multiline: 'keep' }))
    expect(mocks.key).not.toHaveBeenCalled()
  })
  it('appends at the selected range end, preserving text after that range', async () => {
    const target = await captureSelectionTarget(mergeSettings({}))
    await target.apply('translation', true, new AbortController().signal)
    expect(mocks.key.mock.calls.map(args => args[0])).toEqual([0x27, 0x27])
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.key.mock.invocationCallOrder[0])
    expect(mocks.insert).toHaveBeenCalledWith('\ntranslation', expect.anything())
  })
  it('does not insert into a changed selection, closed window or different process', async () => {
    const target = await captureSelectionTarget(mergeSettings({}))
    mocks.selected.mockResolvedValueOnce({ ok: true, text: 'different' })
    await expect(target.apply('result', false, new AbortController().signal)).rejects.toThrow('选区已变化')
    mocks.exists = false
    await expect(target.apply('result', false, new AbortController().signal)).rejects.toThrow('无法返回')
    mocks.exists = true; mocks.pid = 13
    await expect(target.apply('result', false, new AbortController().signal)).rejects.toThrow('无法返回')
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('drops an edit canceled while restoring focus', async () => {
    const target = await captureSelectionTarget(mergeSettings({}))
    const controller = new AbortController()
    const work = target.apply('result', false, controller.signal)
    controller.abort()
    await expect(work).rejects.toThrow()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('validates the original assistant target before reading a selection and refuses changed titles or processes', async () => {
    const target = { windowHandle: '10', processId: 42, windowTitle: 'Document', appName: 'Editor' }
    const captured = await captureSelectionTarget(mergeSettings({}), target, new AbortController().signal)
    expect(captured.text).toBe('selected')
    mocks.selected.mockClear(); mocks.pid = 99
    await expect(captureSelectionTarget(mergeSettings({}), target)).rejects.toThrow('无法返回')
    expect(mocks.selected).not.toHaveBeenCalled()
    mocks.pid = 42
    await expect(captureSelectionTarget(mergeSettings({}), { ...target, windowTitle: 'Changed' })).rejects.toThrow('目标窗口已变化')
    await expect(captureSelectionTarget(mergeSettings({}), { ...target, appName: 'Bitwarden' })).rejects.toThrow('敏感应用')
    expect(mocks.selected).not.toHaveBeenCalled()
  })
})

it('refuses card replacement without an authorized selection or after the selected text changes', async () => {
  vi.clearAllMocks(); Object.assign(mocks, { foreground: 10, pid: 42, exists: true, restore: true })
  await expect(applyAnswerSelection(mergeSettings({}), undefined, 'answer', new AbortController().signal)).rejects.toThrow()
  const task = createTask('text', { windowHandle: '10', processId: 42, windowTitle: 'Document' }); task.selection = 'old selection'
  mocks.selected.mockResolvedValue({ ok: true, text: 'different selection' })
  await expect(applyAnswerSelection(mergeSettings({}), attachTask({}, task), 'answer', new AbortController().signal)).rejects.toThrow('选区内容已变化')
  expect(mocks.insert).not.toHaveBeenCalled()
  mocks.selected.mockResolvedValue({ ok: true, text: 'old selection' })
  await applyAnswerSelection(mergeSettings({}), attachTask({}, task), 'answer', new AbortController().signal)
  expect(task.state).toBe('completed')
  expect(mocks.insert).toHaveBeenCalledWith('answer', expect.any(Object))
})
