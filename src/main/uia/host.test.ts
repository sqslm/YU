import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { utilityProcess } from 'electron'
import { UiaHost } from './host'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

describe('context reader reclamation', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
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
