import { cpus, freemem, totalmem } from 'node:os'

export function memoryIdleEnough(idleSeconds: number, freeBytes: number, totalBytes: number, cpuRatio: number): boolean {
  return idleSeconds >= 60 && freeBytes >= Math.max(1024 ** 3, totalBytes * 0.1) && cpuRatio <= 0.25
}

export function memoryIdleCheck(idleSeconds: () => number): () => boolean {
  const sample = (): { idle: number; total: number } => cpus().reduce((sum, cpu) => ({
    idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0)
  }), { idle: 0, total: 0 })
  let previous = sample()
  return () => {
    const current = sample(), elapsed = current.total - previous.total
    const ratio = elapsed > 0 ? 1 - (current.idle - previous.idle) / elapsed : 1
    previous = current
    return memoryIdleEnough(idleSeconds(), freemem(), totalmem(), ratio)
  }
}
