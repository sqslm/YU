import koffi from 'koffi'
import { nativeImage, type NativeImage, type Rectangle } from 'electron'

/** Capture one physical monitor directly; avoid starting Chromium's video capture stack. */
export function captureScreen(rect: Rectangle): NativeImage {
  const { x, y, width, height } = rect
  if (process.platform !== 'win32' || width < 1 || height < 1 || width * height > 40_000_000) throw new Error('Unsupported screen capture')
  const user = koffi.load('user32.dll'), gdi = koffi.load('gdi32.dll')
  const getDC = user.func('void *GetDC(void *window)'), releaseDC = user.func('int ReleaseDC(void *window, void *dc)')
  const createDC = gdi.func('void *CreateCompatibleDC(void *dc)'), deleteDC = gdi.func('int DeleteDC(void *dc)')
  const createBitmap = gdi.func('void *CreateCompatibleBitmap(void *dc, int width, int height)')
  const select = gdi.func('void *SelectObject(void *dc, void *object)'), remove = gdi.func('int DeleteObject(void *object)')
  const blit = gdi.func('int BitBlt(void *target, int x, int y, int width, int height, void *source, int sx, int sy, uint32_t operation)')
  const getBits = gdi.func('int GetDIBits(void *dc, void *bitmap, uint32_t start, uint32_t lines, void *bits, void *info, uint32_t usage)')
  let dc: unknown = null, memory: unknown = null, bitmap: unknown = null, previous: unknown = null
  try {
    dc = getDC(null)
    if (!dc) throw new Error('GetDC failed')
    memory = createDC(dc); bitmap = createBitmap(dc, width, height)
    if (!memory || !bitmap) throw new Error('Screen bitmap allocation failed')
    previous = select(memory, bitmap)
    if (!previous) throw new Error('Screen bitmap selection failed')
    if (!blit(memory, 0, 0, width, height, dc, x, y, 0x40cc0020)) throw new Error('BitBlt failed')
    select(memory, previous); previous = null
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0); header.writeInt32LE(width, 4); header.writeInt32LE(-height, 8)
    header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14)
    const pixels = Buffer.allocUnsafe(width * height * 4)
    if (getBits(dc, bitmap, 0, height, pixels, header, 0) !== height) throw new Error('GetDIBits failed')
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    return nativeImage.createFromBitmap(pixels, { width, height })
  } finally {
    if (previous && memory) select(memory, previous)
    if (bitmap) remove(bitmap)
    if (memory) deleteDC(memory)
    if (dc) releaseDC(null, dc)
  }
}
