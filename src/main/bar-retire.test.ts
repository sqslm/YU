import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { BAR_RETIRE_MS, wireBarRetirement } from './bar-retire'

interface FakeWindow {
  destroyed: boolean
  visible: boolean
  handlers: Map<string, () => void>
  destroy: ReturnType<typeof vi.fn>
  on: (event: string, handler: () => void) => void
  isDestroyed: () => boolean
  isVisible: () => boolean
  emit: (event: string) => void
}

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    visible: false,
    handlers: new Map(),
    destroy: vi.fn(() => {
      win.destroyed = true
    }),
    on: (event, handler) => {
      win.handlers.set(event, handler)
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    emit: (event) => win.handlers.get(event)?.()
  }
  return win
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('retires a window that stays hidden for the whole delay', () => {
  const win = fakeWindow()
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => false, isCardVisible: () => false })
  win.emit('hide')
  vi.advanceTimersByTime(BAR_RETIRE_MS - 1)
  expect(win.destroy).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(win.destroy).toHaveBeenCalledOnce()
})

it('keeps the window when the pill comes back before the delay elapses', () => {
  const win = fakeWindow()
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => false, isCardVisible: () => false })
  win.emit('hide')
  vi.advanceTimersByTime(BAR_RETIRE_MS / 2)
  win.visible = true
  win.emit('show')
  vi.advanceTimersByTime(BAR_RETIRE_MS * 2)
  expect(win.destroy).not.toHaveBeenCalled()
})

it('never destroys a window that is still on screen', () => {
  const win = fakeWindow()
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => false, isCardVisible: () => false })
  win.emit('hide')
  win.visible = true
  vi.advanceTimersByTime(BAR_RETIRE_MS * 2)
  expect(win.destroy).not.toHaveBeenCalled()
})

it('holds the window while a take or an anchored card still needs it', () => {
  const win = fakeWindow()
  const state = { busy: false, card: false }
  wireBarRetirement(win as unknown as BrowserWindow, {
    isBusy: () => state.busy,
    isCardVisible: () => state.card
  })
  win.emit('hide')
  state.busy = true
  vi.advanceTimersByTime(BAR_RETIRE_MS * 2)
  expect(win.destroy).not.toHaveBeenCalled()

  state.busy = false
  state.card = true
  win.emit('hide')
  vi.advanceTimersByTime(BAR_RETIRE_MS * 2)
  expect(win.destroy).not.toHaveBeenCalled()

  state.card = false
  win.emit('hide')
  vi.advanceTimersByTime(BAR_RETIRE_MS)
  expect(win.destroy).toHaveBeenCalledOnce()
})

it('retires once the busy state clears, without waiting for another hide', () => {
  const win = fakeWindow()
  let busy = true
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => busy, isCardVisible: () => false })
  win.emit('hide')
  vi.advanceTimersByTime(BAR_RETIRE_MS)
  expect(win.destroy).not.toHaveBeenCalled()

  // The take ends while the window is hidden: no hide event follows, so the
  // retirement has to re-check on its own.
  busy = false
  vi.advanceTimersByTime(BAR_RETIRE_MS)
  expect(win.destroy).toHaveBeenCalledOnce()
})

it('stops everything once the window reports itself closed', () => {
  const win = fakeWindow()
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => false, isCardVisible: () => false })
  win.emit('hide')
  win.emit('closed')
  vi.advanceTimersByTime(BAR_RETIRE_MS * 2)
  expect(win.destroy).not.toHaveBeenCalled()
})

it('arms a window that was created without ever being shown', () => {
  const win = fakeWindow()
  wireBarRetirement(win as unknown as BrowserWindow, { isBusy: () => false, isCardVisible: () => false })
  vi.advanceTimersByTime(BAR_RETIRE_MS)
  expect(win.destroy).toHaveBeenCalledOnce()
})
