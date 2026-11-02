import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, load: vi.fn(), match: vi.fn() }))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('koffi', () => ({ default: { load: mocks.load } }))
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.app.isPackaged = false
  mocks.load.mockImplementation(() => ({ func: () => mocks.match }))
  mocks.match.mockImplementation((_a, _alen, _b, _blen, _w, _h, result: Uint32Array) => { result.set([2, 1, 1]); return 1 })
})
afterEach(() => vi.unstubAllGlobals())

it('borrows the original frame buffers and loads the development library once', async () => {
  const { matchScroll } = await import('./scroll-match')
  const a = Buffer.alloc(8 * 10 * 4), b = Buffer.alloc(a.length)
  expect(matchScroll(a, b, 8, 10)).toEqual({ offset: 2, top: 1, bottom: 1 })
  expect(mocks.load).toHaveBeenCalledWith(join(process.cwd(), 'native/bin/yu-scroll.dll'))
  expect(mocks.match.mock.calls[0].slice(0, 6)).toEqual([a, a.length, b, b.length, 8, 10])
  expect(mocks.match.mock.calls[0][0]).toBe(a); expect(mocks.match.mock.calls[0][2]).toBe(b)
  matchScroll(a, b, 8, 10); expect(mocks.load).toHaveBeenCalledTimes(1)
})

it('loads the packaged library outside ASAR and surfaces a missing DLL', async () => {
  vi.stubGlobal('process', { ...process, resourcesPath: join(process.cwd(), 'packaged-resources') })
  mocks.app.isPackaged = true
  mocks.load.mockImplementation(() => { throw new Error('DLL missing') })
  const { matchScroll } = await import('./scroll-match')
  expect(() => matchScroll(Buffer.alloc(4), Buffer.alloc(4), 1, 1)).toThrow('DLL missing')
  expect(mocks.load).toHaveBeenCalledWith(join(process.resourcesPath, 'native/yu-scroll.dll'))
})

it('rejects invalid dimensions and frame sizes before entering native code', async () => {
  const { matchScroll } = await import('./scroll-match')
  for (const [width, height] of [[0, 1], [-1, 1], [1.5, 1], [1, NaN], [1, Infinity], [40_000_001, 1], [2, 1]]) {
    expect(() => matchScroll(Buffer.alloc(4), Buffer.alloc(4), width, height)).toThrow('Invalid scroll capture frame')
  }
  expect(() => matchScroll(Buffer.alloc(4), Buffer.alloc(8), 1, 1)).toThrow('Invalid scroll capture frame')
  expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.match).not.toHaveBeenCalled()
})

it('preserves unmatched results and surfaces native validation errors', async () => {
  const { matchScroll } = await import('./scroll-match')
  mocks.match.mockReturnValueOnce(0).mockReturnValueOnce(-1)
  expect(matchScroll(Buffer.alloc(4), Buffer.alloc(4), 1, 1)).toBeNull()
  expect(() => matchScroll(Buffer.alloc(4), Buffer.alloc(4), 1, 1)).toThrow('Invalid scroll capture frame')
})
