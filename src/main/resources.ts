import koffi from 'koffi'
import type { ResourceUsage } from '@shared/types'

interface ProcessMemory {
  privateResidentBytes: number
  workingSetBytes: number
  committedBytes: number
}

let bindings: {
  open: (access: number, inherit: number, pid: number) => unknown
  read: (handle: unknown, buffer: Buffer, size: number) => number
  close: (handle: unknown) => number
} | null = null

/** EX2 reports private resident RAM; Electron's privateBytes reports commit. */
function windowsMemory(pid: number): ProcessMemory | null {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null
  try {
    if (!bindings) {
      const kernel = koffi.load('kernel32.dll')
      bindings = {
        open: kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
        read: kernel.func('int __stdcall K32GetProcessMemoryInfo(void *, void *, uint32_t)'),
        close: kernel.func('int __stdcall CloseHandle(void *)')
      }
    }
    const handle = bindings.open(0x410, 0, pid)
    if (!handle) return null
    try {
      // PROCESS_MEMORY_COUNTERS_EX2 on Windows x64 (psapi.h).
      const buffer = Buffer.alloc(96)
      buffer.writeUInt32LE(buffer.length)
      if (!bindings.read(handle, buffer, buffer.length)) return null
      return {
        privateResidentBytes: Number(buffer.readBigUInt64LE(80)),
        workingSetBytes: Number(buffer.readBigUInt64LE(16)),
        committedBytes: Number(buffer.readBigUInt64LE(72))
      }
    } finally {
      bindings.close(handle)
    }
  } catch {
    // Older Windows versions lack EX2. Report its metric as unavailable.
    return null
  }
}

function roleOf(metric: Electron.ProcessMetric): string {
  const name = metric.name ?? metric.serviceName ?? ''
  if (name.includes('typeless-hotkey')) return 'hotkeys'
  if (name.includes('typeless-local-asr')) return 'localModel'
  if (name.includes('typeless-uia')) return 'context'
  if (metric.type === 'Browser') return 'main'
  if (metric.type === 'GPU') return 'graphics'
  if (metric.type === 'Tab') return 'interface'
  if (/Network|network/.test(name)) return 'network'
  if (/Audio|Video|audio|video/.test(name)) return 'media'
  return 'other'
}

/** Include every app process, and never count an unavailable reading as zero. */
export function collectResources(
  metrics: Electron.ProcessMetric[],
  localModel: ResourceUsage['localModel'],
  readMemory: (pid: number) => ProcessMemory | null = windowsMemory
): ResourceUsage {
  const processes = metrics.map((metric) => {
    const memory = readMemory(metric.pid)
    return {
      pid: metric.pid,
      role: roleOf(metric),
      privateResidentBytes: memory?.privateResidentBytes ?? null,
      workingSetBytes: memory?.workingSetBytes ?? metric.memory.workingSetSize * 1024,
      committedBytes: memory?.committedBytes ?? (metric.memory.privateBytes === undefined ? null : metric.memory.privateBytes * 1024)
    }
  })
  return {
    measuredAt: Date.now(),
    privateResidentBytes: processes.every((p) => p.privateResidentBytes !== null)
      ? processes.reduce((sum, p) => sum + p.privateResidentBytes!, 0) : null,
    workingSetBytes: processes.reduce((sum, p) => sum + p.workingSetBytes, 0),
    committedBytes: processes.every((p) => p.committedBytes !== null)
      ? processes.reduce((sum, p) => sum + p.committedBytes!, 0) : null,
    processes,
    localModel
  }
}
