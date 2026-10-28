import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utilityProcess } from 'electron'
import { LocalAsrHost } from './host'
import type { LocalAsrSettings } from '@shared/types'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/profile' },
  utilityProcess: { fork: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => {}), mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}),
  readdir: vi.fn(async () => ['model.int8.onnx', 'tokens.txt'].map(name => ({ name, isFile: () => true }))),
  stat: vi.fn(async () => ({ isFile: () => true, size: 123 }))
}))

class Worker extends EventEmitter {
  holdLoad = false
  holdDecode = false
  postMessage = vi.fn((message: { type: string; id?: number }) => {
    if (message.type === 'load' && !this.holdLoad) Promise.resolve().then(() => this.emit('message', { type: 'loaded' }))
    if (message.type === 'wav' && !this.holdDecode) Promise.resolve().then(() => this.emit('message', { type: 'text', id: message.id, text: ' hello ' }))
  })
  kill = vi.fn(() => this.emit('exit', 0))
}

describe('local model memory lifecycle', () => {
  let settings: LocalAsrSettings
  let workers: Worker[]
  let host: LocalAsrHost
  let recording: boolean

  beforeEach(() => {
    vi.useFakeTimers()
    recording = false
    settings = { enabled: true, modelId: 'sense-voice-small', modelDir: '/model', language: 'auto', mirror: 'cn', idleUnloadMinutes: 1 }
    workers = []
    vi.mocked(utilityProcess.fork).mockImplementation(() => {
      const worker = new Worker()
      workers.push(worker)
      return worker as never
    })
    host = new LocalAsrHost(() => settings, { log: vi.fn(), onProgress: vi.fn(), isBusy: () => recording })
    vi.spyOn(host, 'runtimeAvailable').mockReturnValue(true)
  })
  afterEach(() => { host.release(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('unloads for game mode without forgetting the enabled local model', async () => {
    await host.activate()
    host.suspend()
    await vi.advanceTimersByTimeAsync(60)
    expect(workers[0].kill).toHaveBeenCalledOnce()
    expect(host.memoryState()).toEqual({ loaded: false, autoResume: true })
    expect(await host.transcribeWav(new Uint8Array([1]))).toBe('hello')
    expect(workers).toHaveLength(2)
  })

  it('reclaims idle weights and loads them again for the next dictation', async () => {
    expect((await host.activate()).phase).toBe('ready')
    await vi.advanceTimersByTimeAsync(60_050)
    expect(workers[0].kill).toHaveBeenCalledOnce()
    expect(host.memoryState()).toEqual({ loaded: false, autoResume: true })
    expect(host.available()).toBe(true)
    expect((await host.status()).autoResume).toBe(true)
    expect(await host.transcribeWav(new Uint8Array([1]))).toBe('hello')
    expect(workers).toHaveLength(2)
    expect(host.memoryState()).toEqual({ loaded: true, autoResume: false })
  })

  it('does not unload during recording or decoding, then rearms after decoding', async () => {
    await host.activate()
    recording = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.ready()).toBe(true)
    expect(host.reclaim()).toBe(false)
    recording = false
    workers[0].holdDecode = true
    const decoded = host.transcribeWav(new Uint8Array([1]))
    expect(host.inUse).toBe(true)
    expect(host.reclaim()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.ready()).toBe(true)
    const request = workers[0].postMessage.mock.calls.find(([message]) => message.type === 'wav')![0]
    workers[0].emit('message', { type: 'text', id: request.id, text: 'ok' })
    expect(await decoded).toBe('ok')
    await vi.advanceTimersByTimeAsync(60_050)
    expect(host.ready()).toBe(false)
  })

  it('honors keep-loaded and reconfigures an already loaded model', async () => {
    settings.idleUnloadMinutes = 0
    await host.activate()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(host.ready()).toBe(true)
    settings.idleUnloadMinutes = 1
    host.reconfigure()
    await vi.advanceTimersByTimeAsync(60_050)
    expect(host.memoryState().autoResume).toBe(true)
  })

  it('manual release cancels auto-resume and stale worker messages cannot affect a replacement', async () => {
    await host.activate()
    expect(host.reclaim()).toBe(true)
    host.release()
    expect(host.available()).toBe(false)
    await expect(host.transcribeWav(new Uint8Array())).rejects.toThrow('本地模型未加载')
    await host.activate()
    workers[0].emit('message', { type: 'failed', message: 'old process' })
    await vi.advanceTimersByTimeAsync(50)
    expect(host.ready()).toBe(true)
    expect(await host.transcribeWav(new Uint8Array())).toBe('hello')
  })

  it('coalesces simultaneous activation and refuses reclaim while loading', async () => {
    vi.mocked(utilityProcess.fork).mockImplementationOnce(() => {
      const worker = new Worker()
      worker.holdLoad = true
      workers.push(worker)
      return worker as never
    })
    const loading = host.activate()
    expect(host.activate()).toBe(loading)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    expect(host.inUse).toBe(true)
    expect(host.reclaim()).toBe(false)
    workers[0].emit('message', { type: 'loaded' })
    expect((await loading).phase).toBe('ready')
  })

  it('settles a canceled load immediately so the next load can succeed', async () => {
    vi.mocked(utilityProcess.fork).mockImplementationOnce(() => {
      const worker = new Worker()
      worker.holdLoad = true
      workers.push(worker)
      return worker as never
    })
    const loading = host.activate()
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    host.release()
    expect((await loading).phase).toBe('idle')
    expect(host.available()).toBe(false)
    expect((await host.activate()).phase).toBe('ready')
    expect(workers).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(host.ready()).toBe(true)
  })

  it('does not spawn a worker if released during asynchronous file discovery', async () => {
    const loading = host.activate()
    host.release()
    expect((await loading).phase).toBe('idle')
    expect(workers).toHaveLength(0)
    expect((await host.activate()).phase).toBe('ready')
  })
})
