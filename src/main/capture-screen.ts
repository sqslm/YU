import koffi from 'koffi'
import { nativeImage, type NativeImage, type Rectangle } from 'electron'

const MAX_PIXELS = 40_000_000

interface CaptureApi {
  getDC(window: unknown): unknown
  releaseDC(window: unknown, dc: unknown): number
  createDC(dc: unknown): unknown
  deleteDC(dc: unknown): number
  createBitmap(dc: unknown, width: number, height: number): unknown
  select(dc: unknown, object: unknown): unknown
  remove(object: unknown): number
  blit(target: unknown, x: number, y: number, width: number, height: number, source: unknown, sx: number, sy: number, operation: number): number
  getBits(dc: unknown, bitmap: unknown, start: number, lines: number, bits: Buffer, info: Buffer, usage: number): number
}

// Resolving ten exports on every capture cost more than the GDI call itself, so
// bind once on first use. Nothing touches the desktop at import time.
let api: CaptureApi | null = null

function captureApi(): CaptureApi {
  if (api) return api
  const user = koffi.load('user32.dll'), gdi = koffi.load('gdi32.dll')
  api = {
    getDC: user.func('void *GetDC(void *window)'),
    releaseDC: user.func('int ReleaseDC(void *window, void *dc)'),
    createDC: gdi.func('void *CreateCompatibleDC(void *dc)'),
    deleteDC: gdi.func('int DeleteDC(void *dc)'),
    createBitmap: gdi.func('void *CreateCompatibleBitmap(void *dc, int width, int height)'),
    select: gdi.func('void *SelectObject(void *dc, void *object)'),
    remove: gdi.func('int DeleteObject(void *object)'),
    blit: gdi.func('int BitBlt(void *target, int x, int y, int width, int height, void *source, int sx, int sy, uint32_t operation)'),
    getBits: gdi.func('int GetDIBits(void *dc, void *bitmap, uint32_t start, uint32_t lines, void *bits, void *info, uint32_t usage)'),
  }
  return api
}

/**
 * Capture one physical monitor into a top-down BGRA buffer. Chromium's video
 * capture stack stays untouched, so this works while the display is parked on a
 * different foreground window.
 */
export function captureScreenPixels(rect: Rectangle): Buffer {
  const { x, y, width, height } = rect
  if (process.platform !== 'win32' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new Error('Unsupported screen capture')
  }
  const { getDC, releaseDC, createDC, deleteDC, createBitmap, select, remove, blit, getBits } = captureApi()
  let dc: unknown = null, memory: unknown = null, bitmap: unknown = null, previous: unknown = null
  try {
    dc = getDC(null)
    if (!dc) throw new Error('GetDC failed')
    memory = createDC(dc); bitmap = createBitmap(dc, width, height)
    if (!memory || !bitmap) throw new Error('Screen bitmap allocation failed')
    previous = select(memory, bitmap)
    if (!previous) throw new Error('Screen bitmap selection failed')
    if (!blit(memory, 0, 0, width, height, dc, x, y, 0x40cc0020)) throw new Error('BitBlt failed')
    // GetDIBits refuses a bitmap that is still selected into the memory DC.
    select(memory, previous); previous = null
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0); header.writeInt32LE(width, 4); header.writeInt32LE(-height, 8)
    header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14)
    const pixels = Buffer.allocUnsafe(width * height * 4)
    if (getBits(dc, bitmap, 0, height, pixels, header, 0) !== height) throw new Error('GetDIBits failed')
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    return pixels
  } finally {
    if (previous && memory) select(memory, previous)
    if (bitmap) remove(bitmap)
    if (memory) deleteDC(memory)
    if (dc) releaseDC(null, dc)
  }
}

/** Capture one physical monitor as a NativeImage for callers that want one. */
export function captureScreen(rect: Rectangle): NativeImage {
  return nativeImage.createFromBitmap(captureScreenPixels(rect), { width: rect.width, height: rect.height })
}
