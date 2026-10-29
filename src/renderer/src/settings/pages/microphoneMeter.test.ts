import { afterEach, expect, it, vi } from 'vitest'
import { microphoneLevel, openMicrophoneMeter } from './microphoneMeter'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('reports actual RMS level and bounds the display', () => {
  expect(microphoneLevel(new Float32Array())).toBe(0)
  expect(microphoneLevel(new Float32Array(512))).toBe(0)
  expect(microphoneLevel(new Float32Array([0.1, -0.1]))).toBeCloseTo(40)
  expect(microphoneLevel(new Float32Array([1, -1]))).toBe(100)
})
it('releases the device if building the audio graph fails and requests the selected device exactly', async () => {
  const stop = vi.fn(), getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('AudioContext', class { constructor() { throw Error('device failure') } })
  await expect(openMicrophoneMeter('selected-device', 'fidelity', () => {})).rejects.toThrow('device failure')
  expect(stop).toHaveBeenCalledOnce()
  expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false, audio: expect.objectContaining({ deviceId: { exact: 'selected-device' } }) }))
})
it('stops both the meter timer and microphone tracks when testing ends', async () => {
  vi.useFakeTimers()
  const stop = vi.fn(), close = vi.fn(async () => {}), changed = vi.fn()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } })
  vi.stubGlobal('AudioContext', class {
    state = 'running'
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: (data: Float32Array) => data.fill(0.1) } }
    createMediaStreamSource() { return { connect: () => {} } }
    resume() { return Promise.resolve() }
    close = close
  })
  const meter = await openMicrophoneMeter('', 'fidelity', changed)
  await vi.advanceTimersByTimeAsync(80)
  expect(changed).toHaveBeenCalledWith(expect.closeTo(40))
  meter.stop(); await vi.advanceTimersByTimeAsync(500)
  expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledTimes(1)
})
