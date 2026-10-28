import { afterEach, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { encodeWav } from './audio/wav'
import { CardVoice } from './card-voice'
import * as asr from './providers/asr'
afterEach(() => vi.restoreAllMocks())

const wave = (): Uint8Array => encodeWav(Int16Array.from({ length: 16000 }, (_, n) => Math.sin(n / 10) * 4000))
const harness = (recognize = vi.fn(async () => '  解释上一条回答  ')) => {
  const changed = vi.fn()
  const voice = new CardVoice({ settings: () => mergeSettings({}), changed, recognize, local: vi.fn(), log: vi.fn() })
  return { voice, recognize, changed }
}
it('reserves one microphone and returns transcription without creating a new Ask conversation', async () => {
  const { voice, recognize } = harness()
  const id = voice.begin()!
  expect(voice.begin()).toBeNull()
  expect(await voice.finish(id, wave())).toBe('解释上一条回答')
  expect(recognize).toHaveBeenCalledOnce()
  expect(voice.active).toBe(false)
})
it('rejects invalid, silent and oversized recordings before calling a provider', async () => {
  const { voice, recognize } = harness()
  for (const wav of [new Uint8Array(10), new Uint8Array(2_000_001), encodeWav(new Int16Array(16000))]) {
    await expect(voice.finish(voice.begin()!, wav)).rejects.toThrow()
    expect(voice.active).toBe(false)
  }
  expect(recognize).not.toHaveBeenCalled()
})
it('does not let a late transcription or cancellation close a newer recording', async () => {
  let resolve!: (text: string) => void
  const { voice } = harness(vi.fn(() => new Promise<string>(done => { resolve = done })))
  const oldId = voice.begin()!
  const result = voice.finish(oldId, wave())
  voice.cancel(oldId)
  const newId = voice.begin()!
  voice.cancel(oldId)
  expect(voice.active).toBe(true)
  resolve('stale question')
  await expect(result).rejects.toThrow()
  expect(voice.active).toBe(true)
  voice.cancel(newId)
})
it('uses the configured provider chain when local recognition is unavailable', async () => {
  const transcribe = vi.spyOn(asr, 'transcribe').mockRejectedValueOnce(new Error('First provider unavailable')).mockResolvedValueOnce({ text: 'A real follow-up transcript', model: 'second' })
  const settings = mergeSettings({ localAsr: { enabled: true } as never, profiles: ['first', 'second'].map(id => ({ id, kind: 'asr' as const, name: id, enabled: true, preset: '', baseUrl: `https://${id}.test/v1`, apiKey: 'test-key', model: id })) })
  const local = vi.fn().mockRejectedValue(new Error('No local model'))
  const voice = new CardVoice({ settings: () => settings, changed: vi.fn(), local, log: vi.fn() })
  expect(await voice.finish(voice.begin()!, wave())).toBe('A real follow-up transcript')
  expect(local).toHaveBeenCalledOnce()
  expect(transcribe.mock.calls.map(([profile]) => profile.model)).toEqual(['first', 'second'])
})
