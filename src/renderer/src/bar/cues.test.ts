import { afterEach, expect, it, vi } from 'vitest'
import { disposeCues, playCue } from './cues'

afterEach(() => { disposeCues(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('waits for the start cue to finish before recording can mute it', async () => {
  vi.useFakeTimers()
  const disconnect = vi.fn(), ended: Array<() => void> = []
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0; destination = {}
    close = async (): Promise<void> => undefined
    createGain = () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect })
    createOscillator = () => {
      const node = { type: '', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        onended: () => undefined, start: vi.fn(), stop: vi.fn(), connect: (value: unknown) => value, disconnect }
      ended.push(() => node.onended())
      return node
    }
  })
  const done = vi.fn()
  const playing = playCue('start', true).then(done)
  await Promise.resolve(); expect(done).not.toHaveBeenCalled()
  ended[0](); await playing
  expect(done).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledTimes(2)
})

it('does not block recording forever when the playback device cannot resume', async () => {
  vi.useFakeTimers()
  const oscillator = vi.fn()
  vi.stubGlobal('AudioContext', class {
    state = 'suspended'; resume = () => new Promise<void>(() => undefined)
    close = async (): Promise<void> => undefined
    createOscillator = oscillator
  })
  const playing = playCue('start', true)
  await vi.advanceTimersByTimeAsync(1000); await playing
  expect(oscillator).not.toHaveBeenCalled()
})
