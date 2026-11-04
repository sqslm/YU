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

/**
 * The owner has to hear the state a play settles in — and nothing else. A reply
 * for a request this player never issued used to move the busy flag as well, so a
 * stale renderer could keep the pill alive or drop it.
 */
it('reports the state of a play it asked for and ignores a reply nobody asked for', async () => {
  const h = windowHarness()
  const seen: string[] = []
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => 'typeless-audio://note/a', state => seen.push(state.state))
  player.register()
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: 'unknown', state: PLAYING })
  expect(seen).toEqual([])
  const play = player.control('play', 'note-1')
  await tick()
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: h.contents.send.mock.calls[0][1].requestId, state: PLAYING })
  await expect(play).resolves.toEqual(PLAYING)
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

/**
 * 回归：pill 还在启动时收到的 stop 必须先把这次 play 取消掉。旧实现在窗口对象
 * 一出现就发送，于是页面依次收到 stop、play —— 用户按了停止，几秒后却还是起播了。
 */
it('cancels a play that is still waiting for the pill when stop arrives', async () => {
  const h = windowHarness()
  let readyWindow: (win: BrowserWindow | null) => void = () => undefined
  const ensure = vi.fn(() => new Promise<BrowserWindow | null>(resolve => { readyWindow = resolve }))
  const player = new NoteAudioPlayer({ peek: () => h.win, ready: () => false, ensure }, () => 'typeless-audio://note/a')
  player.register()
  const play = player.control('play', 'note-1')
  const playRejected = expect(play).rejects.toThrow('Playback cancelled')
  await expect(player.control('stop')).resolves.toMatchObject({ state: 'idle' })
  readyWindow(h.win)
  await tick()
  expect(h.contents.send.mock.calls.map(call => call[1].action)).toEqual([])
  await playRejected
})

/**
 * 回归：两个 play 的准备完成顺序不可控。旧实现各自等自己的 ensure，后到的
 * 先就绪就先发，页面因此按「新 → 旧」的顺序收到命令，旧录音反而最后胜出。
 */
it('sends only the newest play when two requests reach the pill out of order', async () => {
  const h = windowHarness()
  const waiting: Array<(win: BrowserWindow | null) => void> = []
  const ensure = vi.fn(() => new Promise<BrowserWindow | null>(resolve => { waiting.push(resolve) }))
  const player = new NoteAudioPlayer({ peek: () => null, ensure }, () => 'typeless-audio://note/a')
  player.register()
  const old = player.control('play', 'note-1')
  const fresh = player.control('play', 'note-2')
  const oldRejected = expect(old).rejects.toThrow('Playback superseded')
  waiting[1](h.win)
  waiting[0](h.win)
  await tick()
  expect(h.contents.send.mock.calls.map(call => call[1].id)).toEqual(['note-2'])
  const requestId = h.contents.send.mock.calls[0][1].requestId as string
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId, state: PLAYING })
  await expect(fresh).resolves.toEqual(PLAYING)
  await oldRejected
})

/**
 * 回归：新播放已经回 playing 之后，被替代的旧播放仍会回一条 ended。旧实现先改
 * 忙态再查归属，于是忙态被旧请求释放，pill 在还在放的时候退场。
 */
it('ignores a reply from a play that a newer one already replaced', async () => {
  const h = windowHarness()
  const seen: string[] = []
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => 'typeless-audio://note/a', state => seen.push(state.state))
  player.register()
  const old = player.control('play', 'note-1')
  const oldRejected = expect(old).rejects.toThrow('Playback superseded')
  await tick()
  const stale = h.contents.send.mock.calls[0][1].requestId as string
  const fresh = player.control('play', 'note-2')
  await tick()
  const live = h.contents.send.mock.calls[1][1].requestId as string
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: live, state: PLAYING })
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: stale, state: { ...PLAYING, state: 'ended' } })
  expect(seen).toEqual(['playing'])
  await expect(fresh).resolves.toEqual(PLAYING)
  await oldRejected
})

/** A pause that lands before the pill is listening cancels the queued play. */
it('does not start a play that was paused before the pill became ready', async () => {
  const h = windowHarness()
  const waiting: Array<(win: BrowserWindow | null) => void> = []
  const ensure = vi.fn(() => new Promise<BrowserWindow | null>(resolve => { waiting.push(resolve) }))
  const player = new NoteAudioPlayer({ peek: () => h.win, ready: () => false, ensure }, () => 'typeless-audio://note/a')
  const play = player.control('play', 'note-1')
  const playRejected = expect(play).rejects.toThrow('Playback cancelled')
  const paused = player.control('pause')
  await tick()
  expect(h.contents.send).not.toHaveBeenCalled()
  await expect(paused).resolves.toMatchObject({ state: 'idle' })
  waiting[0](h.win)
  await tick()
  expect(h.contents.send).not.toHaveBeenCalled()
  await playRejected
})

/** A command nobody waits for any more must not hold a readiness wait open. */
it('cancels the readiness wait of a command it stopped waiting for', async () => {
  const h = windowHarness()
  const signals: Array<AbortSignal | undefined> = []
  const ensure = vi.fn((signal?: AbortSignal) => { signals.push(signal); return new Promise<BrowserWindow | null>(() => undefined) })
  const player = new NoteAudioPlayer({ peek: () => h.win, ready: () => false, ensure }, () => 'typeless-audio://note/a')
  const play = player.control('play', 'note-1')
  const playRejected = expect(play).rejects.toThrow('Playback cancelled')
  await player.control('stop')
  expect(signals[0]).toBeInstanceOf(AbortSignal)
  expect(signals[0]!.aborted).toBe(true)
  await playRejected
})

/** A cold pill must not turn stop into an 8 s wait for a page that never heard it. */
it('answers stop from the preparation state instead of waiting on a page that is not listening', async () => {
  vi.useFakeTimers()
  const h = windowHarness()
  const player = new NoteAudioPlayer({ peek: () => h.win, ready: () => false, ensure: () => new Promise<BrowserWindow | null>(() => undefined) }, () => 'typeless-audio://note/a')
  const play = player.control('play', 'note-1')
  const playRejected = expect(play).rejects.toThrow('Playback cancelled')
  const stopped = player.control('stop')
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(h.contents.send).not.toHaveBeenCalled()
  await expect(stopped).resolves.toMatchObject({ state: 'idle' })
  await playRejected
})

/** Only the play that currently owns the element may move the busy flag. */
it('filters playback events by the active play', async () => {
  const h = windowHarness()
  const player = new NoteAudioPlayer({ peek: () => h.win, ensure: async () => h.win }, () => 'typeless-audio://note/a')
  player.register()
  const first = player.control('play', 'note-1')
  const firstRejected = expect(first).rejects.toThrow('Playback superseded')
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
  await expect(second).resolves.toEqual(PLAYING)
  await firstRejected
})

/**
 * 回归：只读的 status 不得打断正在准备的播放。旧实现把「没有就绪窗口」当成
 * 「取消所有未结算 play」，于是一次状态查询会让冷启动的播放被悄悄取消。
 */
it('does not cancel a play that is still starting when status is queried', async () => {
  const h = windowHarness()
  let readyWindow: (win: BrowserWindow | null) => void = () => undefined
  const ensure = vi.fn(() => new Promise<BrowserWindow | null>(resolve => { readyWindow = resolve }))
  const player = new NoteAudioPlayer({ peek: () => h.win, ready: () => false, ensure }, () => 'typeless-audio://note/a')
  player.register()
  const play = player.control('play', 'note-1')
  await expect(player.control('status')).resolves.toMatchObject({ state: 'idle' })
  readyWindow(h.win)
  await tick()
  expect(h.contents.send.mock.calls.map(call => call[1].action)).toEqual(['play'])
  handlers.get('note-audio:reply')!({ sender: h.contents }, { requestId: h.contents.send.mock.calls[0][1].requestId, state: PLAYING })
  await expect(play).resolves.toEqual(PLAYING)
})
