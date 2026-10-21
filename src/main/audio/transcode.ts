/**
 * Audio compression for the ASR upload (REQ-11).
 *
 * Speech at 24 kHz mono 16-bit is 48 KB/s, so a one-minute dictation is ~2.8 MB
 * of mostly-redundant PCM. Opus at 24 kbps carries the same speech in ~180 KB.
 * The reference product ships libopus natively; we shell out to a system ffmpeg
 * instead, because bundling a codec for one call is not worth 2 MB of installer
 * and a native build step.
 *
 * Every path is optional: no ffmpeg, a timeout, or a non-zero exit means the
 * caller uploads the original WAV, so the whole feature degrades to "slightly
 * bigger upload" rather than "no transcription".
 */
import { spawn } from 'node:child_process'

/** Below this the process spawn costs more than the bytes saved. */
export const MIN_COMPRESS_BYTES = 16_384
/** Long enough for a 9-minute recording on a slow disk, short enough to not stall. */
const TRANSCODE_TIMEOUT_MS = 8000
const DEFAULT_BITRATE_KBPS = 24

export interface EncodedAudio {
  data: Uint8Array
  contentType: string
  filename: string
}

export type TranscodeOutcome =
  | { ok: true; audio: EncodedAudio; bytesBefore: number }
  | {
      ok: false
      reason: 'too-small' | 'disabled' | 'no-ffmpeg' | 'timeout' | 'failed' | 'empty'
      message?: string
    }

let ffmpegPath: string | null | undefined

/** Resolves once per process: `undefined` means "not probed yet". */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath
  const configured = env.TYPELESS_FFMPEG?.trim()
  ffmpegPath = configured || 'ffmpeg'
  return ffmpegPath
}

/** Test hook: forget the cached probe. */
export function resetFfmpegProbe(): void {
  ffmpegPath = undefined
}

/**
 * Encodes `wav` to Ogg/Opus. Resolves a failure description instead of throwing:
 * the call site decides whether to fall back or surface the problem.
 */
export async function toOggOpus(
  wav: Uint8Array,
  options: { bitrateKbps?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<TranscodeOutcome> {
  const bytesBefore = wav.byteLength
  if (bytesBefore < MIN_COMPRESS_BYTES) return { ok: false, reason: 'too-small' }

  const env = options.env ?? process.env
  if (env.TYPELESS_ASR_UPLOAD === 'wav') return { ok: false, reason: 'disabled' }
  const bin = resolveFfmpeg(env)
  if (!bin) return { ok: false, reason: 'no-ffmpeg' }

  const bitrate = `${options.bitrateKbps ?? DEFAULT_BITRATE_KBPS}k`
  const timeoutMs = options.timeoutMs ?? TRANSCODE_TIMEOUT_MS

  return new Promise<TranscodeOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: TranscodeOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const child = spawn(
      bin,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'wav',
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-b:a', bitrate,
        '-application', 'voip',
        '-vbr', 'on',
        '-f', 'ogg',
        'pipe:1'
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )

    const chunks: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, reason: 'timeout' })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      // Only the tail is worth keeping; ffmpeg can be chatty before it dies.
      stderr = (stderr + chunk.toString('utf8')).slice(-400)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish({ ok: false, reason: err.code === 'ENOENT' ? 'no-ffmpeg' : 'failed', message: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks)
      if (code !== 0) {
        finish({ ok: false, reason: 'failed', message: stderr.trim() || `ffmpeg exited ${code}` })
        return
      }
      if (out.length === 0) {
        finish({ ok: false, reason: 'empty' })
        return
      }
      finish({
        ok: true,
        bytesBefore,
        audio: {
          data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
          contentType: 'audio/ogg',
          filename: 'audio.ogg'
        }
      })
    })

    child.stdin.on('error', () => {
      /* a killed process closes stdin early; the close handler reports it */
    })
    child.stdin.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))
  })
}

/** The unconditional fallback: the original WAV bytes, unchanged. */
export function asWav(wav: Uint8Array): EncodedAudio {
  return { data: wav, contentType: 'audio/wav', filename: 'audio.wav' }
}
