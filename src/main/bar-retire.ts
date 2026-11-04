import type { BrowserWindow } from 'electron'

/**
 * The pill is a renderer process that exists for the seconds a take is visible.
 * Between takes it used to stay alive for the whole session — a hidden window at
 * `backgroundThrottling: false` costs a renderer (~26 MiB private) plus its
 * share of the GPU and utility processes, and the user sees none of it.
 *
 * This retires that window once it has been hidden long enough that the next
 * take is not plausibly a continuation of this one. Everything that can reveal
 * the pill already goes through `ensureBarWindow()`, which recreates it on
 * demand; the renderer announces itself through `bar:ready`, so a recreated
 * window still receives the state that was sent while it was loading.
 *
 * The retirement is skipped, never postponed, while anything still needs the
 * pill: an active take, an open answer card (the card is anchored to it), or a
 * recording note. A skipped window simply stays; the next hide arms the timer
 * again.
 */
export interface BarRetireOptions {
  /** How long the pill must stay hidden before its window is destroyed. */
  delayMs?: number
  /** Anything that must keep the pill alive even while it is hidden. */
  isBusy: () => boolean
  /** Whether an answer card is on screen and anchored to the pill. */
  isCardVisible: () => boolean
  log?: (line: string) => void
}

export const BAR_RETIRE_MS = 30_000

/** Wires hidden-window retirement. Returns a disposer that cancels everything. */
export function wireBarRetirement(win: BrowserWindow, options: BarRetireOptions): () => void {
  const delay = options.delayMs ?? BAR_RETIRE_MS
  let timer: NodeJS.Timeout | null = null

  const cancel = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const arm = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      if (win.isDestroyed() || win.isVisible()) return
      if (options.isBusy() || options.isCardVisible()) return
      options.log?.('[bar] retiring the hidden pill window')
      win.destroy()
    }, delay)
    timer.unref?.()
  }

  win.on('hide', arm)
  win.on('show', cancel)
  win.on('closed', cancel)
  // A window can also be created for a reason that never shows it (the bar
  // renderer answers the microphone-list request). That one starts hidden and
  // would otherwise never be armed, so arm it here as well.
  if (!win.isVisible()) arm()
  return cancel
}
