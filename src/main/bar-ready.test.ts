import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it } from 'vitest'
import { createBarReadiness } from './bar-ready'

let nextId = 1
/** The three things the gate is allowed to touch: an id, listeners and liveness. */
function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), { id: nextId++ })
  const alive = { destroyed: false }
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => alive.destroyed })
  return {
    contents,
    win: win as unknown as BrowserWindow,
    destroy: () => { alive.destroyed = true },
    listeners: () => contents.listenerCount('render-process-gone') + win.listenerCount('closed') + contents.listenerCount('did-fail-load')
  }
}

it('resolves right away for a window that already reported ready', async () => {
  const gate = createBarReadiness()
  const { win } = fakeWindow()
  gate.markReady(win)
  await expect(gate.wait(win).promise).resolves.toBeUndefined()
})

it('resolves a wait placed before the renderer reports ready', async () => {
  const gate = createBarReadiness()
  const { win } = fakeWindow()
  const wait = gate.wait(win)
  gate.markReady(win)
  await expect(wait.promise).resolves.toBeUndefined()
})

it('rejects when the window closes or its renderer dies first', async () => {
  const gate = createBarReadiness()
  const closed = fakeWindow(), crashed = fakeWindow(), failed = fakeWindow()
  const a = gate.wait(closed.win), b = gate.wait(crashed.win), c = gate.wait(failed.win)
  closed.win.emit('closed')
  crashed.contents.emit('render-process-gone')
  failed.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///bar.html', true)
  await expect(a.promise).rejects.toThrow('Playback window closed')
  await expect(b.promise).rejects.toThrow('Playback window closed')
  await expect(c.promise).rejects.toThrow('Playback window closed')
})

it('drops every listener when the wait is cancelled or settles', async () => {
  const gate = createBarReadiness()
  const cancelled = fakeWindow(), reported = fakeWindow()
  expect(cancelled.listeners()).toBe(0)
  const wait = gate.wait(cancelled.win)
  expect(cancelled.listeners()).toBe(3)
  wait.cancel()
  await expect(wait.promise).rejects.toThrow('Playback window closed')
  expect(cancelled.listeners()).toBe(0)

  const later = gate.wait(reported.win)
  gate.markReady(reported.win)
  await expect(later.promise).resolves.toBeUndefined()
  expect(reported.listeners()).toBe(0)
})

it('never lets one window report ready for another', async () => {
  const gate = createBarReadiness()
  const old = fakeWindow(), fresh = fakeWindow()
  const wait = gate.wait(fresh.win)
  gate.markReady(old.win)
  let done = false
  void wait.promise.then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)
  gate.markReady(fresh.win)
  await expect(wait.promise).resolves.toBeUndefined()
})

/** A window whose `webContents` getter dies with it, the way Electron's does. */
function mortalWindow() {
  const contents = Object.assign(new EventEmitter(), { id: nextId++ })
  const state = { destroyed: false }
  const win = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean }
  Object.defineProperty(win, 'webContents', {
    get: () => {
      if (state.destroyed) throw Error('Object has been destroyed')
      return contents
    }
  })
  win.isDestroyed = () => state.destroyed
  return { contents, win: win as unknown as BrowserWindow, destroy: () => { state.destroyed = true } }
}

/**
 * 回归：生产顺序是先 closed（index.ts 自己注册的 handler 里 forget）再轮到 waiter
 * 的 closed 监听。旧实现的 detach 在窗口已销毁后又读了一次 `webContents`，清理就
 * 在抛错处停下，waiter 永远不结算、监听器留在死窗口上。
 */
it('cleans up after a destroyed window without touching its webContents getter', async () => {
  const gate = createBarReadiness()
  const { contents, win, destroy } = mortalWindow()
  win.once('closed', () => gate.forget(win))
  const a = gate.wait(win), b = gate.wait(win)
  destroy()
  expect(() => win.emit('closed')).not.toThrow()
  await expect(a.promise).rejects.toThrow('Playback window closed')
  await expect(b.promise).rejects.toThrow('Playback window closed')
  expect(contents.listenerCount('render-process-gone')).toBe(0)
  expect(contents.listenerCount('did-fail-load')).toBe(0)
  expect(win.listenerCount('closed')).toBe(0)
})

/** 回归：子框架加载失败不能把唯一的 did-fail-load 监听消耗掉。 */
it('does not let a sub-frame load failure consume the main-frame one', async () => {
  const gate = createBarReadiness()
  const { contents, win } = fakeWindow()
  const wait = gate.wait(win)
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'about:blank', false)
  let settled = false
  void wait.promise.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(contents.listenerCount('did-fail-load')).toBe(1)
  contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///bar.html', true)
  await expect(wait.promise).rejects.toThrow('Playback window closed')
})

it('settles every waiter once and leaves no listener when forgotten twice', async () => {
  const gate = createBarReadiness()
  const { contents, win, destroy } = fakeWindow()
  const a = gate.wait(win), b = gate.wait(win), c = gate.wait(win)
  c.cancel()
  gate.forget(win)
  gate.forget(win)
  destroy()
  await expect(a.promise).rejects.toThrow('Playback window closed')
  await expect(b.promise).rejects.toThrow('Playback window closed')
  await expect(c.promise).rejects.toThrow('Playback window closed')
  expect(win.listenerCount('closed')).toBe(0)
  expect(contents.listenerCount('render-process-gone')).toBe(0)
  expect(contents.listenerCount('did-fail-load')).toBe(0)
})

it('forgets a window so a retired renderer cannot open the next gate', async () => {
  const gate = createBarReadiness()
  const { win } = fakeWindow()
  gate.markReady(win)
  gate.forget(win)
  let done = false
  const wait = gate.wait(win)
  void wait.promise.then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)
  gate.markReady(win)
  await expect(wait.promise).resolves.toBeUndefined()
})

/** Commands are only sent to a window this reports ready, and never to a retired one. */
it('reports readiness per window and forgets it with the window', () => {
  const gate = createBarReadiness()
  const { win } = fakeWindow(), other = fakeWindow()
  expect(gate.isReady(win)).toBe(false)
  gate.markReady(win)
  expect(gate.isReady(win)).toBe(true)
  expect(gate.isReady(other.win)).toBe(false)
  gate.forget(win)
  expect(gate.isReady(win)).toBe(false)
})
