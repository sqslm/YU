import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { NoteAudioPlayer } from './note-audio'
import type { NoteAudioEvent, NoteAudioState } from '@shared/noteAudio'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, reply: unknown) => void>())
vi.mock('./ipc-trust', () => ({ handle: (name: string, fn: (event: unknown, reply: unknown) => void) => handlers.set(name, fn) }))

afterEach(() => { vi.useRealTimers(); handlers.clear() })

function windowHarness() {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  return { contents, win: { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const PLAYING: NoteAudioState = { id: 'note-1', state: 'playing', positionMs: 0, durationMs: 1000, rate: 1 }

/**
 * The pill is retired between takes, so a command that needs its renderer has to
 * ask for one and wait until that renderer is listening — sending the moment the
 * window object exists is what lost the first command after a (re)create.
 */
it('creates the window for playback and only sends once it is ready', async () => {
  const h = windowHarness()
  const ensure = vi.fn(async () => h.win)
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure }, () => 'typeless-audio://note/a')
  player.register()

  const play = player.control('play', 'note-1')
  expect(ensure).toHaveBeenCalledOnce()
  expect(h.contents.send).not.toHaveBeenCalled()
  await tick()
  expect(h.contents.send).toHaveBeenCalledWith('note-audio:command', expect.objectContaining({ action: 'play', id: 'note-1', url: 'typeless-audio://note/a' }))
  const requestId = h.contents.send.mock.calls[0][1].requestId
  expect(player.activePlayId).toBe(requestId)
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId, state: PLAYING })
  expect(await play).toEqual(PLAYING)
})

/** A query or a stop must never be the reason a pill is created. */
it('answers status, pause and stop without a window and without creating one', async () => {
  const ensure = vi.fn(async () => null)
  const player = new NoteAudioPlayer({ peek: () => null, ensure }, () => 'typeless-audio://note/a')
  await expect(player.control('status')).resolves.toEqual({ id: null, state: 'idle', positionMs: 0, durationMs: 0, rate: 1 })
  await expect(player.control('pause')).resolves.toMatchObject({ state: 'idle' })
  await expect(player.control('stop')).resolves.toMatchObject({ state: 'idle' })
  expect(ensure).not.toHaveBeenCalled()
})

it('asks the current window on every command instead of closing over one', async () => {
  const first = windowHarness(), second = windowHarness()
  let current: BrowserWindow | null = first.win
  const player = new NoteAudioPlayer({ peek: () => current, ensure: async () => current }, () => 'typeless-audio://note/a')
  player.register()
  current = second.win
  const status = player.control('status')
  expect(second.contents.send).toHaveBeenCalledOnce()
  handlers.get('note-audio:reply')!({ sender: second.contents }, { requestId: second.contents.send.mock.calls[0][1].requestId, state: { ...PLAYING, state: 'idle' } })
  expect(await status).toMatchObject({ state: 'idle' })
})

/** The owner has to hear playback that the page started on its own. */
it('reports the page-driven state so the window can be kept alive', async () => {
  const h = windowHarness()
  const seen: string[] = []
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => null, state => seen.push(state.state))
  player.register()
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: 'unknown', state: PLAYING })
  expect(seen).toEqual(['playing'])
})

/** A late reply used to come from the creating sink, which rebuilt the pill. */
it('ignores a reply from a window that no longer owns playback', async () => {
  const ensure = vi.fn(async () => null)
  const player = new NoteAudioPlayer({ peek: () => null, ensure }, () => null)
  player.register()
  expect(() => handlers.get('note-audio:reply')!({ sender: {} }, { requestId: 'stale', state: PLAYING })).not.toThrow()
  expect(ensure).not.toHaveBeenCalled()
})

it('refuses to drive a window that dies while it is being created', async () => {
  const dead = { webContents: Object.assign(new EventEmitter(), { send: vi.fn() }), isDestroyed: () => true } as unknown as BrowserWindow
  const player = new NoteAudioPlayer({ peek: () => null, ensure: async () => dead }, () => 'typeless-audio://note/a')
  player.register()
  await expect(player.control('play', 'note-1')).rejects.toThrow('录音播放服务尚未就绪')
})

it('times out a command that is never answered, even while the window is being created', async () => {
  vi.useFakeTimers()
  const player = new NoteAudioPlayer({ peek: () => null, ensure: () => new Promise(() => undefined) }, () => 'typeless-audio://note/a')
  const play = player.control('play', 'note-1')
  const rejected = expect(play).rejects.toThrow('录音播放没有响应')
  await vi.advanceTimersByTimeAsync(8001)
  await rejected
})

it('releases pending commands on dispose', async () => {
  const h = windowHarness()
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => 'typeless-audio://note/a')
  const play = player.control('play', 'note-1')
  await tick()
  player.dispose()
  await expect(play).rejects.toThrow('Playback closed')
})

/** Only the play that currently owns the element may move the busy flag. */
it('filters playback events by the active play', async () => {
  const h = windowHarness()
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => 'typeless-audio://note/a')
  player.register()
  const first = player.control('play', 'note-1')
  await tick()
  const stale = h.contents.send.mock.calls[0][1].requestId as string
  const second = player.control('play', 'note-1')
  await tick()
  const live = h.contents.send.mock.calls[1][1].requestId as string
  expect(player.acceptEvent({ ...PLAYING, requestId: live } as NoteAudioEvent)).toMatchObject({ requestId: live })
  expect(player.acceptEvent({ ...PLAYING, requestId: stale } as NoteAudioEvent)).toBeNull()
  expect(player.acceptEvent(null)).toBeNull()
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: stale, error: 'Playback superseded' })
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: live, state: PLAYING })
  await expect(first).rejects.toThrow('Playback superseded')
  await expect(second).resolves.toEqual(PLAYING)
})
