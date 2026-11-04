import type { BrowserWindow } from 'electron'

/**
 * Which pill renderer has actually announced itself.
 *
 * Commands used to be sent the moment the window object existed, which is a few
 * hundred milliseconds before the page's React effect subscribes to
 * `note-audio:command` / `speech:playback`. That is exactly the first command
 * after the pill is (re)created: it was delivered to a renderer that was not
 * listening yet, and the caller timed out. The gate below keys the answer on
 * `webContents.id`, so only the window that really reported `bar:ready` can be
 * used, and a window recreated later starts from scratch.
 *
 * Only `webContents.id`, `once`/`removeListener` and `isDestroyed()` are touched,
 * so a test can drive this with a plain fake object.
 */
export interface ReadyWindow {
  readonly webContents: {
    readonly id: number
    once(event: string, listener: (...args: unknown[]) => void): unknown
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  }
  once(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  isDestroyed(): boolean
}

export interface BarReadinessWait {
  promise: Promise<void>
  cancel(): void
}

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
  detach: () => void
}

interface Entry {
  ready: boolean
  waiters: Set<Waiter>
}

const CLOSED = 'Playback window closed'

export function createBarReadiness(): {
  /** Called from the `bar:ready` handler with the window that event came from. */
  markReady(win: BrowserWindow): void
  /** Resolves when that exact window reports ready; rejects if it dies first. */
  wait(win: BrowserWindow): BarReadinessWait
  forget(win: BrowserWindow): void
} {
  const entries = new Map<number, Entry>()
  // The id has to be remembered: reading `win.webContents` after the window is
  // gone throws, and `forget`/`closed` handlers run exactly then.
  const ids = new WeakMap<object, number>()

  const idOf = (win: ReadyWindow): number | null => {
    const known = ids.get(win)
    if (known !== undefined) return known
    try {
      const id = win.webContents.id
      ids.set(win, id)
      return id
    } catch {
      return null
    }
  }

  const entryOf = (win: ReadyWindow, id: number): Entry => {
    let entry = entries.get(id)
    if (!entry) {
      entry = { ready: false, waiters: new Set() }
      entries.set(id, entry)
    }
    return entry
  }

  const settle = (entry: Entry, id: number, waiter: Waiter, error?: Error): void => {
    if (!entry.waiters.delete(waiter)) return
    waiter.detach()
    if (error) waiter.reject(error)
    else waiter.resolve()
    if (!entry.ready && entry.waiters.size === 0) entries.delete(id)
  }

  const failAll = (entry: Entry, id: number, error: Error): void => {
    for (const waiter of [...entry.waiters]) settle(entry, id, waiter, error)
  }

  return {
    markReady(win) {
      const gate = win as unknown as ReadyWindow
      if (win.isDestroyed()) return
      const id = idOf(gate)
      if (id === null) return
      const entry = entryOf(gate, id)
      entry.ready = true
      for (const waiter of [...entry.waiters]) settle(entry, id, waiter)
    },

    wait(win) {
      const gate = win as unknown as ReadyWindow
      const id = idOf(gate)
      if (id === null || win.isDestroyed()) return { promise: Promise.reject(new Error(CLOSED)), cancel: () => undefined }
      if (entries.get(id)?.ready) return { promise: Promise.resolve(), cancel: () => undefined }
      const entry = entryOf(gate, id)
      const waiter: Waiter = { resolve: () => undefined, reject: () => undefined, detach: () => undefined }
      const promise = new Promise<void>((resolve, reject) => {
        waiter.resolve = resolve
        waiter.reject = reject
      })
      // A window that goes away can never report ready. `render-process-gone`
      // covers a crash, `did-fail-load` a navigation that never produced a page
      // (only the main frame matters), `closed` the pill being retired.
      const onClosed = (): void => settle(entry, id, waiter, new Error(CLOSED))
      const onGone = (): void => settle(entry, id, waiter, new Error(CLOSED))
      const onFail = (...args: unknown[]): void => {
        const mainFrame = args[4]
        if (mainFrame === false) return
        settle(entry, id, waiter, new Error(CLOSED))
      }
      waiter.detach = () => {
        gate.removeListener('closed', onClosed)
        gate.webContents.removeListener('render-process-gone', onGone)
        gate.webContents.removeListener('did-fail-load', onFail)
      }
      entry.waiters.add(waiter)
      gate.once('closed', onClosed)
      gate.webContents.once('render-process-gone', onGone)
      gate.webContents.once('did-fail-load', onFail)
      return {
        promise,
        // Cancelling rejects instead of leaving the promise pending: the caller's
        // command budget would otherwise stay open with listeners attached to a
        // window nobody is waiting for any more.
        cancel: () => settle(entry, id, waiter, new Error(CLOSED))
      }
    },

    forget(win) {
      const id = idOf(win as unknown as ReadyWindow)
      if (id === null) return
      const entry = entries.get(id)
      if (!entry) return
      entries.delete(id)
      // Waiters belong to a window that is going away; fail them now rather than
      // leaving them watching a dead object.
      failAll(entry, id, new Error(CLOSED))
    }
  }
}
