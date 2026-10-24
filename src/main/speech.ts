/**
 * Read-aloud service for the main process.
 *
 * Two ideas shape this file:
 *
 * 1. The utterance must never travel on a command line. PowerShell arguments
 *    show up in every process listing and the shell would interpret quotes and
 *    `$` sigils, so the text goes to a fixed, shipped script through stdin.
 * 2. Nothing here throws from the plumbing. The bridge reports failures as
 *    values, `voices()` answers with an empty list, and only `speak()` — the one
 *    place a person asked for sound — surfaces an error.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mt } from '@shared/mainI18n'
import { normalizeTtsSettings, speechText, type TtsSettings } from '@shared/speech'

export interface SpeechRequest {
  action: 'speak' | 'stop' | 'voices'
  text?: string
  rate?: number
  volume?: number
  voice?: string
}

export interface SpeechResult {
  ok: boolean
  error?: string
  voices?: string[]
}

export type SpeechRunner = (request: SpeechRequest, signal?: AbortSignal) => Promise<SpeechResult>

/** A synthesizer has no reason to print megabytes; the cap bounds memory. */
const OUTPUT_LIMIT = 2_000_000
/** Speaking a long paragraph takes a while, but a hung bridge must not. */
const TIMEOUT_MS = 20_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function detail(text: string, fallback: string): string {
  return (text.trim() || fallback).slice(0, 200)
}

/**
 * Bridge to `resources/speech.ps1`.
 *
 * Accepts the script path instead of resolving it here so the caller keeps the
 * packaged/unpackaged decision (`windows-native.ts`) and this stays testable.
 */
export function createWindowsSpeechRunner(scriptPath: string): SpeechRunner {
  return function runWindowsSpeech(request, signal) {
    return new Promise<SpeechResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, error: messageOf(error) })
        return
      }

      let output = ''
      let errorText = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      function finish(result: SpeechResult): void {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        resolve(result)
      }
      function kill(result: SpeechResult): void {
        if (!settled) {
          try { child.kill() } catch { /* the process already exited */ }
        }
        finish(result)
      }
      function cancel(): void {
        kill({ ok: false, error: 'cancelled' })
      }

      timer = setTimeout(() => kill({ ok: false, error: 'timeout' }), TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        output += chunk
        if (output.length > OUTPUT_LIMIT) kill({ ok: false, error: 'output too large' })
      })
      child.stderr?.on('data', (chunk: string) => {
        errorText = (errorText + chunk).slice(0, 2000)
      })
      // A missing powershell.exe arrives here; it must read as a failed read-out,
      // not as an unhandled rejection in the middle of a dictation.
      child.on('error', (error) => finish({ ok: false, error: messageOf(error) }))
      child.stdin?.on('error', (error) => finish({ ok: false, error: messageOf(error) }))
      child.on('close', () => {
        const raw = output.replace(/^\uFEFF/, '').trim()
        if (!raw) {
          finish({ ok: false, error: detail(errorText, 'no response') })
          return
        }
        try {
          const parsed = JSON.parse(raw) as { ok?: unknown; error?: unknown; voices?: unknown }
          finish({
            ok: parsed.ok === true,
            error: typeof parsed.error === 'string' ? parsed.error : undefined,
            voices: Array.isArray(parsed.voices)
              ? parsed.voices.filter((name): name is string => typeof name === 'string')
              : undefined
          })
        } catch {
          // Not JSON at all: the script never ran (execution policy, syntax
          // error). stderr is the only useful thing left to report.
          finish({ ok: false, error: detail(errorText || raw, 'invalid response') })
        }
      })

      if (signal?.aborted) {
        cancel()
        return
      }
      signal?.addEventListener('abort', cancel, { once: true })
      // JSON on stdin, UTF-8: this is the only channel that carries the text.
      child.stdin?.end(JSON.stringify(request), 'utf8')
    })
  }
}

export interface SpeechDeps {
  settings: () => { tts: TtsSettings } | { tts?: TtsSettings }
  run: SpeechRunner
  log: (line: string) => void
  /** Injected clock so failure log lines stay assertable. */
  now?: () => number
}

export class SpeechService {
  private readonly deps: SpeechDeps
  /** The live bridge call, if a read-out is in progress. */
  private active: AbortController | null = null

  /** Placeholder: read-aloud is never translated, the synthesizer speaks as-is. */
  translate?: never

  constructor(deps: SpeechDeps) {
    this.deps = deps
  }

  speaking(): boolean {
    return this.active !== null
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /**
   * Reads `text` out loud, interrupting whatever was being read.
   *
   * `skipped` means "nothing was spoken and nothing is wrong": reading is
   * switched off, or the message cleaned down to nothing. The tool layer
   * reports that honestly instead of letting the model claim it read the answer.
   */
  async speak(text: unknown, signal?: AbortSignal): Promise<{ spoken: number; skipped: boolean }> {
    const tts = normalizeTtsSettings(this.deps.settings().tts)
    if (!tts.enabled) return { spoken: 0, skipped: true }
    const spoken = speechText(text)
    if (!spoken) return { spoken: 0, skipped: true }
    if (signal?.aborted) return { spoken: 0, skipped: true }

    // A new instruction interrupts the old one, the way a system voice
    // assistant behaves: two overlapping voices are unintelligible.
    this.stop()
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    signal?.addEventListener('abort', relay, { once: true })
    this.active = controller
    const started = this.now()

    try {
      const result = await this.deps.run({
        action: 'speak',
        text: spoken,
        rate: tts.rate,
        volume: tts.volume,
        ...(tts.voice ? { voice: tts.voice } : {})
      }, controller.signal)
      if (!result.ok) throw new Error(result.error || 'unknown')
      return { spoken: spoken.length, skipped: false }
    } catch (error) {
      const message = messageOf(error)
      // A read-out that the user (or the next utterance) stopped is not a
      // failure to report back to the model.
      if (controller.signal.aborted) {
        this.deps.log(`speech: interrupted after ${this.now() - started}ms`)
        return { spoken: 0, skipped: true }
      }
      this.deps.log(`speech: failed after ${this.now() - started}ms: ${message}`)
      throw new Error(mt('朗读失败：{{message}}', { message }))
    } finally {
      signal?.removeEventListener('abort', relay)
      if (this.active === controller) this.active = null
    }
  }

  /**
   * Stops the current read-out. Idempotent and never throws: it is also the
   * "shut up" path of a hotkey, where an exception would be the worst outcome.
   */
  stop(): void {
    const controller = this.active
    if (!controller) return
    this.active = null
    try {
      controller.abort()
    } catch (error) {
      this.deps.log(`speech: stop failed: ${messageOf(error)}`)
    }
  }

  /**
   * Installed voices for the settings dropdown.
   *
   * An empty list is a valid answer (no synthesizer installed), and a settings
   * page that cannot list voices must still render.
   */
  async voices(): Promise<string[]> {
    try {
      const result = await this.deps.run({ action: 'voices' })
      if (!result?.ok) {
        this.deps.log(`speech: voice list failed: ${result?.error ?? 'unknown'}`)
        return []
      }
      const names = Array.isArray(result.voices) ? result.voices : []
      return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))]
    } catch (error) {
      // The settings page renders an empty picker instead of a broken one.
      this.deps.log(`speech: voice list failed: ${messageOf(error)}`)
      return []
    }
  }
}
