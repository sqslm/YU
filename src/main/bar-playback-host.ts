import type { BrowserWindow } from 'electron'
import type { BarReadinessWait } from './bar-ready'

/**
 * The one way to reach the pill renderer.
 *
 * Two callers need it — note playback and speech playback — and a probe needs the
 * same wiring to exercise the real thing. It used to be written out inline in
 * `index.ts` and copied into the probe, which is how the copy lost the cancel
 * handle of the readiness wait and left listeners on a window nobody wanted.
 *
 * `peek` never creates anything; `ensure` may, and only resolves once that window
 * announced `bar:ready`. Cancelling a command cancels *its* wait only: several
 * commands can be waiting for the same window.
 */
export interface BarPlaybackHostDeps {
  /** The pill as it is now, or null. Must never create or show a window. */
  window: () => BrowserWindow | null
  /** Creates (or shows) the pill; only reached from `ensure`. */
  create: () => BrowserWindow
  readiness: {
    wait: (win: BrowserWindow) => BarReadinessWait
    isReady: (win: BrowserWindow) => boolean
  }
  /** Quitting and game mode: a hidden renderer must not be recreated behind them. */
  blocked?: () => boolean
  log?: (line: string) => void
}

export interface BarPlaybackHost {
  peek: () => BrowserWindow | null
  /** True once that exact window's renderer can hear commands. */
  ready: (win: BrowserWindow) => boolean
  ensure: (signal?: AbortSignal) => Promise<BrowserWindow | null>
}

export function createBarPlaybackHost(deps: BarPlaybackHostDeps): BarPlaybackHost {
  const peek = (): BrowserWindow | null => {
    const win = deps.window()
    return win && !win.isDestroyed() ? win : null
  }

  return {
    peek,

    ready: win => deps.readiness.isReady(win),

    async ensure(signal?: AbortSignal): Promise<BrowserWindow | null> {
      if (deps.blocked?.()) return null
      if (signal?.aborted) return null
      const win = peek() ?? deps.create()
      if (!win || win.isDestroyed()) return null
      const wait = deps.readiness.wait(win)
      // The command owns this wait: aborting it drops that one listener, and the
      // other commands waiting on the same window keep theirs.
      const cancel = (): void => wait.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        await wait.promise
        return win.isDestroyed() ? null : win
      } catch (error) {
        // A deliberate cancel is not a failure worth a log line.
        if (!signal?.aborted) deps.log?.(`[bar] playback window did not become ready: ${String(error)}`)
        return null
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }
  }
}
