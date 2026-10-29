import type { MemoryBackend } from '@shared/memory'
let service: MemoryBackend | null = null
export function setMemoryService(value: MemoryBackend | null): void { service = value }
export function memoryService(): MemoryBackend | null { return service }
