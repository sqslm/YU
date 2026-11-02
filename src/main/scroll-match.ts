import { app } from 'electron'
import { join } from 'node:path'
import koffi from 'koffi'

type MatchFunction = (previous: Uint8Array, previousLength: number, next: Uint8Array, nextLength: number, width: number, height: number, result: Uint32Array) => number
let nativeMatch: MatchFunction | undefined

/** Synchronous borrowed buffers: Rust neither mutates nor retains their pointers. */
export function matchScroll(previous: Uint8Array, next: Uint8Array, width: number, height: number): { offset: number; top: number; bottom: number } | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    width * height > 40_000_000 || previous.byteLength !== width * height * 4 || next.byteLength !== previous.byteLength) {
    throw new Error('Invalid scroll capture frame')
  }
  if (!nativeMatch) {
    if (process.platform !== 'win32') throw new Error('Windows only')
    const path = app.isPackaged ? join(process.resourcesPath, 'native/yu-scroll.dll') : join(app.getAppPath(), 'native/bin/yu-scroll.dll')
    nativeMatch = koffi.load(path).func('int yu_scroll_match(const uint8_t *previous, size_t previous_len, const uint8_t *next, size_t next_len, uint32_t width, uint32_t height, _Out_ uint32_t *result)')
  }
  const result = new Uint32Array(3)
  const status = nativeMatch(previous, previous.byteLength, next, next.byteLength, width, height, result)
  if (status < 0) throw new Error('Invalid scroll capture frame')
  return status === 1 ? { offset: result[0], top: result[1], bottom: result[2] } : null
}
