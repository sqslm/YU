import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { NoteAudioPlayer } from './note-audio'
import type { NoteAudioState } from '@shared/noteAudio'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, reply: unknown) => void>())
vi.mock('./ipc-trust', () => ({ handle: (name: string, fn: (event: unknown, reply: unknown) => void) => handlers.set(name, fn) }))

afterEach(() => { handlers.clear() })

function windowHarness() {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  return { contents, win: { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow }
}

/**
 * The pill is retired between takes, so the player must ask for a window on
 * every command instead of closing over one: a stale reference is exactly the
 * "playback service is not ready" bug this pins.
 */
it('asks the sink for a window on every command', async () => {
  const first = windowHarness(), second = windowHarness()
  let current = first.win
  const player = new NoteAudioPlayer(() => current, () => 'typeless-audio://note/a')
  player.register()

  const play = player.control('play', 'note-1')
  expect(first.contents.send).toHaveBeenCalledOnce()
  const requestId = first.contents.send.mock.calls[0][1].requestId
  const state: NoteAudioState = { id: 'note-1', state: 'playing', positionMs: 0, durationMs: 1000, rate: 1 }
  handlers.get('note-audio:reply')!({ sender: first.contents }, { requestId, state })
  expect(await play).toEqual(state)

  current = second.win
  const status = player.control('status')
  expect(second.contents.send).toHaveBeenCalledOnce()
  handlers.get('note-audio:reply')!({ sender: second.contents }, { requestId: second.contents.send.mock.calls[0][1].requestId, state: { ...state, state: 'idle' } })
  expect(await status).toMatchObject({ state: 'idle' })
})

/** The owner has to hear playback that the page started on its own. */
it('reports the page-driven state so the window can be kept alive', async () => {
  const h = windowHarness()
  const seen: string[] = []
  const player = new NoteAudioPlayer(() => h.win, () => null, state => seen.push(state.state))
  player.register()
  const playing: NoteAudioState = { id: 'note-2', state: 'playing', positionMs: 0, durationMs: 1000, rate: 1 }
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: 'unknown', state: playing })
  expect(seen).toEqual(['playing'])
})

it('refuses to drive a window the sink no longer provides', async () => {
  const player = new NoteAudioPlayer(() => null, () => 'typeless-audio://note/a')
  player.register()
  await expect(player.control("play", "note-1")).rejects.toThrow('录音播放服务尚未就绪')
})
