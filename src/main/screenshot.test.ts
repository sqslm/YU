import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ native: vi.fn(), sources: vi.fn() }))
vi.mock('electron', () => ({ desktopCapturer: { getSources: mocks.sources } }))
vi.mock('./windows-native', () => ({ windowsNative: mocks.native }))
import { captureOriginalWindow } from './screenshot'
const context = { appName: 'code', windowTitle: 'Original project', processId: 42, windowHandle: '1234' }
const thumbnail = () => ({ isEmpty: () => false, toPNG: () => Buffer.from('owned-image'), getSize: () => ({ width: 1200, height: 700 }) })
beforeEach(() => { vi.clearAllMocks(); mocks.native.mockResolvedValue({ valid: true }); mocks.sources.mockResolvedValue([{ id: 'window:9999:1', thumbnail: thumbnail() }, { id: 'window:1234:0', thumbnail: thumbnail() }]) })
describe('one-task original window screenshots', () => {
  it('selects the original HWND instead of the assistant, without a full-screen fallback', async () => {
    const image = await captureOriginalWindow(context, new AbortController().signal)
    expect(image).toMatchObject({ width: 1200, height: 700, title: context.windowTitle })
    expect(image.png).toEqual(Buffer.from('owned-image'))
    expect(mocks.sources).toHaveBeenCalledExactlyOnceWith({ types: ['window'], thumbnailSize: { width: 1600, height: 1200 }, fetchWindowIcons: false })
    expect(mocks.native).toHaveBeenCalledTimes(2)
    expect(mocks.native).toHaveBeenCalledWith({ action: 'window-check', handle: '1234', pid: 42, title: context.windowTitle }, expect.any(AbortSignal))
  })
  it('does not capture sensitive apps, an unavailable original target or a minimized/closed window', async () => {
    await expect(captureOriginalWindow({ ...context, appName: 'Bitwarden' }, new AbortController().signal)).rejects.toThrow('敏感应用')
    await expect(captureOriginalWindow({}, new AbortController().signal)).rejects.toThrow('原窗口')
    mocks.native.mockRejectedValueOnce(new Error('Original window is minimized'))
    await expect(captureOriginalWindow(context, new AbortController().signal)).rejects.toThrow('minimized')
    expect(mocks.sources).not.toHaveBeenCalled()
  })
  it('does not substitute another window when capture fails or the original closes during capture', async () => {
    mocks.sources.mockResolvedValueOnce([{ id: 'window:9999:1', thumbnail: thumbnail() }])
    await expect(captureOriginalWindow(context, new AbortController().signal)).rejects.toThrow('窗口截图失败')
    mocks.native.mockResolvedValueOnce({ valid: true }).mockRejectedValueOnce(new Error('Original window closed'))
    await expect(captureOriginalWindow(context, new AbortController().signal)).rejects.toThrow('closed')
  })
  it('drops an image when cancelled while the capture provider is still returning it', async () => {
    const controller = new AbortController()
    mocks.sources.mockImplementationOnce(async () => { controller.abort(); return [{ id: 'window:1234:0', thumbnail: thumbnail() }] })
    await expect(captureOriginalWindow(context, controller.signal)).rejects.toThrow()
    expect(mocks.native).toHaveBeenCalledTimes(1)
  })
})
