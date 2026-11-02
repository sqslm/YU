import { expect, it } from 'vitest'
import { encodeWav } from '@shared/audio'
import { wavToSamples } from './worker'

it('preserves every signed PCM16 value when converting directly to Float32', () => {
  const pcm = Int16Array.from({ length: 65536 }, (_, i) => i - 32768)
  const wav = encodeWav(pcm), original = wav.slice()
  expect(wavToSamples(wav)).toEqual(Float32Array.from(pcm, value => value / 32768))
  expect(wav).toEqual(original)
})

it('honours a sliced byte offset and skips odd-length RIFF chunks with padding', () => {
  const wav = encodeWav(new Int16Array([-32768, 0, 32767]))
  const junk = Buffer.alloc(10); junk.write('JUNK'); junk.writeUInt32LE(1, 4); junk[8] = 123
  const container = Buffer.concat([Buffer.from([99]), wav.subarray(0, 36), junk, wav.subarray(36), Buffer.from([88])])
  const sliced = container.subarray(1, -1)
  expect(wavToSamples(sliced)).toEqual(new Float32Array([-1, 0, 32767 / 32768]))
})

it('keeps existing empty/truncated data semantics and rejects a missing data chunk', () => {
  expect(wavToSamples(encodeWav(new Int16Array()))).toHaveLength(0)
  const wav = encodeWav(new Int16Array([-12345, 23456, 99]))
  expect(wavToSamples(wav.subarray(0, -1))).toEqual(new Float32Array([-12345 / 32768, 23456 / 32768]))
  expect(() => wavToSamples(wav.subarray(0, 36))).toThrow('wav has no data chunk')
})
