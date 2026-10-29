import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureConstraints, MicCapture } from './capture'

let nodes: Array<{ port: { onmessage: ((event: unknown) => void) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }>
let recorders: FakeRecorder[]
let stream: MediaStream
class FakeRecorder {
  static isTypeSupported = (): boolean => true
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) { recorders.push(this) }
  start(): void { this.state = 'recording'; this.ondataavailable?.({ data: new Blob([new Uint8Array(1024)]) }) }
  stop(): void { this.state = 'inactive'; setTimeout(() => this.onstop?.(), 250) }
}

beforeEach(() => {
  vi.useFakeTimers()
  nodes = []; recorders = []
  const track = { readyState: 'live', stop: vi.fn(), onended: null, getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) }
  stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', class {
    sampleRate = 16000
    audioWorklet = { addModule: vi.fn(async () => undefined) }
    destination = {}
    createMediaStreamSource = () => ({ connect: vi.fn() })
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
    resume = async (): Promise<void> => undefined
    close = async (): Promise<void> => undefined
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null as ((event: unknown) => void) | null, postMessage: vi.fn((message: { flush?: boolean }) => {
      if (message.flush) queueMicrotask(() => this.port.onmessage?.({ data: { chunk: new Int16Array([111, 222]), final: true } }))
    }), close: vi.fn() }
    connect = vi.fn()
    disconnect = vi.fn()
    constructor() { nodes.push(this) }
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function capture(): { mic: MicCapture; onChunk: ReturnType<typeof vi.fn>; onEncoded: ReturnType<typeof vi.fn> } {
  const onChunk = vi.fn(), onEncoded = vi.fn()
  return { mic: new MicCapture({ onChunk, onEncoded, onLevel: vi.fn(), onError: vi.fn() }), onChunk, onEncoded }
}

describe('recording integrity', () => {
  it('warms audio without enumerating cameras and unrelated media devices', async () => {
    const { mic } = capture()
    await mic.start()
    expect(mic.isRunning).toBe(true)
    expect(navigator.mediaDevices.enumerateDevices).not.toHaveBeenCalled()
    await mic.stop()
  })
  it('does not reopen the recording gate after cancellation during activation', async () => {
    const { mic } = capture()
    await mic.start()
    const activating = mic.setActive(true)
    await mic.setActive(false, false)
    await activating
    expect(mic.isActive).toBe(false)
    expect(recorders).toHaveLength(0)
    expect(nodes[0].port.postMessage).not.toHaveBeenCalledWith({ active: true })
    await mic.stop()
  })
  it('requests native-quality input and keeps voice processing optional', () => {
    expect(captureConstraints('fidelity')).toMatchObject({ sampleRate: { ideal: 48000 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false })
    expect(captureConstraints('voice')).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
  })
  it('drains the final PCM immediately instead of waiting for a slow encoder', async () => {
    const { mic, onChunk } = capture()
    await mic.start(); await mic.setActive(true)
    const closing = mic.setActive(false)
    expect(nodes[0].port.postMessage).toHaveBeenCalledWith({ flush: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(onChunk).toHaveBeenCalledWith(new Int16Array([111, 222]))
    await vi.advanceTimersByTimeAsync(250); await closing; await mic.stop()
  })
  it('starts the compressed copy when the take starts before microphone warmup finishes', async () => {
    const { mic } = capture()
    await mic.setActive(true); await mic.start()
    expect(recorders).toHaveLength(1)
    expect(recorders[0].options.audioBitsPerSecond).toBe(64_000)
    const closing = mic.setActive(false)
    await vi.advanceTimersByTimeAsync(250); await closing; await mic.stop()
  })
  it('keeps queued speech blocks until the final tail arrives', async () => {
    const { mic, onChunk } = capture()
    await mic.start(); await mic.setActive(true)
    const closing = mic.setActive(false)
    nodes[0].port.onmessage?.({ data: { chunk: new Int16Array([333, 444]) } })
    expect(onChunk).toHaveBeenCalledWith(new Int16Array([333, 444]))
    await vi.advanceTimersByTimeAsync(250); await closing; await mic.stop()
  })
  it('drops a cancelled tail and encoded copy even when normal stop is already draining', async () => {
    const { mic, onChunk, onEncoded } = capture()
    await mic.start(); await mic.setActive(true)
    const closing = mic.setActive(false)
    const cancelled = mic.setActive(false, false)
    await vi.advanceTimersByTimeAsync(250); await closing; await cancelled
    expect(onChunk).not.toHaveBeenCalled()
    expect(onEncoded).not.toHaveBeenCalled()
    await mic.stop()
  })
  it('waits for the previous encoder to close before opening a new take', async () => {
    const { mic } = capture()
    await mic.start(); await mic.setActive(true)
    const closing = mic.setActive(false)
    const next = mic.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mic.isActive).toBe(false)
    await vi.advanceTimersByTimeAsync(250); await closing; await next
    expect(mic.isActive).toBe(true)
    expect(recorders).toHaveLength(2)
    const ending = mic.setActive(false, false)
    await vi.advanceTimersByTimeAsync(250); await ending; await mic.stop()
  })
  it('defers a processing change until the current take is flushed', async () => {
    const { mic } = capture()
    await mic.start(); await mic.setActive(true)
    await mic.setDevice('', 'voice')
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    const closing = mic.setActive(false)
    await vi.advanceTimersByTimeAsync(250); await closing
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: captureConstraints('voice') })
    await mic.stop()
  })
  it('does not start an unused parallel encoder for PCM-only consumers', async () => {
    const mic = new MicCapture({ onChunk: vi.fn(), onLevel: vi.fn(), onError: vi.fn() })
    await mic.start(); await mic.setActive(true)
    expect(recorders).toHaveLength(0)
    const closing = mic.setActive(false)
    await vi.advanceTimersByTimeAsync(0); await closing; await mic.stop()
  })
})
