import koffi from 'koffi'
import { screen } from 'electron'
import { foregroundWindow } from './foreground'
import type { GameObservation } from './game-mode'

let bindings: {
  state: (buffer: Buffer) => number
  open: (access: number, inherit: number, pid: number) => unknown
  exitCode: (handle: unknown, code: Buffer) => number
  close: (handle: unknown) => number
  error: () => number
} | null = null

function native(): NonNullable<typeof bindings> {
  if (bindings) return bindings
  const shell = koffi.load('shell32.dll'), kernel = koffi.load('kernel32.dll')
  bindings = {
    state: shell.func('int32_t __stdcall SHQueryUserNotificationState(void *)'),
    open: kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    exitCode: kernel.func('int __stdcall GetExitCodeProcess(void *, void *)'),
    close: kernel.func('int __stdcall CloseHandle(void *)'),
    error: kernel.func('uint32_t __stdcall GetLastError()')
  }
  return bindings
}

export function observeGame(): GameObservation {
  if (process.platform !== 'win32') return { pid: 0, process: '', className: '', fullScreen3d: false }
  const current = foregroundWindow(), state = Buffer.alloc(4)
  const rect = current.rect ? screen.screenToDipRect(null, current.rect) : null
  const display = rect ? screen.getDisplayMatching(rect).bounds : null
  // Notification state is global; also require THIS foreground window to cover its display.
  const fullscreen = Boolean(rect && display && rect.x <= display.x + 2 && rect.y <= display.y + 2 &&
    rect.x + rect.width >= display.x + display.width - 2 && rect.y + rect.height >= display.y + display.height - 2)
  const fullScreen3d = native().state(state) === 0 && state.readUInt32LE() === 3 && fullscreen
  return { pid: current.pid, process: current.appName, className: current.className, fullScreen3d }
}

export function gameProcessAlive(pid: number): boolean {
  const api = native(), handle = api.open(0x1000, 0, pid)
  if (!handle) return api.error() === 5 // Access denied is not proof a protected game exited.
  try { const code = Buffer.alloc(4); return !api.exitCode(handle, code) || code.readUInt32LE() === 259 }
  finally { api.close(handle) }
}
