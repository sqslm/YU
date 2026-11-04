import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { createSpeechPlayback } from './speech-playback'
const handlers = vi.hoisted(() => new Map<string, (event: unknown, reply: unknown) => void>())
vi.mock('./ipc-trust', () => ({ handle: (name: string, fn: (event: unknown, reply: unknown) => void) => handlers.set(name, fn) }))
afterEach(() => { vi.useRealTimers(); handlers.clear() })
function harness() {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const ensure = vi.fn(async () => win)
  const run = createSpeechPlayback({ peek: () => win, ensure })
  const reply = (value: unknown): void => handlers.get('speech:playback-reply')!({ sender: contents }, value)
  const request = { action: 'speak' as const, audio: { bytes: new Uint8Array([1]), mime: 'audio/mpeg' }, volume: 40 }
  return { contents, run, reply, request, ensure }
}
/** The command is only valid once the renderer is listening, so it is sent after `ensure`. */
const sent = async (h: ReturnType<typeof harness>, index = 0): Promise<Record<string, unknown>> => {
  for (let tick = 0; tick < 5 && h.contents.send.mock.calls.length <= index; tick += 1) await new Promise(resolve => setImmediate(resolve))
  return h.contents.send.mock.calls[index][1]
}
it('waits for actual start and end; controls use their own acknowledgement', async () => {
  const h = harness(), started = vi.fn(), controller = new AbortController()
  const pending = h.run(h.request, controller.signal, started)
  const id = (await sent(h)).id as string
  expect(h.ensure).toHaveBeenCalled()
  expect(started).not.toHaveBeenCalled()
  h.reply({ id, event: 'started' }); expect(started).toHaveBeenCalledOnce()
  const pause = h.run.control!('pause')
  const controlId = (await sent(h, 1)).id as string
  h.reply({ id: controlId, event: 'control' }); expect(await pause).toMatchObject({ ok: true })
  h.reply({ id, event: 'ended' }); expect(await pending).toEqual({ ok: true, error: undefined })
  expect(h.contents.listenerCount('destroyed')).toBe(0)
})
it('immediately stops on abort and ignores a stale ended event', async () => {
  const h = harness(), controller = new AbortController()
  const pending = h.run(h.request, controller.signal)
  const id = (await sent(h)).id as string
  controller.abort()
  expect(await pending).toMatchObject({ ok: false })
  expect(h.contents.send).toHaveBeenLastCalledWith('speech:playback', { id, action: 'stop' })
  h.reply({ id, event: 'ended' })
  expect(h.contents.listenerCount('destroyed')).toBe(0)
})
it('reports a closed renderer or a budget that runs out as a failure', async () => {
  vi.useFakeTimers()
  const h = harness()
  const closed = h.run(h.request)
  await vi.advanceTimersByTimeAsync(1)
  h.contents.emit('render-process-gone')
  expect(await closed).toMatchObject({ ok: false, error: 'Speech player closed' })
  const timeout = h.run(h.request)
  await vi.advanceTimersByTimeAsync(1)
  const expired = expect(timeout).resolves.toMatchObject({ ok: false })
  await vi.advanceTimersByTimeAsync(20_001)
  await expired
})
/** A forged or retired renderer must be ignored, and must not create a window. */
it('ignores a reply from a window that is not the owner', async () => {
  const h = harness()
  const pending = h.run(h.request)
  const id = (await sent(h)).id as string
  expect(() => handlers.get('speech:playback-reply')!({ sender: {} }, { id: 'forged', event: 'ended' })).not.toThrow()
  expect(h.ensure).toHaveBeenCalledOnce()
  h.reply({ id, event: 'ended' })
  expect(await pending).toMatchObject({ ok: true })
})
/** 回归：取消/替换/超时都要终结就绪等待本身，而不是留着监听等一个没人要的窗口。 */
it('cancels the readiness wait when the command is cancelled', async () => {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const signals: Array<AbortSignal | undefined> = []
  const ensure = vi.fn((signal?: AbortSignal) => { signals.push(signal); return new Promise<BrowserWindow | null>(() => undefined) })
  const run = createSpeechPlayback({ peek: () => win, ensure })
  const controller = new AbortController()
  const pending = run({ action: 'speak', audio: { bytes: new Uint8Array([1]), mime: 'audio/mpeg' } }, controller.signal)
  controller.abort()
  expect(await pending).toMatchObject({ ok: false })
  expect(signals[0]).toBeInstanceOf(AbortSignal)
  expect(signals[0]!.aborted).toBe(true)
  expect(contents.send).not.toHaveBeenCalled()
})

it('reports missing readiness instead of keeping the caller waiting', async () => {
  const run = createSpeechPlayback({ peek: () => null, ensure: async () => null })
  await expect(run({ action: 'speak', audio: { bytes: new Uint8Array([1]), mime: 'audio/mpeg' } })).resolves.toEqual({ ok: false, error: 'Speech playback is not ready' })
})
