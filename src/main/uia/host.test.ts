import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { utilityProcess } from 'electron'
import { UiaHost } from './host'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

describe('context reader reclamation', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('bounds repeated crashes before a reader ever becomes ready', async () => {
    vi.useFakeTimers()
    const children: EventEmitter[] = []
    vi.mocked(utilityProcess.fork).mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
      children.push(child); return child as never
    })
    const host = new UiaHost(); host.start(); host.warm()
    for (let attempt = 0; attempt < 5; attempt++) {
      children.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1300)
    }
    expect(children).toHaveLength(4)
    host.stop()
  })
  it('does not restart a reader after stop cancels a queued crash retry', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    vi.mocked(utilityProcess.fork).mockReset().mockReturnValue(child as never)
    const host = new UiaHost()
    host.start(); host.warm(); child.emit('exit', 1); host.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1)
  })
  it('keeps active reads and ignores late events from the reclaimed child', async () => {
    vi.useFakeTimers()
    const workers: Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }> = []
    vi.mocked(utilityProcess.fork).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
      workers.push(child)
      return child as never
    })
    const host = new UiaHost()
    host.start()
    host.warm()
    expect(host.reclaim()).toBe(false)
    workers[0].emit('message', { type: 'ready' })
    const result = host.read()
    expect(host.reclaim()).toBe(false)
    const request = workers[0].postMessage.mock.calls[0][0]
    workers[0].emit('message', { type: 'result', id: request.id, snapshot: null })
    expect(await result).toBeNull()
    expect(host.reclaim()).toBe(true)
    host.warm()
    workers[1].emit('message', { type: 'ready' })
    workers[0].emit('exit', 0)
    expect(host.available).toBe(true)
    expect(workers).toHaveLength(2)
    host.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(workers).toHaveLength(2)
  })
})
