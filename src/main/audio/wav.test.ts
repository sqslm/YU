import { describe, expect, it } from 'vitest'
import {
  SAMPLE_RATE,
  concatPcm,
  decodeWavPcm16,
  encodeWav,
  isSilent,
  pcmDurationMs,
  trimSilencePcm,
  wavDurationMs,
  wavInfo
} from './wav'

function tone(samples: number, amplitude = 6000): Int16Array {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
  }
  return pcm
}

describe('encodeWav', () => {
  it('writes a mono 16-bit RIFF header matching the payload length', () => {
    const pcm = tone(1600)
    const wav = encodeWav(pcm)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.byteLength)
    expect(wav.byteLength).toBe(44 + pcm.byteLength)
  })

  it('honours a custom sample rate', () => {
    const wav = encodeWav(tone(100), 8000)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint32(28, true)).toBe(16000) // byte rate
  })
})

describe('pcmDurationMs', () => {
  it('converts sample counts to milliseconds', () => {
    expect(pcmDurationMs(new Int16Array(16000))).toBe(1000)
    expect(pcmDurationMs(new Int16Array(8000))).toBe(500)
    expect(pcmDurationMs(new Int16Array(0))).toBe(0)
  })
})

describe('concatPcm', () => {
  it('preserves order and total length', () => {
    const a = Int16Array.from([1, 2])
    const b = Int16Array.from([3])
    const joined = concatPcm([a, b, new Int16Array(0)])
    expect(Array.from(joined)).toEqual([1, 2, 3])
  })

  it('returns an empty buffer for no chunks', () => {
    expect(concatPcm([]).length).toBe(0)
  })
})

describe('isSilent', () => {
  it('rejects a silent microphone with DC bias instead of sending it to ASR', () => {
    expect(isSilent(new Int16Array(32000).fill(350))).toBe(true)
  })
  it('rejects a short opening pop without rejecting quiet speech', () => {
    const pop = new Int16Array(32000)
    pop.set(tone(400, 2000))
    expect(isSilent(pop)).toBe(true)
    expect(isSilent(tone(16000, 240))).toBe(false)
  })
  it('flags a zeroed buffer', () => {
    expect(isSilent(new Int16Array(16000))).toBe(true)
  })

  it('accepts a loud tone', () => {
    expect(isSilent(tone(16000))).toBe(false)
  })

  it('treats a single click inside silence as silent', () => {
    const pcm = new Int16Array(16000)
    pcm[100] = 30000
    expect(isSilent(pcm)).toBe(true)
  })

  it('treats quiet room noise as silent', () => {
    const pcm = new Int16Array(16000).fill(60)
    expect(isSilent(pcm)).toBe(true)
  })
})

describe('quiet edge trimming', () => {
  it('removes DC-biased silence without modifying any speech samples', () => {
    const pcm = new Int16Array(16000 * 14).fill(350)
    pcm.set(tone(16000), 16000 * 12)
    const trimmed = trimSilencePcm(pcm)
    expect(trimmed.buffer).toBe(pcm.buffer)
    expect(trimmed.length).toBe(16000 + 1920 + 3840)
    expect(trimmed.subarray(1920, 1920 + 16000)).toEqual(tone(16000))
  })
})

describe('concatPcm (allocation shape)', () => {
  it('joins thousands of worklet chunks in one pass', () => {
    const chunks: Int16Array[] = []
    for (let i = 0; i < 5000; i++) chunks.push(Int16Array.from([i % 1000, -(i % 1000)]))
    const joined = concatPcm(chunks)
    expect(joined.length).toBe(10000)
    expect(joined[0]).toBe(0)
    expect(joined[1]).toBe(0)
    expect(joined[9998]).toBe(999) // 4999 % 1000
    expect(joined[9999]).toBe(-999)
  })
})

/** Builds a WAV whose `fmt ` chunk is 18 bytes (what SAPI/ffmpeg emit). */
function wavWithLongFmt(pcm: Int16Array, extraChunk = false): Uint8Array {
  const fmtSize = 18
  const extra = extraChunk ? 8 + 6 : 0 // LIST header + 5-byte payload + pad byte
  const dataOffset = 12 + 8 + fmtSize + extra
  const buffer = new ArrayBuffer(dataOffset + 8 + pcm.byteLength)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint16(36, 0, true) // cbSize, the extra two bytes of a 18-byte fmt
  let off = 12 + 8 + fmtSize
  if (extraChunk) {
    ascii(off, 'LIST')
    view.setUint32(off + 4, 5, true)
    ascii(off + 8, 'INFOX')
    off += 8 + 6 // 5 payload bytes + 1 pad byte
  }
  ascii(off, 'data')
  view.setUint32(off + 4, pcm.byteLength, true)
  new Int16Array(buffer, off + 8).set(pcm)
  return new Uint8Array(buffer)
}

describe('wavInfo / wavDurationMs', () => {
  it('reads the header encodeWav writes', () => {
    const wav = encodeWav(tone(16000))
    const info = wavInfo(wav)
    expect(info).not.toBeNull()
    expect(info).toMatchObject({
      sampleRate: SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 32000
    })
    expect(wavDurationMs(wav)).toBe(1000)
  })

  it('walks past an 18-byte fmt chunk instead of assuming offset 44', () => {
    const wav = wavWithLongFmt(tone(8000))
    const info = wavInfo(wav)
    expect(info?.dataOffset).toBe(46)
    expect(wavDurationMs(wav)).toBe(500)
  })

  it('skips an extra chunk with an odd payload and its pad byte', () => {
    const wav = wavWithLongFmt(tone(8000), true)
    expect(wavInfo(wav)?.dataOffset).toBe(60)
    expect(wavDurationMs(wav)).toBe(500)
  })

  it('rejects non-RIFF input', () => {
    expect(wavInfo(new Uint8Array(64))).toBeNull()
    expect(wavDurationMs(new Uint8Array(8))).toBe(0)
  })
})

describe('decodeWavPcm16', () => {
  it('round-trips the samples encodeWav wrote', () => {
    const pcm = tone(320)
    const decoded = decodeWavPcm16(encodeWav(pcm))
    expect(decoded?.sampleRate).toBe(SAMPLE_RATE)
    expect(Array.from(decoded?.pcm ?? [])).toEqual(Array.from(pcm))
  })

  it('decodes a SAPI-style header', () => {
    const pcm = tone(160)
    expect(Array.from(decodeWavPcm16(wavWithLongFmt(pcm))?.pcm ?? [])).toEqual(Array.from(pcm))
  })

  it('returns null for non-16-bit or non-RIFF payloads', () => {
    const stereo = encodeWav(tone(160))
    new DataView(stereo.buffer).setUint16(22, 2, true) // channels = 2
    expect(decodeWavPcm16(stereo)).toBeNull()
    expect(decodeWavPcm16(new Uint8Array(32))).toBeNull()
  })
})


describe('trimSilencePcm', () => {
  /** A zero-mean signal; a constant block is microphone DC, not speech. */
  function block(samples: number, amplitude = 9000): Int16Array {
    return tone(samples, amplitude)
  }

  /** 1 s silence + 1 s speech + 1 s silence. */
  function padded(): Int16Array {
    const pcm = new Int16Array(SAMPLE_RATE * 3)
    pcm.set(block(SAMPLE_RATE), SAMPLE_RATE)
    return pcm
  }

  it('keeps speech plus a pad, drops the long silent head and tail', () => {
    const trimmed = trimSilencePcm(padded())
    expect(trimmed.length).toBe(16000 + 1920 + 3840) // speech + 120 ms head + 240 ms tail
    expect(pcmDurationMs(trimmed)).toBe(1360)
    expect(trimmed.subarray(1920, 1920 + 16000)).toEqual(block(16000))
  })

  it('returns a view, so nothing is copied', () => {
    const source = padded()
    const trimmed = trimSilencePcm(source)
    expect(trimmed.buffer).toBe(source.buffer)
    expect(trimmed.byteOffset).toBe(14080 * 2)
    trimmed[0] = 1234
    expect(source[14080]).toBe(1234)
  })

  it('leaves all-silent input untouched', () => {
    const silent = new Int16Array(SAMPLE_RATE)
    expect(trimSilencePcm(silent)).toBe(silent)
  })

  it('skips trims worth less than 200 ms', () => {
    // 50 ms head (under the 120 ms pad) + 1 s speech + 400 ms tail: cutting it
    // would only save 160 ms, which is not worth a second encode.
    const pcm = new Int16Array(800 + 16000 + 6400)
    pcm.set(block(16000), 800)
    expect(trimSilencePcm(pcm)).toBe(pcm)
  })

  it('refuses to cut below the 300 ms floor', () => {
    const pcm = new Int16Array(SAMPLE_RATE)
    pcm.set(block(1280), 16000 - 1280) // 80 ms at the end plus only head padding
    expect(trimSilencePcm(pcm)).toBe(pcm)
    const mid = new Int16Array(SAMPLE_RATE * 2)
    mid.set(block(1280), 16000)
    expect(trimSilencePcm(mid).length).toBe(7040) // 80 ms plus 360 ms padding
  })

  it('honours a custom threshold', () => {
    const pcm = tone(SAMPLE_RATE * 2, 200)
    pcm.set(block(16000), 16000)
    expect(pcmDurationMs(trimSilencePcm(pcm, { threshold: 220 }))).toBe(1120)
    // Lowering the threshold under the noise floor makes the noise look like
    // speech, so nothing is trimmed at all.
    expect(trimSilencePcm(pcm, { threshold: 100 })).toBe(pcm)
  })

  it('keeps interior silence, so pauses are never cut', () => {
    const pcm = new Int16Array(SAMPLE_RATE * 4)
    pcm.set(block(3840), 1920)
    pcm.set(block(3840), 1920 + 3840 + 8000) // 500 ms pause in between
    const trimmed = trimSilencePcm(pcm)
    expect(trimmed.length).toBe(3840 + 8000 + 3840 + 1920 + 3840)
  })

  it('handles an empty buffer', () => {
    const empty = new Int16Array(0)
    expect(trimSilencePcm(empty)).toBe(empty)
  })
})
