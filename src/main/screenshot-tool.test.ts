import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'
import type { ScreenshotAction } from '@shared/screenshot'

const mocks = vi.hoisted(() => ({ sources: vi.fn(), image: vi.fn(), copyImage: vi.fn(), copyText: vi.fn(), save: vi.fn(), write: vi.fn(), native: vi.fn(), complete: vi.fn(), vision: vi.fn(), handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[] }))
vi.mock('electron', () => ({
  app: { getPath: () => '/pictures', getAppPath: () => '/app', getLocale: () => 'en-US' }, clipboard: { writeImage: mocks.copyImage, writeText: mocks.copyText },
  desktopCapturer: { getSources: mocks.sources }, nativeImage: { createFromDataURL: mocks.image }, dialog: { showSaveDialog: mocks.save },
  screen: { dipToScreenRect: () => ({ x: -1920, y: 0, width: 1920, height: 1080 }), getCursorScreenPoint: () => ({ x: -100, y: 50 }), getDisplayNearestPoint: () => ({ id: 42, scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 720 } }) },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() }); destroyed = false
    constructor(public options: unknown) { super(); mocks.windows.push(this) }
    setAlwaysOnTop = vi.fn(); loadFile = vi.fn(); loadURL = vi.fn(); show = vi.fn(); focus = vi.fn()
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true; this.emit('closed') }
  }
}))
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }))
vi.mock('./windows-native', () => ({ windowsNative: mocks.native }))
vi.mock('./capture-screen', () => ({ captureScreen: () => { throw Error('GDI unavailable in this test') } }))
vi.mock('./foreground', () => ({ captureWindowBounds: () => [{ x: -1800, y: 30, width: 1200, height: 900 }] }))
vi.mock('./ocr', async importOriginal => ({ ...await importOriginal<typeof import('./ocr')>(), prepareOcrImage: () => Buffer.from('ocr pixels') }))
vi.mock('./providers/llm', () => ({ complete: mocks.complete }))
vi.mock('./providers/gemini', () => ({ generateFromImage: mocks.vision }))
import { ScreenshotTool } from './screenshot-tool'

let settings: Settings, tool: ScreenshotTool
const active = vi.fn()
const imageUrl = 'data:image/png;base64,c2VsZWN0ZWQ='
const cropped = () => ({ isEmpty: () => false, getSize: () => ({ width: 600, height: 200 }), toPNG: () => Buffer.from('selected pixels') })
const event = (): any => { const win = mocks.windows.at(-1); return { sender: win.webContents, senderFrame: win.webContents.mainFrame } }
const run = (action: ScreenshotAction, url = imageUrl, question = 'Explain this error', target = 'en'): Promise<any> => mocks.handlers.get('screenshot:run')!(event(), action, url, question, target)
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.windows.length = 0
  mocks.sources.mockReset().mockResolvedValue([{ display_id: 'wrong', thumbnail: cropped() }, { display_id: '42', thumbnail: { ...cropped(), getSize: () => ({ width: 1920, height: 1080 }), toBitmap: () => Buffer.from([1, 2, 3, 255]) } }])
  mocks.image.mockReset().mockImplementation(cropped)
  mocks.native.mockReset().mockResolvedValue({ text: '真实 OCR 文字' }); mocks.complete.mockReset().mockResolvedValue('Real translation'); mocks.vision.mockReset().mockResolvedValue('Actual visual answer')
  mocks.save.mockReset().mockResolvedValue({ canceled: false, filePath: '/chosen/capture.png' })
  settings = mergeSettings({ profiles: [{ id: 'text', name: 'Text', preset: '', kind: 'llm', enabled: true, baseUrl: 'http://text.test', model: 'text-model', apiKey: 'private' },
    { id: 'vision', name: 'Vision', preset: '', kind: 'multimodal', enabled: true, baseUrl: 'http://vision.test', model: 'vision-model', apiKey: 'private' }] })
  tool = new ScreenshotTool(() => settings, active); tool.register()
})

describe('explicit screenshot tool', () => {
  it('closes a crashed renderer and restores global shortcuts immediately', async () => {
    await tool.open()
    mocks.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(tool.isOpen).toBe(false); expect(mocks.windows[0].destroyed).toBe(true)
    expect(active).toHaveBeenLastCalledWith(false)
  })
  it('captures only on demand, matches the cursor display by ID and never keeps a resident editor', async () => {
    expect(mocks.sources).not.toHaveBeenCalled()
    await tool.open()
    expect(mocks.sources).toHaveBeenCalledOnce()
    expect(mocks.sources.mock.calls[0][0]).toMatchObject({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
    expect(mocks.handlers.get('screenshot:frame')!(event())).toMatchObject({ width: 1920, pixels: Buffer.from([3, 2, 1, 255]), windows: [{ x: 80, y: 20, width: 800, height: 600 }] })
    expect(mocks.windows[0].options).toMatchObject({ x: -1280, width: 1280, frame: false, skipTaskbar: true })
    await tool.open(); expect(mocks.sources).toHaveBeenCalledOnce()
    tool.close(); expect(tool.isOpen).toBe(false); expect(active).toHaveBeenLastCalledWith(false)
  })
  it('shows the editor only after its captured first frame has been painted', async () => {
    await tool.open()
    mocks.windows[0].emit('ready-to-show')
    expect(mocks.windows[0].show).not.toHaveBeenCalled()
    mocks.handlers.get('screenshot:ready')!(event())
    expect(mocks.windows[0].show).toHaveBeenCalledOnce()
  })
  it('rejects screenshot and clipboard calls from any other renderer or subframe', async () => {
    await tool.open()
    expect(() => mocks.handlers.get('screenshot:frame')!({ sender: {} })).toThrow('Screenshot editor required')
    expect(() => mocks.handlers.get('screenshot:copy-text')!({ ...event(), senderFrame: {} }, 'secret')).toThrow('Screenshot editor required')
    expect(mocks.copyText).not.toHaveBeenCalled()
  })
  it('copies the selected PNG and releases the editor without a model or disk write', async () => {
    await tool.open(); await run('copy')
    expect(mocks.copyImage).toHaveBeenCalledOnce(); expect(tool.isOpen).toBe(false)
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })
  it('writes only the user-selected save path and keeps editing when the save dialog is cancelled', async () => {
    await tool.open(); mocks.save.mockResolvedValueOnce({ canceled: true })
    expect(await run('save')).toEqual({ saved: false }); expect(tool.isOpen).toBe(true); expect(mocks.write).not.toHaveBeenCalled()
    expect(await run('save')).toEqual({ saved: true }); expect(mocks.write).toHaveBeenCalledWith('/chosen/capture.png', Buffer.from('selected pixels'))
    expect(tool.isOpen).toBe(false)
  })
  it('runs OCR locally and translates only real OCR text using the existing text provider', async () => {
    await tool.open()
    expect(await run('ocr')).toEqual({ text: '真实 OCR 文字' }); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.vision).not.toHaveBeenCalled()
    expect(await run('translate')).toEqual({ text: 'Real translation' })
    expect(mocks.complete.mock.calls[0][0]).toMatchObject({ model: 'text-model' })
    expect(mocks.complete.mock.calls[0][1].messages[1].content).toBe('真实 OCR 文字')
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('into en')
  })
  it('sends only the selected PNG to the configured vision chain after an explicit Ask action', async () => {
    await tool.open(); expect(await run('ask')).toEqual({ text: 'Actual visual answer' })
    expect(mocks.vision.mock.calls[0][0]).toMatchObject({ model: 'vision-model' })
    expect(mocks.vision.mock.calls[0][1].png).toEqual(Buffer.from('selected pixels'))
    expect(mocks.vision.mock.calls[0][1].prompt).toContain('Explain this error')
    expect(mocks.native).not.toHaveBeenCalled()
  })
  it('defaults smart translation to the interface language and uses the system locale only if it is unavailable', async () => {
    await tool.open()
    settings.uiLanguage = 'zh'; await run('translate', imageUrl, '', 'auto')
    expect(mocks.complete.mock.calls.at(-1)?.[1].messages[0].content).toContain('into zh')
    settings.uiLanguage = 'en'; await run('translate', imageUrl, '', 'auto')
    expect(mocks.complete.mock.calls.at(-1)?.[1].messages[0].content).toContain('into en')
    settings.uiLanguage = undefined as never; await run('translate', imageUrl, '', 'auto')
    expect(mocks.complete.mock.calls.at(-1)?.[1].messages[0].content).toContain('into en')
    settings.uiLanguage = 'zh'; await run('translate', imageUrl, '', 'ja')
    expect(mocks.complete.mock.calls.at(-1)?.[1].messages[0].content).toContain('into ja')
  })
  it('does not fabricate text or a translation after OCR failure, and refuses vision without a configured model', async () => {
    await tool.open(); mocks.native.mockResolvedValueOnce({ text: '' })
    await expect(run('translate')).rejects.toThrow('截图中没有识别到文字'); expect(mocks.complete).not.toHaveBeenCalled()
    settings.profiles = settings.profiles.filter(row => row.kind !== 'multimodal')
    await expect(run('ask')).rejects.toThrow('当前文本模型不能查看截图'); expect(mocks.vision).not.toHaveBeenCalled()
  })
  it('rejects malformed, oversized and out-of-frame images before any model request', async () => {
    await tool.open(); await expect(run('ask', 'https://external/image.png')).rejects.toThrow('截图数据无效')
    mocks.image.mockReturnValueOnce({ ...cropped(), getSize: () => ({ width: 8000, height: 8000 }) })
    await expect(run('translate')).rejects.toThrow('截图数据无效')
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.vision).not.toHaveBeenCalled()
  })
  it('aborts pending OCR on close and restores shortcuts after a capture failure', async () => {
    await tool.open()
    mocks.native.mockImplementationOnce((_request, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true })))
    const pending = run('translate'); tool.close(); await expect(pending).rejects.toThrow('Cancelled')
    expect(mocks.complete).not.toHaveBeenCalled(); expect(active).toHaveBeenLastCalledWith(false)
    mocks.sources.mockRejectedValueOnce(Error('Capture unavailable'))
    await expect(tool.open()).rejects.toThrow(); expect(tool.isOpen).toBe(false); expect(active).toHaveBeenLastCalledWith(false)
  })
})
