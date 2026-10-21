import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeRecording, MAX_IMPORT_BYTES, MAX_IMPORT_SAMPLES } from './decode'
import { encodeWav } from './wav'

let dir: string
const ffmpeg = process.env.TYPELESS_FFMPEG || 'ffmpeg'
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'typeless-decode-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('recording import decoding', () => {
  it('reads native WAV losslessly without FFmpeg and leaves the source untouched', async () => {
    const pcm = Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 10) * 9000))
    const wav = encodeWav(pcm), file = join(dir, 'test.wav')
    writeFileSync(file, wav)
    expect(await decodeRecording(file)).toEqual({ pcm, durationMs: 1000 })
    expect(readFileSync(file)).toEqual(Buffer.from(wav))
  })
  it('rejects empty, unsupported, oversized, overlong and cancelled files', async () => {
    const file = join(dir, 'test.wav')
    writeFileSync(file, encodeWav(new Int16Array(0)))
    await expect(decodeRecording(file)).rejects.toThrow('有效音频')
    writeFileSync(file, encodeWav(new Int16Array(MAX_IMPORT_SAMPLES + 1)))
    await expect(decodeRecording(file)).rejects.toThrow('10 分钟')
    truncateSync(file, MAX_IMPORT_BYTES + 1)
    await expect(decodeRecording(file)).rejects.toThrow('128 MB')
    const other = join(dir, 'test.txt')
    writeFileSync(other, 'not audio')
    await expect(decodeRecording(other)).rejects.toThrow('请选择')
    const controller = new AbortController(); controller.abort()
    await expect(decodeRecording(file, controller.signal)).rejects.toThrow()
  })
  it.skipIf(!hasFfmpeg)('decodes real MP3 and stereo 48 kHz WAV through installed FFmpeg', async () => {
    const input = join(dir, 'stereo.wav'), mp3 = join(dir, 'speech.mp3')
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', '-ar', '48000', input], { windowsHide: true })
    expect(generated.error, 'Install FFmpeg to run recording format integration tests').toBeUndefined()
    expect(generated.status).toBe(0)
    expect(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', input, mp3], { windowsHide: true }).status).toBe(0)
    for (const file of [input, mp3]) {
      const before = readFileSync(file)
      const result = await decodeRecording(file)
      expect(result.durationMs).toBeGreaterThanOrEqual(990)
      expect(result.durationMs).toBeLessThanOrEqual(1050)
      expect(result.pcm.some(value => Math.abs(value) > 100)).toBe(true)
      expect(readFileSync(file)).toEqual(before)
    }
  })
})
