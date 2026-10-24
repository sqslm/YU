import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/types'
import type { WakeWordStatus } from '@shared/wake-word'

/** Windows offline, exact-phrase grammar. No ASR provider, recording or polling while waiting. */
export class WakeWordHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private phrase = ''
  private status: WakeWordStatus = { phase: 'off' }
  private startup: NodeJS.Timeout | null = null
  private lastWake = -Infinity
  constructor(private deps: { wake: () => void; changed: (status: WakeWordStatus) => void }) {}
  snapshot(): WakeWordStatus { return { ...this.status } }
  private publish(status: WakeWordStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return
    this.status = status; this.deps.changed(this.snapshot())
  }
  stop(): void {
    if (this.startup) clearTimeout(this.startup)
    this.startup = null
    const child = this.child
    this.child = null
    child?.kill()
    this.phrase = ''
  }
  update(settings: Settings['wakeWord'], paused: boolean, retry = false): void {
    if (!settings.enabled || paused) {
      this.stop(); this.publish({ phase: settings.enabled ? 'paused' : 'off' }); return
    }
    if (this.phrase === settings.phrase && (this.child || this.status.phase === 'error') && !retry) return
    this.stop()
    this.phrase = settings.phrase
    const letters = this.phrase.replace(/[^\p{L}\p{N}]/gu, '')
    const shortPhrase = /[\u3400-\u9fff]/u.test(letters) ? letters.length < 4 : this.phrase.trim().split(/\s+/).length < 2
    if (process.platform !== 'win32') { this.publish({ phase: 'error', error: 'unavailable' }); return }
    this.publish({ phase: 'starting' })
    const script = app.isPackaged ? join(process.resourcesPath, 'voice-wake.ps1') : join(app.getAppPath(), 'resources/voice-wake.ps1')
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    let buffer = ''
    const failed = (error: WakeWordStatus['error'] = 'unavailable'): void => {
      if (this.child !== child) return
      if (this.startup) clearTimeout(this.startup)
      this.startup = null
      this.child = null; child.kill(); this.publish({ phase: 'error', error })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      if (this.child !== child) return
      buffer += text
      if (buffer.length > 8192) { failed(); return }
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(end + 1)
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') {
            if (this.startup) clearTimeout(this.startup)
            this.startup = null
            this.publish({ phase: 'listening' })
          }
          else if (event.type === 'wake' && this.status.phase === 'listening' &&
            event.phrase === this.phrase && event.confidence >= (shortPhrase ? 0.94 : 0.80) &&
            event.wordConfidence >= (shortPhrase ? 0.75 : 0.50) && event.durationMs >= 300 && event.durationMs <= 9000 && Date.now() - this.lastWake >= 5000) {
            this.lastWake = Date.now()
            this.stop(); this.publish({ phase: 'paused' }); this.deps.wake(); return
          } else if (event.type === 'error') failed(['language', 'microphone'].includes(event.error) ? event.error : 'unavailable')
        } catch { failed(); return }
      }
    })
    // Drain stderr without retaining microphone/device details in logs.
    child.stderr.resume()
    child.on('error', () => failed())
    child.on('exit', () => failed())
    child.stdin.on('error', () => failed())
    this.startup = setTimeout(() => failed(), 15_000)
    child.stdin.end(JSON.stringify({ phrase: settings.phrase, language: /[\u3400-\u9fff]/u.test(settings.phrase) ? 'zh' : 'en' }) + '\n', 'utf8')
  }
}
