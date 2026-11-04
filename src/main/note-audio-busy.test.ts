import { describe, expect, it, vi } from 'vitest'
import { createNoteAudioBusy } from './note-audio-busy'

/**
 * The flag follows what the renderer reports, never an estimated end time: a
 * long or paused track used to be cut off by a timer, and a track whose length
 * is unknown pinned the pill forever.
 */
describe('note audio busy flag', () => {
  it('holds while playing or paused, with no timer to expire it', () => {
    vi.useFakeTimers()
    const busy = createNoteAudioBusy()
    busy.track({ state: 'playing' })
    vi.advanceTimersByTime(600_000)
    expect(busy.isBusy()).toBe(true)
    busy.track({ state: 'paused' })
    vi.advanceTimersByTime(600_000)
    expect(busy.isBusy()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('keeps holding for a track whose length is unknown', () => {
    const busy = createNoteAudioBusy()
    busy.track({ state: 'playing' })
    expect(busy.isBusy()).toBe(true)
  })

  it('releases on ended, error, idle and stop', () => {
    const busy = createNoteAudioBusy()
    for (const state of ['ended', 'error', 'idle', 'stop']) {
      busy.track({ state: 'playing' })
      expect(busy.isBusy()).toBe(true)
      busy.track({ state })
      expect(busy.isBusy()).toBe(false)
    }
  })

  it('releases on reset and dispose so a dead owner cannot pin the window', () => {
    const busy = createNoteAudioBusy()
    busy.track({ state: 'playing' })
    busy.reset()
    expect(busy.isBusy()).toBe(false)
    busy.track({ state: 'paused' })
    busy.dispose()
    expect(busy.isBusy()).toBe(false)
  })

  /** Ends release; the next playback holds again — no state is carried over. */
  it('holds again on the next playback after an ended state', () => {
    const busy = createNoteAudioBusy()
    busy.track({ state: 'playing' })
    busy.track({ state: 'ended' })
    expect(busy.isBusy()).toBe(false)
    busy.track({ state: 'playing' })
    expect(busy.isBusy()).toBe(true)
  })
})
