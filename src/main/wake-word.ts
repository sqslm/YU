import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { Settings } from '@shared/types'
import type { WakeWordStatus } from '@shared/wake-word'
import { normalizeWakeConfidence } from '@shared/wake-word'

/** A capture endpoint the recogniser can be pointed at. `id` is the waveIn index, as text. */
export interface WakeWordDevice {
  id: string
  name: string
}

/** Settings plus the optional device picker, so this file compiles before the shape lands. */
export type WakeWordInput = Settings['wakeWord'] & { deviceId?: string }

/** Pulls the device list out of the script's stdout; exported so it can be tested without spawning. */
export function parseDeviceList(stdout: string): WakeWordDevice[] {
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      const event = JSON.parse(text)
      if (event?.type !== 'devices' || !Array.isArray(event.devices)) continue
      const list: unknown[] = event.devices
      return list
        .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown; name?: unknown }) : null))
        .filter((item): item is { id?: unknown; name?: unknown } => item !== null)
        .map((item) => ({ id: String(item.id ?? ''), name: String(item.name ?? '') }))
        .filter((item) => item.id !== '')
    } catch { continue }
  }
  return []
}

/** Windows offline, whole-phrase text/pronunciation matching. No cloud ASR or saved audio. */
export class WakeWordHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private phrase = ''
  private deviceId = ''
  private confidence = 0.8
  private status: WakeWordStatus = { phase: 'off' }
  /** Set once the script reports it could not open the chosen device. */
  private deviceNotice: '' | 'device-missing' = ''
  private startup: NodeJS.Timeout | null = null
  private lastWake = -Infinity
  /** Why the last `listDevices()` came back empty: 'unavailable' | 'timeout' | '' when it worked. */
  deviceIssue: '' | 'unavailable' | 'timeout' = ''
  constructor(private deps: { wake: () => void; changed: (status: WakeWordStatus) => void }) {}
  snapshot(): WakeWordStatus { return { ...this.status } }
  private get script(): string {
    return app.isPackaged ? join(process.resourcesPath, 'voice-wake.ps1') : join(app.getAppPath(), 'resources/voice-wake.ps1')
  }
  private get shell(): string {
    return join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  }
  /**
   * Capture devices for the settings picker. Never throws: the settings UI has to render
   * even on a machine with no microphone, and an old Windows may have no PowerShell at all.
   */
  listDevices(): Promise<WakeWordDevice[]> {
    if (process.platform !== 'win32') { this.deviceIssue = 'unavailable'; return Promise.resolve([]) }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.shell, ['-NoProfile', '-NonInteractive', '-File', this.script, '-ListDevices'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { this.deviceIssue = 'unavailable'; return Promise.resolve([]) }
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      const finish = (devices: WakeWordDevice[], issue: '' | 'unavailable' | 'timeout' = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.deviceIssue = issue
        resolve(devices)
      }
      // Add-Type compiles the P/Invoke block on first use, which is slow but bounded.
      const timer = setTimeout(() => { child.kill(); finish([], 'timeout') }, 15_000)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (text: string) => { if (output.length < 65_536) output += text })
      child.stderr?.resume()
      child.on('error', () => finish([], 'unavailable'))
      child.on('exit', () => {
        const devices = parseDeviceList(output)
        finish(devices, devices.length > 0 ? '' : 'unavailable')
      })
    })
  }
  private publish(status: WakeWordStatus): void {
    // The notice outlives the phase it was discovered in: "ready" follows the
    // script's fallback log, and dropping the notice there would hide it again.
    const next: WakeWordStatus = this.deviceNotice ? { ...status, deviceNotice: this.deviceNotice } : status
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next; this.deps.changed(this.snapshot())
  }
  stop(): void {
    if (this.startup) clearTimeout(this.startup)
    this.startup = null
    const child = this.child
    this.child = null
    child?.kill()
    this.phrase = ''
    // A new run re-reports the fallback if it still applies; a stale notice from
    // the previous run must not survive into the next phase.
    this.deviceNotice = ''
  }
  update(settings: WakeWordInput, paused: boolean, retry = false): void {
    // The script reports raw confidence: a threshold change needs no microphone restart.
    this.confidence = normalizeWakeConfidence(settings.confidence, settings.phrase)
    if (!settings.enabled || paused) {
      this.stop(); this.publish({ phase: settings.enabled ? 'paused' : 'off' }); return
    }
    const device = settings.deviceId ?? ''
    // A device switch has to restart the recogniser: waveIn cannot re-target an open input.
    if (this.phrase === settings.phrase && this.deviceId === device && (this.child || this.status.phase === 'error') && !retry) return
    this.stop()
    this.phrase = settings.phrase
    this.deviceId = device
    if (process.platform !== 'win32') { this.publish({ phase: 'error', error: 'unavailable' }); return }
    this.publish({ phase: 'starting' })
    const child = spawn(this.shell,
      ['-NoProfile', '-NonInteractive', '-File', this.script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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
          // The configured utterance threshold is the confidence gate. A second
          // fixed word-score floor made the sensitivity control ineffective for names.
          else if (event.type === 'wake' && this.status.phase === 'listening' &&
            event.phrase === this.phrase && event.confidence >= this.confidence &&
            event.durationMs >= 300 && event.durationMs <= 9000 && Date.now() - this.lastWake >= 5000) {
            this.lastWake = Date.now()
            this.stop(); this.publish({ phase: 'paused' }); this.deps.wake(); return
          } else if (event.type === 'error') failed(['language', 'microphone'].includes(event.error) ? event.error : 'unavailable')
          // The script already fell back to the default input, which is the right
          // behaviour but invisible; surfacing it is the whole point of this branch.
          else if (event.type === 'log' && event.reason === 'device-missing' && !this.deviceNotice) {
            this.deviceNotice = 'device-missing'
            this.publish(this.status)
          }
        } catch { failed(); return }
      }
    })
    // Drain stderr without retaining microphone/device details in logs.
    child.stderr.resume()
    child.on('error', () => failed())
    child.on('exit', () => failed())
    child.stdin.on('error', () => failed())
    this.startup = setTimeout(() => failed(), 15_000)
    child.stdin.end(JSON.stringify({ phrase: settings.phrase, language: /[\u3400-\u9fff]/u.test(settings.phrase) ? 'zh' : 'en', device }) + '\n', 'utf8')
  }
}
