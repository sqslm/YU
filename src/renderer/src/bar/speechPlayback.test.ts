import { afterEach, expect, it, vi } from 'vitest'
import { createSpeechPlayer } from './speechPlayback'
import type { SpeechPlaybackRequest } from '@shared/speech'

afterEach(() => vi.restoreAllMocks())
function harness() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const audio = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), onended: null, onerror: null } as unknown as HTMLAudioElement
  const reply = vi.fn(), player = createSpeechPlayer(reply, audio)
  const play: SpeechPlaybackRequest = { id: 'one', action: 'play', audio: { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }, volume: 35, speed: 1.5 }
  return { audio, player, reply, play, revoke }
}
it('acknowledges actual playback, retains position on controls and releases audio after completion', async () => {
  const h = harness()
  let start: () => void = () => undefined
  vi.mocked(h.audio.play).mockImplementationOnce(() => new Promise(resolve => { start = resolve }))
  const pending = h.player.run(h.play)
  expect(h.reply).not.toHaveBeenCalled()
  start(); await pending
  expect(h.reply).toHaveBeenLastCalledWith({ id: 'one', event: 'started' })
  expect(h.audio.volume).toBe(0.35); expect(h.audio.playbackRate).toBe(1.5)
  h.audio.currentTime = 18
  await h.player.run({ id: 'pause', action: 'pause' })
  await h.player.run({ id: 'resume', action: 'resume' })
  expect(h.audio.currentTime).toBe(18)
  h.audio.onended!(new Event('ended'))
  expect(h.reply).toHaveBeenLastCalledWith({ id: 'one', event: 'ended' })
  expect(h.revoke).toHaveBeenCalledWith('blob:test')
})
it('stops and revokes the audio immediately; a stale stop does not affect a newer utterance', async () => {
  const h = harness()
  await h.player.run(h.play)
  await h.player.run({ ...h.play, id: 'two' })
  h.audio.pause = vi.fn()
  await h.player.run({ id: 'one', action: 'stop' })
  expect(h.audio.pause).not.toHaveBeenCalled()
  await h.player.run({ id: 'two', action: 'stop' })
  expect(h.audio.pause).toHaveBeenCalled()
  expect(h.revoke).toHaveBeenCalledTimes(2)
})
it('reports decode failures and ignores old play rejections after a new utterance starts', async () => {
  const h = harness()
  let reject: (error: Error) => void = () => undefined
  vi.mocked(h.audio.play).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const pending = h.player.run(h.play)
  await h.player.run({ ...h.play, id: 'two' })
  reject(Error('interrupted')); await pending
  expect(h.reply).toHaveBeenCalledExactlyOnceWith({ id: 'two', event: 'started' })
  h.audio.onerror!(new Event('error'))
  expect(h.reply).toHaveBeenLastCalledWith({ id: 'two', event: 'error', error: 'Cannot decode speech audio' })
})
