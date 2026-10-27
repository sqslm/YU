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
  const run = createSpeechPlayback(() => win)
  const reply = (value: unknown): void => handlers.get('speech:playback-reply')!({ sender: contents }, value)
  const request = { action: 'speak' as const, audio: { bytes: new Uint8Array([1]), mime: 'audio/mpeg' }, volume: 40 }
  return { contents, run, reply, request }
}
it('waits for actual start and end; controls use their own acknowledgement', async () => {
  const h = harness(), started = vi.fn(), controller = new AbortController()
  const pending = h.run(h.request, controller.signal, started)
  const id = h.contents.send.mock.calls[0][1].id
  expect(started).not.toHaveBeenCalled()
  h.reply({ id, event: 'started' }); expect(started).toHaveBeenCalledOnce()
  const pause = h.run.control!('pause'), controlId = h.contents.send.mock.calls[1][1].id
  h.reply({ id: controlId, event: 'control' }); expect(await pause).toMatchObject({ ok: true })
  h.reply({ id, event: 'ended' }); expect(await pending).toEqual({ ok: true, error: undefined })
  expect(h.contents.listenerCount('destroyed')).toBe(0)
})
it('immediately stops on abort and ignores a stale ended event', async () => {
  const h = harness(), controller = new AbortController()
  const pending = h.run(h.request, controller.signal)
  const id = h.contents.send.mock.calls[0][1].id
  controller.abort()
  expect(await pending).toMatchObject({ ok: false })
  expect(h.contents.send).toHaveBeenLastCalledWith('speech:playback', { id, action: 'stop' })
  h.reply({ id, event: 'ended' })
  expect(h.contents.listenerCount('destroyed')).toBe(0)
})
it('reports a closed renderer or missing startup acknowledgement as a failure', async () => {
  vi.useFakeTimers()
  const h = harness()
  const closed = h.run(h.request)
  h.contents.emit('render-process-gone')
  expect(await closed).toMatchObject({ ok: false, error: 'Speech player closed' })
  const timeout = h.run(h.request)
  await vi.advanceTimersByTimeAsync(20_001)
  expect(await timeout).toMatchObject({ ok: false })
  expect(() => handlers.get('speech:playback-reply')!({ sender: {} }, { id: 'forged', event: 'ended' })).toThrow('owner')
})
