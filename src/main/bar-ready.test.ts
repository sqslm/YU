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
