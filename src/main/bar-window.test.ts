import { beforeEach, expect, it, vi } from 'vitest'
const desktop = vi.hoisted(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }))
vi.mock('electron', () => ({ app: { getAppPath: () => '.' }, BrowserWindow: vi.fn(), nativeTheme: {}, screen: {
  getAllDisplays: () => [desktop], getDisplayNearestPoint: () => desktop, getCursorScreenPoint: () => ({ x: 0, y: 0 })
} }))
vi.mock('./ipc-trust', () => ({ trustWindow: vi.fn() }))
vi.mock('./app-icon', () => ({ setTaskbarIcon: vi.fn() }))
import { positionCardWindow, resizeCardToContent, revealBarWindow, setCardExplanationOpen } from './windows'
import type { BrowserWindow } from 'electron'
beforeEach(() => { desktop.workArea = { x: 0, y: 0, width: 1920, height: 1040 } })
function window(minimized = false) {
  let bounds = { x: 736, y: 881, width: 340, height: 60 }
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => minimized,
    restore: vi.fn(() => { minimized = false }), getBounds: () => bounds,
    setBounds: vi.fn(next => { bounds = next }), setAlwaysOnTop: vi.fn(), showInactive: vi.fn() }
}
it('restores a minimized bar even when Electron still reports it visible', () => {
  const win = window(true); revealBarWindow(win as unknown as BrowserWindow)
  expect(win.restore).toHaveBeenCalledOnce(); expect(win.showInactive).toHaveBeenCalledOnce()
  expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
})
it('brings an already visible bar back above application windows without focusing it', () => {
  const win = window(); revealBarWindow(win as unknown as BrowserWindow)
  expect(win.showInactive).toHaveBeenCalledOnce(); expect(win.restore).not.toHaveBeenCalled()
})
it('rescues an existing bar after the display resolution changes', () => {
  desktop.workArea = { x: 0, y: 0, width: 800, height: 600 }
  const win = window(); revealBarWindow(win as unknown as BrowserWindow)
  const bounds = win.getBounds()
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(800)
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
})
it('keeps the explanation attached during content resizing and restores the normal card width', () => {
  let bounds = { x: 0, y: 0, width: 560, height: 380 }
  const win = { isDestroyed: () => false, getSize: () => [bounds.width, bounds.height], setSize: (width: number, height: number) => { bounds = { ...bounds, width, height } }, setPosition: (x: number, y: number) => { bounds = { ...bounds, x, y } }, setMaximumSize: vi.fn() } as unknown as BrowserWindow
  positionCardWindow(win); const left = bounds.x
  setCardExplanationOpen(win, true)
  expect(bounds.width).toBe(872); expect(bounds.x).toBe(left)
  resizeCardToContent(win, 460); expect(bounds.width).toBe(872)
  desktop.workArea = { x: -800, y: 0, width: 800, height: 600 }
  positionCardWindow(win)
  expect(bounds.width).toBe(784); expect(bounds.x).toBeGreaterThanOrEqual(-792); expect(bounds.x + bounds.width).toBeLessThanOrEqual(-8)
  setCardExplanationOpen(win, false); expect(bounds.width).toBe(560)
})
