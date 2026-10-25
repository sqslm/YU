import { EventEmitter } from 'node:events'
import { globalShortcut } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'
import type { ScreenshotAction } from '@shared/screenshot'

const mocks = vi.hoisted(() => ({ cursor: { x: -100, y: 50 }, capture: vi.fn(), sources: vi.fn(), image: vi.fn(), copyImage: vi.fn(), copyText: vi.fn(), save: vi.fn(), write: vi.fn(), native: vi.fn(), complete: vi.fn(), vision: vi.fn(), handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[] }))
vi.mock('electron', () => ({
  app: { getPath: () => '/pictures', getAppPath: () => '/app', getLocale: () => 'en-US' }, clipboard: { writeImage: mocks.copyImage, writeText: mocks.copyText },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  desktopCapturer: { getSources: mocks.sources }, nativeImage: { createFromDataURL: mocks.image }, dialog: { showSaveDialog: mocks.save },
  screen: { dipToScreenRect: (_win: unknown, rect: {x:number;y:number;width:number;height:number}) => Object.fromEntries(Object.entries(rect).map(([key,value]) => [key,Math.round(value*1.5)])), getCursorScreenPoint: () => mocks.cursor, getDisplayNearestPoint: () => ({ id: 42, scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 720 } }) },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
  BrowserWindow: class extends EventEmitter {
    // `id` and `isDestroyed` are what the IPC trust layer reads when the window
    // registers itself, so the fixture has to look like a real webContents.
    id = mocks.windows.length + 100
    webContents = Object.assign(new EventEmitter(), { id: this.id, mainFrame: {}, setWindowOpenHandler: vi.fn(), send: vi.fn(), isDestroyed: () => false }); destroyed = false
    constructor(public options: unknown) { super(); mocks.windows.push(this) }
    setAlwaysOnTop = vi.fn(); loadFile = vi.fn(); loadURL = vi.fn(); show = vi.fn(); focus = vi.fn()
    setIgnoreMouseEvents = vi.fn(); setContentProtection = vi.fn(); setFocusable = vi.fn()
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true; this.emit('closed') }
  }
}))
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }))
vi.mock('./windows-native', () => ({ windowsNative: mocks.native }))
vi.mock('./capture-screen', () => ({ captureScreen: mocks.capture }))
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
  mocks.cursor = { x: -100, y: 50 }
  mocks.capture.mockReset().mockImplementation(() => { throw Error('GDI unavailable in this test') })
  mocks.sources.mockReset().mockResolvedValue([{ display_id: 'wrong', thumbnail: cropped() }, { display_id: '42', thumbnail: { ...cropped(), getSize: () => ({ width: 1920, height: 1080 }), toBitmap: () => Buffer.from([1, 2, 3, 255]) } }])
  mocks.image.mockReset().mockImplementation(cropped)
  mocks.native.mockReset().mockResolvedValue({ text: '真实 OCR 文字', width: 900, height: 300,
    lines: [{ text: '真实 OCR 文字', x: 15, y: 30, width: 300, height: 30 }] })
  mocks.complete.mockReset().mockResolvedValue('[{"id":0,"text":"Real translation"}]'); mocks.vision.mockReset().mockResolvedValue('Actual visual answer')
  mocks.save.mockReset().mockResolvedValue({ canceled: false, filePath: '/chosen/capture.png' })
  settings = mergeSettings({ profiles: [{ id: 'text', name: 'Text', preset: '', kind: 'llm', enabled: true, baseUrl: 'http://text.test', model: 'text-model', apiKey: 'private' },
    { id: 'vision', name: 'Vision', preset: '', kind: 'multimodal', enabled: true, baseUrl: 'http://vision.test', model: 'vision-model', apiKey: 'private' }] })
  tool = new ScreenshotTool(() => settings, active); tool.register()
})
afterEach(() => { tool.close(); vi.useRealTimers() })

describe('explicit screenshot tool', () => {
  it('captures a DPI-correct scrolling region, releases focus, exports pixels and stops its timer', async () => {
    await tool.open(); vi.useFakeTimers()
    const pixels = Buffer.alloc(90 * 90 * 4, 255); pixels[0] = 10; pixels[2] = 30
    mocks.capture.mockReturnValue({ toBitmap: () => pixels })
    mocks.handlers.get('screenshot:scroll-start')!(event(), { x: 100, y: 100, width: 60, height: 60 }, { x: 100, y: 170, width: 410, height: 100 })
    const win = mocks.windows[0]
    expect(win.setContentProtection).toHaveBeenLastCalledWith(true)
    expect(win.setFocusable).toHaveBeenLastCalledWith(false)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(globalShortcut.register).toHaveBeenCalledWith('Escape', expect.any(Function))
    mocks.cursor = { x: -1100, y: 200 }; await vi.advanceTimersByTimeAsync(50)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    mocks.cursor = { x: -100, y: 50 }; await vi.advanceTimersByTimeAsync(200)
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(mocks.capture).toHaveBeenLastCalledWith({ x: -1770, y: 150, width: 90, height: 90 })
    expect(win.webContents.send).toHaveBeenCalledWith('screenshot:scroll-progress', { width: 90, height: 90, frames: 1 })
    const frame = mocks.handlers.get('screenshot:scroll-finish')!(event())
    expect(frame).toMatchObject({ width: 90, height: 90 }); expect(frame.pixels.subarray(0,4)).toEqual(Buffer.from([30,255,10,255]))
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(win.setFocusable).toHaveBeenLastCalledWith(true)
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Escape')
    const calls = mocks.capture.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000); expect(mocks.capture).toHaveBeenCalledTimes(calls)
  })
  it('rejects invalid scrolling bounds and never leaves capture running after close', async () => {
    await tool.open(); vi.useFakeTimers()
    expect(() => mocks.handlers.get('screenshot:scroll-start')!(event(), { x: -1, y: 0, width: 100, height: 100 }, { x: 0, y: 120, width: 410, height: 100 })).toThrow('滚动截图区域')
    mocks.capture.mockReturnValue({ toBitmap: () => Buffer.alloc(90 * 90 * 4, 255) })
    mocks.handlers.get('screenshot:scroll-start')!(event(), { x: 0, y: 0, width: 60, height: 60 }, { x: 0, y: 70, width: 410, height: 100 })
    await expect(run('copy')).rejects.toThrow('请先完成滚动截图')
    tool.close(); const calls = mocks.capture.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000); expect(mocks.capture).toHaveBeenCalledTimes(calls)
    expect(active).toHaveBeenLastCalledWith(false)
  })
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
    // A subframe of a trusted window never reaches the handler: the IPC trust
    // layer refuses anything whose senderFrame is not the window's mainFrame.
    expect(() => mocks.handlers.get('screenshot:copy-text')!({ ...event(), senderFrame: {} }, 'secret')).toThrow('Blocked IPC from an untrusted renderer')
    expect(() => mocks.handlers.get('screenshot:copy-text')!({ sender: { id: 999 }, senderFrame: null }, 'secret')).toThrow('Blocked IPC from an untrusted renderer')
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
    expect(await run('translate')).toEqual({ text: 'Real translation', translation: { width: 600, height: 200,
      regions: [{ text: 'Real translation', x: 10, y: 20, width: 200, height: 20 }] } })
    expect(mocks.complete.mock.calls[0][0]).toMatchObject({ model: 'text-model' })
    expect(JSON.parse(mocks.complete.mock.calls[0][1].messages[1].content)).toEqual([{ id: 0, text: '真实 OCR 文字' }])
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('into en')
  })
  it('rejects incomplete translations rather than placing words over the wrong source region', async () => {
    await tool.open(); mocks.complete.mockResolvedValueOnce('[]')
    await expect(run('translate')).rejects.toThrow('翻译结果不完整，请重试')
  })
  it('cancels an in-flight screen capture without opening a late editor', async () => {
    let resolve!: (value: unknown) => void
    mocks.sources.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const opening = tool.open()
    tool.close()
    resolve([{ display_id: '42', thumbnail: { ...cropped(), toBitmap: () => Buffer.from([1, 2, 3, 255]) } }])
    await expect(opening).rejects.toThrow()
    expect(mocks.windows).toHaveLength(0); expect(tool.isOpen).toBe(false)
    expect(active).toHaveBeenLastCalledWith(false)
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
