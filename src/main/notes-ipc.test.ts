import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mock = vi.hoisted(() => ({ serve: null as null | ((request: Request) => Promise<Response>), handlers: new Map<string, (...args: any[]) => any>(), clipboard: vi.fn() }))
vi.mock('electron', () => ({ clipboard: { readText: mock.clipboard }, dialog: {}, ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => mock.handlers.set(key, handler) }, protocol: { handle: (_scheme: string, handler: typeof mock.serve) => { mock.serve = handler } } }))
vi.mock('./audio/decode', () => ({ decodeRecording: vi.fn() }))
import { registerNotesIpc } from './notes-ipc'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); vi.clearAllMocks() })

describe('recording audio ranges', () => {
  it('passes explicit answer text to the existing notes store without reading or overwriting the clipboard', async () => {
    const createText = vi.fn(async input => input), broadcast = vi.fn()
    registerNotesIpc({ store: { createText } as never, persistDir: vi.fn(), broadcast })
    expect(await mock.handlers.get('notes:createText')!(null, { text: '## Answer\n\nSaved content' })).toEqual({ text: '## Answer\n\nSaved content', categoryId: undefined })
    expect(mock.clipboard).not.toHaveBeenCalled(); expect(broadcast).toHaveBeenCalledOnce()
    mock.clipboard.mockReturnValue('Clipboard note')
    await mock.handlers.get('notes:createText')!(null, { fromClipboard: true, text: 'Ignored explicit text' })
    expect(createText).toHaveBeenLastCalledWith({ text: 'Clipboard note', categoryId: undefined })
  })
  it.each([
    ['bytes=-4', 206, '6789', 'bytes 6-9/10'],
    ['bytes=3-', 206, '3456789', 'bytes 3-9/10'],
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=-100', 206, '0123456789', 'bytes 0-9/10'],
    ['bytes=-0', 416, '', 'bytes */10'],
    ['bytes=11-', 416, '', 'bytes */10']
  ])('serves %s without changing the requested byte positions', async (range, status, body, contentRange) => {
    const dir = await mkdtemp(join(tmpdir(), 'typeless-audio-range-')); dirs.push(dir)
    const file = join(dir, 'recording.ogg'); await writeFile(file, '0123456789')
    registerNotesIpc({ store: { audioPathOf: () => file } as never, persistDir: vi.fn(), broadcast: vi.fn() })
    const response = await mock.serve!(new Request('typeless-audio://note/qa', { headers: { Range: range } }))
    expect(response.status).toBe(status); expect(await response.text()).toBe(body)
    expect(response.headers.get('content-range')).toBe(contentRange)
  })
})
