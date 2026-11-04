import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { createBarPlaybackHost } from './bar-playback-host'

function fakeWindow(id = 1) {
  const contents = Object.assign(new EventEmitter(), { id, send: vi.fn() })
  const state = { destroyed: false }
  return {
    contents,
    win: { webContents: contents, isDestroyed: () => state.destroyed } as unknown as BrowserWindow,
    destroy: () => { state.destroyed = true }
  }
}

/** The readiness gate, reduced to what the host uses: waits that someone else settles. */
function readinessStub() {
  const waits: Array<{ settle: (error?: Error) => void; detach: () => void; cancelled: number; attached: number }> = []
  const ready = new Set<BrowserWindow>()
  return {
    waits,
    wait: () => {
      let settle: (error?: Error) => void = () => undefined
      const record = { settle: (error?: Error) => settle(error), detach: () => undefined, cancelled: 0, attached: 1 }
      const promise = new Promise<void>((resolve, reject) => {
        settle = error => { record.attached = 0; if (error) reject(error); else resolve() }
      })
      waits.push(record)
      return { promise, cancel: () => { record.cancelled += 1; settle(Error('Playback window closed')) } }
    },
    isReady: (win: BrowserWindow) => ready.has(win),
    markReady: (win: BrowserWindow) => { ready.add(win) }
  }
}

it('peeks without creating a window', () => {
  const create = vi.fn()
  const host = createBarPlaybackHost({ window: () => null, create, readiness: readinessStub() })
  expect(host.peek()).toBeNull()
  expect(create).not.toHaveBeenCalled()
})

it('does not create a window while quitting or in game mode', async () => {
  const create = vi.fn(() => fakeWindow().win)
  const host = createBarPlaybackHost({ window: () => null, create, readiness: readinessStub(), blocked: () => true })
  await expect(host.ensure()).resolves.toBeNull()
  expect(create).not.toHaveBeenCalled()
})

it('cancels only the waiting command when its signal aborts', async () => {
  const { win } = fakeWindow()
  const readiness = readinessStub()
  const host = createBarPlaybackHost({ window: () => win, create: () => win, readiness })
  const first = new AbortController()
  const stale = host.ensure(first.signal)
  const live = host.ensure()
  expect(readiness.waits).toHaveLength(2)

  first.abort()
  await expect(stale).resolves.toBeNull()
  expect(readiness.waits[0].cancelled).toBe(1)
  expect(readiness.waits[0].attached).toBe(0)
  expect(readiness.waits[1].cancelled).toBe(0)

  readiness.waits[1].settle()
  await expect(live).resolves.toBe(win)
})

it('reuses the window that is already up', async () => {
  const { win } = fakeWindow()
  const readiness = readinessStub()
  const create = vi.fn(() => fakeWindow(2).win)
  const host = createBarPlaybackHost({ window: () => win, create, readiness })
  const pending = host.ensure()
  readiness.waits[0].settle()
  await expect(pending).resolves.toBe(win)
  expect(create).not.toHaveBeenCalled()
})

it('reports a window that dies while it was starting as unreachable', async () => {
  const { win, destroy } = fakeWindow()
  const readiness = readinessStub()
  const host = createBarPlaybackHost({ window: () => null, create: () => win, readiness })
  const pending = host.ensure()
  readiness.waits[0].settle()
  destroy()
  await expect(pending).resolves.toBeNull()
})

/**
 * 回归：renderer 崩溃后窗口对象还在，但那个页面永远不会再 `bar:ready`。旧接线会
 * 一直复用它，于是下一次播放把 8 s 预算全花在一个听不到的窗口上。
 */
it('replaces a window that can never report ready instead of waiting on it again', async () => {
  const dead = fakeWindow(1)
  const fresh = fakeWindow(2)
  dead.destroy()
  const readiness = readinessStub()
  const create = vi.fn(() => fresh.win)
  const host = createBarPlaybackHost({ window: () => dead.win, create, readiness })
  expect(host.peek()).toBeNull()
  const pending = host.ensure()
  expect(create).toHaveBeenCalledOnce()
  readiness.waits[0].settle()
  await expect(pending).resolves.toBe(fresh.win)
})
