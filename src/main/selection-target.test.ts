import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'

const mocks = vi.hoisted(() => ({
  foreground: 10, pid: 42, exists: true, restore: true,
  selected: vi.fn(), insert: vi.fn(), key: vi.fn()
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
vi.mock('./insert', () => ({ insertText: mocks.insert }))
import { captureSelectionTarget } from './selection-target'

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
  it('appends using Ctrl+End, preserving the original selected text', async () => {
    const target = await captureSelectionTarget(mergeSettings({}))
    await target.apply('translation', true, new AbortController().signal)
    expect(mocks.key.mock.calls.map(args => args[0])).toEqual([0x11, 0x23, 0x23, 0x11])
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
})
