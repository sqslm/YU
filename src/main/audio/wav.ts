import { SAMPLE_RATE } from '@shared/audio'
export { SAMPLE_RATE, encodeWav } from '@shared/audio'

/** Duration of a PCM16 buffer in milliseconds. */
export function pcmDurationMs(pcm: Int16Array, sampleRate = SAMPLE_RATE): number {
  return Math.round((pcm.length / sampleRate) * 1000)
}

/**
 * Concatenates PCM chunks coming from the renderer.
 *
 * One `Int16Array` is allocated for the whole take and every chunk is copied
 * once with `set()`: the cost is O(total samples), never O(chunks × samples).
 * The renderer emits ~16 chunks/second, so a 60 s take is ~960 chunks; a
 * `new Int16Array(old.length + chunk.length)` per chunk (the naive version)
 * would memcpy ~1.8 GB for that take.
 */
export function concatPcm(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** DC-independent energy in 20 ms frames. At least 80 ms avoids opening pops.
 * This is a quiet-input gate, not a speech/language classifier. */
export function audibleRange(pcm: Int16Array, threshold = 150): { start: number; end: number } | null {
  let start = -1, end = 0, audible = 0
  for (let at = 0; at < pcm.length; at += 320) {
    const until = Math.min(at + 320, pcm.length), count = until - at
    let sum = 0, squares = 0
    for (let i = at; i < until; i++) { sum += pcm[i]; squares += pcm[i] * pcm[i] }
    if (squares / count - (sum / count) ** 2 < threshold * threshold) continue
    if (start < 0) start = at
    end = until
    audible += count
  }
  return audible >= 1280 ? { start, end } : null
}

/** True when the buffer contains no sustained audible input. */
export function isSilent(pcm: Int16Array): boolean {
  return audibleRange(pcm) === null
}

/** Tuning for {@link trimSilencePcm}; defaults match {@link isSilent}'s threshold. */
export interface TrimOptions {
  /** Minimum DC-independent frame RMS (default 150). */
  threshold?: number
  /** Silence kept before the first loud sample, so onsets are not clipped. */
  headPadMs?: number
  /** Silence kept after the last loud sample, so trailing consonants survive. */
  tailPadMs?: number
  /** Never produce a shorter buffer than this; shorter trims are not worth it. */
  minKeepMs?: number
  /** A trim that saves less than this is skipped (returns the input as-is). */
  minSavedMs?: number
}

const TRIM_DEFAULTS: Required<TrimOptions> = {
  threshold: 150,
  headPadMs: 120,
  tailPadMs: 240,
  minKeepMs: 300,
  minSavedMs: 200
}

/**
 * Drops leading/trailing silence from a take, keeping a small pad on both ends.
 *
 * The returned array is a **view** on the input (`subarray`), so nothing is
 * copied; callers that keep it must not mutate the source. Uses the same
 * audible frames as {@link isSilent}, with padding to preserve consonants.
 * Interior silence is never touched.
 */
export function trimSilencePcm(pcm: Int16Array, opts: TrimOptions = {}): Int16Array {
  const { threshold, headPadMs, tailPadMs, minKeepMs, minSavedMs } = { ...TRIM_DEFAULTS, ...opts }
  if (pcm.length === 0) return pcm

  const range = audibleRange(pcm, threshold)
  // All-silent input: leave it alone. The caller's isSilent() gate owns that case.
  if (!range) return pcm

  const headPad = Math.round((headPadMs * SAMPLE_RATE) / 1000)
  const tailPad = Math.round((tailPadMs * SAMPLE_RATE) / 1000)
  const start = Math.max(0, range.start - headPad)
  const end = Math.min(pcm.length, range.end + tailPad)
  const kept = end - start
  const saved = pcm.length - kept
  if (kept < Math.round((minKeepMs * SAMPLE_RATE) / 1000)) return pcm
  if (saved < Math.round((minSavedMs * SAMPLE_RATE) / 1000)) return pcm
  return pcm.subarray(start, end)
}

/** The RIFF fields this project cares about. */
export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Offset of the first PCM byte. */
  dataOffset: number
  dataBytes: number
}

/**
 * Walks RIFF chunks (SAPI and ffmpeg write `fmt ` chunks longer than 16 bytes,
 * so a hard-coded offset 44 is wrong) and reports the PCM payload location.
 * Returns null for anything that is not a PCM16 RIFF/WAVE file.
 */
export function wavInfo(wav: Uint8Array): WavInfo | null {
  if (wav.byteLength < 12) return null
  if (String.fromCharCode(...wav.subarray(0, 4)) !== 'RIFF') return null
  if (String.fromCharCode(...wav.subarray(8, 12)) !== 'WAVE') return null

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let fmtSeen = false
  let off = 12
  while (off + 8 <= wav.byteLength) {
    const id = String.fromCharCode(...wav.subarray(off, off + 4))
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      if (body + 16 > wav.byteLength) return null
      const audioFormat = view.getUint16(body, true)
      if (audioFormat !== 1) return null // not PCM
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      fmtSeen = true
    } else if (id === 'data') {
      if (!fmtSeen) return null
      const dataBytes = Math.min(size, wav.byteLength - body)
      return { sampleRate, channels, bitsPerSample, dataOffset: body, dataBytes }
    }
    off = body + size + (size % 2)
  }
  return null
}

/** Duration of an encoded WAV in ms; 0 when the header is not PCM16. */
export function wavDurationMs(wav: Uint8Array): number {
  const info = wavInfo(wav)
  if (!info || info.sampleRate === 0) return 0
  const totalSamples = info.dataBytes / (info.channels * (info.bitsPerSample / 8))
  return Math.round((totalSamples / info.sampleRate) * 1000)
}

/** Decodes the PCM16 payload of a mono WAV so it can be trimmed and re-encoded. */
export function decodeWavPcm16(wav: Uint8Array): { pcm: Int16Array; sampleRate: number } | null {
  const info = wavInfo(wav)
  if (!info || info.channels !== 1 || info.bitsPerSample !== 16) return null
  const samples = info.dataBytes >> 1
  const pcm = new Int16Array(samples)
  // DataView keeps this correct even when `dataOffset` is odd (no aliasing).
  const view = new DataView(wav.buffer, wav.byteOffset + info.dataOffset, samples * 2)
  for (let i = 0; i < samples; i++) pcm[i] = view.getInt16(i * 2, true)
  return { pcm, sampleRate: info.sampleRate }
}
