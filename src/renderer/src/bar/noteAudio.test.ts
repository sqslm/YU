import { describe, it, expect, vi } from 'vitest'
import { createNoteAudioPlayer } from './noteAudio'

describe('shared note recording playback', () => {
  it('does not clear the new recording when an interrupted play rejects late', async () => {
    let rejectOld: (error: Error) => void = () => undefined
    const audio = { paused: false, ended: false, currentTime: 0, duration: 120, playbackRate: 1,
      pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn(),
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
      load: vi.fn(), removeAttribute: vi.fn() } as unknown as HTMLAudioElement
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
    const audio = {pause:vi.fn(), load:vi.fn(),removeAttribute:vi.fn(),play:vi.fn().mockRejectedValue(Error('decode failed'))} as unknown as HTMLAudioElement
    const player=createNoteAudioPlayer(audio)
    await expect(player.run({requestId:'1',action:'play',id:'n',url:'https://example.org/a.mp3'})).rejects.toThrow('Invalid')
    expect(audio.play).not.toHaveBeenCalled()
    await expect(player.run({requestId:'2',action:'play',id:'n',url:'typeless-audio://note/n'})).rejects.toThrow('decode failed')
    expect(await player.run({requestId:'3',action:'status'})).toMatchObject({id:null,state:'idle'})
  })
})
