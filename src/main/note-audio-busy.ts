export interface NoteAudioBusyState {
  state: string
}

/**
 * Tracks whether the pill renderer holds a recording, so the window is not
 * retired underneath it.
 *
 * The flag follows the real playback state reported by the page and nothing
 * else: `playing` and `paused` hold the window, `ended`/`error`/`idle`/`stop`
 * release it. There is deliberately no timer here — guessing the remaining
 * duration from `positionMs`/`rate` cut long tracks short (buffering, a rate the
 * page applied itself) and pinned unknown-length tracks forever, while the page
 * already reports the true end. When the owner disappears the window is gone
 * anyway, which `reset()` covers.
 */
export function createNoteAudioBusy(): {
  track: (state: NoteAudioBusyState) => void
  isBusy: () => boolean
  /** The owner is gone: window closed, renderer crashed, app quitting. */
  reset: () => void
  dispose: () => void
} {
  let busy = false
  const reset = (): void => { busy = false }
  return {
    track(state) {
      busy = state.state === 'playing' || state.state === 'paused'
    },
    isBusy: () => busy,
    reset,
    dispose: reset
  }
}
