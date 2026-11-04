import { describe, it, expect, vi } from 'vitest'
import { createNoteAudioPlayer } from './noteAudio'
import type { NoteAudioEvent } from '@shared/noteAudio'

/** Just enough of an audio element: state, playback promises and media events. */
class FakeAudio {
  paused = true
  ended = false
  currentTime = 0
  duration = 120
  playbackRate = 1
  src = ''
  listeners = new Map<string, Set<() => void>>()
  pause = vi.fn(() => { this.paused = true; this.emit('pause') })
  play = vi.fn(async () => { this.paused = false })
  load = vi.fn()
  removeAttribute = vi.fn()
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string): void { for (const listener of [...(this.listeners.get(type) ?? [])]) listener() }
}

describe('shared note recording playback', () => {
  it('does not clear the new recording when an interrupted play rejects late', async () => {
    let rejectOld: (error: Error) => void = () => undefined
    const audio = { paused: false, ended: false, currentTime: 0, duration: 120, playbackRate: 1,
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      play: vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject })).mockResolvedValue(undefined) } as unknown as HTMLAudioElement
    const player = createNoteAudioPlayer(audio)
    const old = player.run({ requestId: '1', action: 'play', id: 'old', url: 'typeless-audio://note/old' })
    await player.run({ requestId: '2', action: 'play', id: 'new', url: 'typeless-audio://note/new' })
    rejectOld(Error('interrupted'))
    await expect(old).rejects.toThrow('interrupted')
    expect(await player.run({ requestId: '3', action: 'status' })).toMatchObject({ id: 'new', state: 'playing' })
    expect(audio.removeAttribute).not.toHaveBeenCalled()
  })
  it('pauses and resumes the same recording at the actual position, and unloads on stop', async () => {
    const audio = { paused: true, ended: false, currentTime: 0, duration: 120, playbackRate: 1, src: '',
      pause: vi.fn(function(this: {paused:boolean}) { this.paused = true }),
      play: vi.fn(async function(this: {paused:boolean}) { this.paused = false }),
      load: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLAudioElement
    const player = createNoteAudioPlayer(audio)
    expect(await player.run({ requestId:'1', action:'play', id:'n', url:'typeless-audio://note/n' })).toMatchObject({id:'n',state:'playing'})
    audio.currentTime = 19
    expect(await player.run({requestId:'2',action:'pause'})).toMatchObject({state:'paused',positionMs:19000})
    expect(await player.run({requestId:'3',action:'resume'})).toMatchObject({state:'playing',positionMs:19000})
    expect(audio.load).toHaveBeenCalledTimes(1)
    await expect(player.run({requestId:'4',action:'pause',id:'other'})).rejects.toThrow()
    expect(await player.run({requestId:'5',action:'stop'})).toMatchObject({id:null,state:'idle'})
    expect(audio.removeAttribute).toHaveBeenCalledWith('src')
    await expect(player.run({requestId:'6',action:'resume'})).rejects.toThrow()
  })
  it('does not acknowledge a rejected audio play or accept a remote source', async () => {
    const audio = {pause:vi.fn(), load:vi.fn(),removeAttribute:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),play:vi.fn().mockRejectedValue(Error('decode failed'))} as unknown as HTMLAudioElement
    const player=createNoteAudioPlayer(audio)
    await expect(player.run({requestId:'1',action:'play',id:'n',url:'https://example.org/a.mp3'})).rejects.toThrow('Invalid')
    expect(audio.play).not.toHaveBeenCalled()
    await expect(player.run({requestId:'2',action:'play',id:'n',url:'typeless-audio://note/n'})).rejects.toThrow('decode failed')
    expect(await player.run({requestId:'3',action:'status'})).toMatchObject({id:null,state:'idle'})
  })
})

describe('playback state reporting', () => {
  it('reports the real transitions tagged with the play command that owns them', async () => {
    const audio = new FakeAudio(), seen: NoteAudioEvent[] = []
    const player = createNoteAudioPlayer(audio as unknown as HTMLAudioElement, { report: state => seen.push(state) })
    await player.run({ requestId: 'play-1', action: 'play', id: 'n', url: 'typeless-audio://note/n' })
    audio.emit('playing')
    audio.paused = false
    audio.emit('pause')
    audio.ended = true
    audio.emit('ended')
    expect(seen.map(event => [event.requestId, event.state])).toEqual([['play-1', 'playing'], ['play-1', 'paused'], ['play-1', 'ended']])
  })
  it('stops reporting once the playback was stopped or replaced', async () => {
    const audio = new FakeAudio(), seen: NoteAudioEvent[] = []
    const player = createNoteAudioPlayer(audio as unknown as HTMLAudioElement, { report: state => seen.push(state) })
    await player.run({ requestId: 'play-1', action: 'play', id: 'n', url: 'typeless-audio://note/n' })
    audio.emit('playing')
    await player.run({ requestId: 'stop-1', action: 'stop' })
    audio.emit('ended')
    audio.emit('pause')
    expect(seen.map(event => event.state)).toEqual(['playing', 'idle'])
  })
  it('fails instead of holding the pill when the source never becomes playable', async () => {
    vi.useFakeTimers()
    const audio = new FakeAudio()
    audio.play = vi.fn(() => new Promise(() => undefined))
    const player = createNoteAudioPlayer(audio as unknown as HTMLAudioElement)
    const play = player.run({ requestId: 'play-1', action: 'play', id: 'n', url: 'typeless-audio://note/n' })
    const failed = expect(play).rejects.toThrow('录音无法播放')
    await vi.advanceTimersByTimeAsync(5001)
    await failed
    vi.useRealTimers()
  })
  it('fails on a decode error the element reports before the play promise settles', async () => {
    const audio = new FakeAudio()
    audio.play = vi.fn(() => {
      queueMicrotask(() => audio.emit('error'))
      return new Promise(() => undefined)
    })
    const player = createNoteAudioPlayer(audio as unknown as HTMLAudioElement)
    await expect(player.run({ requestId: 'play-1', action: 'play', id: 'n', url: 'typeless-audio://note/n' })).rejects.toThrow('录音无法播放')
  })
})
