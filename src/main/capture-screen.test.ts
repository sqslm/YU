import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ load: vi.fn(), createFromBitmap: vi.fn() }))

vi.mock('koffi', () => ({ default: { load: mocks.load } }))
vi.mock('electron', () => ({ nativeImage: { createFromBitmap: mocks.createFromBitmap } }))

// A stand-in GDI: handles are small integers, BitBlt succeeds, GetDIBits paints
// every byte 0x11 so the alpha pass in captureScreenPixels is observable.
const state: { bitblt: boolean; rows?: number } = { bitblt: true }
const fake = (signature: string) =>
  (...args: any[]): unknown => {
    if (signature.startsWith('void *GetDC')) return 1
    if (signature.startsWith('int ReleaseDC')) return 1
    if (signature.startsWith('void *CreateCompatibleDC')) return 2
    if (signature.startsWith('int DeleteDC')) return 1
    if (signature.startsWith('void *CreateCompatibleBitmap')) return 3
    if (signature.startsWith('void *SelectObject')) return args[1] === 3 ? 9 : 3
    if (signature.startsWith('int DeleteObject')) return 1
    if (signature.startsWith('int BitBlt')) return state.bitblt
    if (signature.startsWith('int GetDIBits')) {
      const bits = args[4] as Buffer
      bits.fill(0x11)
      return state.rows ?? args[3]
    }
    throw new Error(`unexpected signature ${signature}`)
  }

beforeEach(() => {
  vi.resetModules()
  mocks.load.mockReset().mockImplementation(() => ({ func: fake }))
  mocks.createFromBitmap.mockReset().mockReturnValue({ width: 0, height: 0 })
  state.bitblt = true
  state.rows = undefined
})

describe('captureScreenPixels', () => {
  it('rejects impossible and overflowed rectangles before resolving any binding', async () => {
    const { captureScreenPixels } = await import('./capture-screen')
    const bad = [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY },
      { x: 0, y: 0, width: 10.5, height: 10 },
      { x: 0, y: 0, width: 10_000, height: 4_001 },
      { x: 0, y: 0, width: 100_000, height: 100_000 },
    ]
    for (const rect of bad) expect(() => captureScreenPixels(rect)).toThrow('Unsupported screen capture')
    expect(mocks.load).not.toHaveBeenCalled()

    const pixels = captureScreenPixels({ x: -1920, y: 0, width: 4, height: 3 })
    expect(pixels.length).toBe(48)
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('returns top-down pixels with an opaque alpha channel', async () => {
    const { captureScreenPixels } = await import('./capture-screen')
    const pixels = captureScreenPixels({ x: -10, y: 5, width: 4, height: 3 })
    expect(pixels.length).toBe(4 * 3 * 4)
    expect([...pixels.subarray(0, 4)]).toEqual([0x11, 0x11, 0x11, 255])
    expect([...pixels.subarray(pixels.length - 4)]).toEqual([0x11, 0x11, 0x11, 255])
  })

  it('reports a failed blit, a failed read and keeps serving the next call', async () => {
    const { captureScreenPixels } = await import('./capture-screen')
    state.bitblt = false
    expect(() => captureScreenPixels({ x: 0, y: 0, width: 4, height: 3 })).toThrow('BitBlt failed')
    state.bitblt = true
    state.rows = 2
    expect(() => captureScreenPixels({ x: 0, y: 0, width: 4, height: 3 })).toThrow('GetDIBits failed')
    state.rows = undefined
    expect(captureScreenPixels({ x: 0, y: 0, width: 4, height: 3 }).length).toBe(48)
  })
})

describe('captureScreen', () => {
  it('wraps the raw buffer into a NativeImage without touching the pixels again', async () => {
    const { captureScreen } = await import('./capture-screen')
    const image = captureScreen({ x: 100, y: 200, width: 4, height: 3 })
    expect(mocks.createFromBitmap).toHaveBeenCalledTimes(1)
    const [pixels, size] = mocks.createFromBitmap.mock.calls[0]
    expect(size).toEqual({ width: 4, height: 3 })
    expect(pixels.length).toBe(48)
    expect(pixels[3]).toBe(255)
    expect(image).toBe(mocks.createFromBitmap.mock.results[0].value)
  })
})
