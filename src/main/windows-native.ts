import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'

/** Only a fixed, shipped script is executed; request fields never enter command text. */
export function windowsNative(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows only'))
  const script = app.isPackaged ? join(process.resourcesPath, 'windows-tools.ps1') : join(app.getAppPath(), 'resources/windows-tools.ps1')
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = '', settled = false
    const finish = (failure?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (failure) { child.kill(); reject(failure); return }
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, '')) as Record<string, unknown>) } catch { reject(new Error('Invalid Windows bridge response')) }
    }
    const cancel = (): void => finish(new Error('Cancelled'))
    const timer = setTimeout(() => finish(new Error('Windows operation timed out')), 15_000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text: string) => { output += text; if (output.length > 2_000_000) finish(new Error('Windows response too large')) })
    child.stderr.on('data', (text: string) => { error = (error + text).slice(0, 2000) })
    child.on('error', finish)
    child.stdin.on('error', finish)
    child.on('close', code => finish(code === 0 ? undefined : new Error(error || 'Windows operation failed')))
    child.stdin.end(JSON.stringify(request), 'utf8')
  })
}
