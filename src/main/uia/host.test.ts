import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { UiaHost } from './host'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

function makeChild(kill = vi.fn()) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), postMessage: vi.fn(), kill })
  child.stdin.on('data', line => child.postMessage(JSON.parse(String(line))))
  return child
}
function reply(child: ReturnType<typeof makeChild>, event: object): void { child.stdout.write(JSON.stringify(event) + '\n') }


describe('context reader reclamation', () => {
  beforeEach(() => vi.mocked(spawn).mockReset())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('starts on demand and sends the frozen target over a split JSON pipe', async () => {
    const child = Object.assign(makeChild(), { pid: 123 })
    vi.mocked(spawn).mockReturnValue(child as never)
    const host = new UiaHost(), target = { processId: 22, windowHandle: '11', windowTitle: 'Editor' }
    host.start()
    expect(spawn).not.toHaveBeenCalled(); expect(host.pid).toBeUndefined()
    const pending = host.read(150, target)
    expect(String(vi.mocked(spawn).mock.calls[0][0])).toMatch(/native[\\/]bin[\\/]yu-uia\.exe$/)
    child.stdout.write('{"type":"rea'); child.stdout.write('dy"}\n')
    await Promise.resolve()
    expect(host.pid).toBe(123)
    const request = child.postMessage.mock.calls[0][0]
    expect(request).toMatchObject({ type: 'read', target })
    const snapshot = { controlType: 'edit', controlTypeId: 50004, value: '当前正文' }
    reply(child, { type: 'result', id: request.id, snapshot })
    expect(await pending).toEqual(snapshot)
    host.stop(); expect(host.pid).toBeUndefined()
  })
  it('kills a hung provider, resolves every queued read and ignores its late result', async () => {
    vi.useFakeTimers()
    const old = makeChild(), current = makeChild()
    vi.mocked(spawn).mockReturnValueOnce(old as never).mockReturnValue(current as never)
    const host = new UiaHost(); host.start(); host.warm(); reply(old, { type: 'ready' })
    const first = host.read(150), second = host.read(200)
    await vi.advanceTimersByTimeAsync(150)
    expect(await first).toBeNull(); expect(await second).toBeNull()
    expect(old.kill).toHaveBeenCalledTimes(1); expect(host.available).toBe(false)
    const next = host.read(); reply(current, { type: 'ready' }); await Promise.resolve()
    reply(old, { type: 'result', id: old.postMessage.mock.calls[0][0].id, snapshot: { value: 'late' } })
    old.emit('close', 0)
    reply(current, { type: 'result', id: current.postMessage.mock.calls[0][0].id, snapshot: null })
    expect(await next).toBeNull(); expect(host.available).toBe(true)
    host.stop()
  })
  it('ends a startup wait on stop instead of letting it attach to a new process', async () => {
    vi.useFakeTimers()
    const old = makeChild(), current = makeChild()
    vi.mocked(spawn).mockReturnValueOnce(old as never).mockReturnValue(current as never)
    const host = new UiaHost(); host.start()
    const result = host.read(); host.stop(); host.start(); host.warm()
    reply(current, { type: 'ready' })
    expect(await result).toBeNull()
    expect(current.postMessage).not.toHaveBeenCalled()
    host.stop()
  })
  it('terminates a child that never becomes ready and bounds the startup wait', async () => {
    vi.useFakeTimers()
    const child = makeChild(); vi.mocked(spawn).mockReturnValue(child as never)
    const host = new UiaHost(); host.start(); const result = host.read()
    await vi.advanceTimersByTimeAsync(1500)
    expect(await result).toBeNull(); expect(child.kill).toHaveBeenCalledTimes(1)
    expect(host.available).toBe(false); host.stop()
  })
  it('resolves waiting callers after ENOENT and cancels its bounded retry on stop', async () => {
    vi.useFakeTimers()
    const child = makeChild(); vi.mocked(spawn).mockReturnValue(child as never)
    const host = new UiaHost(); host.start(); const result = host.read()
    child.emit('error', new Error('ENOENT')); child.emit('close', -4058)
    expect(await result).toBeNull(); host.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it('does not reset the crash budget merely because a bad provider reached ready', async () => {
    vi.useFakeTimers()
    const children: Array<ReturnType<typeof makeChild>> = []
    vi.mocked(spawn).mockImplementation(() => { const child = makeChild(); children.push(child); return child as never })
    const host = new UiaHost(); host.start(); host.warm()
    for (let attempt = 0; attempt < 5; attempt++) {
      reply(children.at(-1)!, { type: 'ready' }); children.at(-1)!.emit('close', 1)
      await vi.advanceTimersByTimeAsync(1300)
    }
    expect(children).toHaveLength(4); host.stop()
  })
  it('reclaims an idle native process and does not restart it until requested', async () => {
    vi.useFakeTimers()
    const child = makeChild(); vi.mocked(spawn).mockReturnValue(child as never)
    const host = new UiaHost(); host.start(); host.warm(); reply(child, { type: 'ready' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(child.kill).toHaveBeenCalledTimes(1); expect(host.available).toBe(false)
    child.emit('close', 0); await vi.advanceTimersByTimeAsync(2000)
    expect(spawn).toHaveBeenCalledTimes(1); host.stop()
  })
  it('ends a pending request on a broken pipe or malformed response', async () => {
    const child = makeChild(); vi.mocked(spawn).mockReturnValue(child as never)
    const host = new UiaHost(); host.start(); host.warm(); reply(child, { type: 'ready' })
    const result = host.read(); child.stdin.emit('error', new Error('EPIPE'))
    expect(await result).toBeNull(); expect(child.kill).toHaveBeenCalledTimes(1)
    host.warm(); reply(child, { type: 'ready' })
    const second = host.read(); child.stdout.write('invalid json\n')
    expect(await second).toBeNull(); host.stop()
  })
  it('terminates a reader whose native spawn finishes after stop', () => {
    let spawned = false
    const child = makeChild(vi.fn(() => spawned))
    vi.mocked(spawn).mockReset().mockReturnValue(child as never)
    const host = new UiaHost(); host.start(); host.warm(); host.stop()
    expect(child.kill.mock.results.at(-1)?.value).toBe(false)
    spawned = true; child.emit('spawn')
    expect(child.kill.mock.results.at(-1)?.value).toBe(true)
  })
  it('bounds repeated crashes before a reader ever becomes ready', async () => {
    vi.useFakeTimers()
    const children: EventEmitter[] = []
    vi.mocked(spawn).mockReset().mockImplementation(() => {
      const child = makeChild()
      children.push(child); return child as never
    })
    const host = new UiaHost(); host.start(); host.warm()
    for (let attempt = 0; attempt < 5; attempt++) {
      children.at(-1)!.emit('close', 1)
      await vi.advanceTimersByTimeAsync(1300)
    }
    expect(children).toHaveLength(4)
    host.stop()
  })
  it('does not restart a reader after stop cancels a queued crash retry', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    vi.mocked(spawn).mockReset().mockReturnValue(child as never)
    const host = new UiaHost()
    host.start(); host.warm(); child.emit('close', 1); host.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it('keeps active reads and ignores late events from the reclaimed child', async () => {
    vi.useFakeTimers()
    const workers: Array<ReturnType<typeof makeChild>> = []
    vi.mocked(spawn).mockImplementation(() => {
      const child = makeChild()
      workers.push(child)
      return child as never
    })
    const host = new UiaHost()
    host.start()
    host.warm()
    expect(host.reclaim()).toBe(false)
    reply(workers[0], { type: 'ready' })
    const result = host.read()
    expect(host.reclaim()).toBe(false)
    const request = workers[0].postMessage.mock.calls[0][0]
    reply(workers[0], { type: 'result', id: request.id, snapshot: null })
    expect(await result).toBeNull()
    expect(host.reclaim()).toBe(true)
    host.warm()
    reply(workers[1], { type: 'ready' })
    workers[0].emit('close', 0)
    expect(host.available).toBe(true)
    expect(workers).toHaveLength(2)
    host.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(workers).toHaveLength(2)
  })
})
