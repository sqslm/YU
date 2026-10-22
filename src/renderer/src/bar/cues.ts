/**
 * Interaction cues (REQ-09).
 *
 * Three synthesised tones — start, done, failure — produced with WebAudio so the
 * app ships no audio files and the volume follows the OS mixer. The context is
 * created lazily on the first cue because a bar window may live for hours
 * without ever recording, and an idle AudioContext pins an audio device.
 */

export type CueKind = 'start' | 'done' | 'error' | 'reminder'

interface Tone {
  frequency: number
  /** End frequency for a glide; equal to `frequency` for a flat tone. */
  to: number
  durationMs: number
  gain: number
  type: OscillatorType
}

const TONES: Record<CueKind, Tone[]> = {
  reminder: [
    { frequency: 880, to: 880, durationMs: 180, gain: 0.08, type: 'sine' },
    { frequency: 660, to: 660, durationMs: 180, gain: 0.08, type: 'sine' },
    { frequency: 880, to: 880, durationMs: 180, gain: 0.08, type: 'sine' }
  ],
  // Rising pair: "I am listening".
  start: [
    { frequency: 660, to: 880, durationMs: 70, gain: 0.05, type: 'sine' }
  ],
  // Falling minor third: "saved".
  done: [
    { frequency: 780, to: 620, durationMs: 90, gain: 0.045, type: 'sine' }
  ],
  // Low buzz: "something went wrong".
  error: [
    { frequency: 320, to: 240, durationMs: 160, gain: 0.05, type: 'triangle' }
  ]
}

let context: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  if (context && context.state !== 'closed') return context
  try {
    context = new AudioContext()
    return context
  } catch {
    return null
  }
}

/**
 * Plays the cue for `kind`. Silent when the user turned cues off; every failure
 * path is swallowed, because a missing beep must never break a recording.
 */
export function playCue(kind: CueKind, enabled: boolean): void {
  if (!enabled) return
  const ctx = audioContext()
  if (!ctx) return
  // Autoplay policy parks a fresh context in `suspended`; resume is cheap and
  // idempotent, and the cue still schedules against `currentTime`.
  if (ctx.state === 'suspended') void ctx.resume()

  let at = ctx.currentTime
  for (const tone of TONES[kind]) {
    const start = at
    const end = start + tone.durationMs / 1000
    const oscillator = ctx.createOscillator()
    const envelope = ctx.createGain()
    oscillator.type = tone.type
    oscillator.frequency.setValueAtTime(tone.frequency, start)
    if (tone.to !== tone.frequency) {
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end)
    }
    // Short attack/decay so the tone reads as a tick, not a click.
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(tone.gain, start + 0.008)
    envelope.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(envelope).connect(ctx.destination)
    oscillator.start(start)
    oscillator.stop(end + 0.01)
    at = end
  }
}

/** Releases the audio device; called when the bar window unloads. */
export function disposeCues(): void {
  if (!context) return
  const current = context
  context = null
  void current.close().catch(() => undefined)
}
