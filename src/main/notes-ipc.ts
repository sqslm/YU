import { dialog, ipcMain, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import type { NoteBulk, NoteCategory, NotePatch } from '@shared/types'
import type { NotesStore } from './notes'
import { mt } from '@shared/mainI18n'

/**
 * Notes are the one place where the renderer has to read a file from disk.
 * `<audio src>` and `fetch()` both refuse plain `file://` in a sandboxed
 * renderer, so audio is served through a scheme of our own. The scheme itself
 * is registered as privileged in `index.ts` before `app.whenReady()`; only the
 * handler lives here.
 */
export const NOTES_AUDIO_SCHEME = 'typeless-audio'

export interface NotesIpcOptions {
  /** Owns `notes.json`, the audio files and the ASR/polish pipeline. */
  store: NotesStore
  /** Persists `settings.notesDir`; called only after a successful migration. */
  persistDir: (dir: string) => Promise<void>
  /** Pushes `notes:changed` to every window that may be showing notes. */
  broadcast: () => void
}

/** IPC hands us a real `Int16Array`, but a stray array must not throw. */
function asPcm(value: unknown): Int16Array {
  if (value instanceof Int16Array) return value
  if (Array.isArray(value)) return Int16Array.from(value as number[])
  if (value instanceof ArrayBuffer) return new Int16Array(value)
  return new Int16Array(0)
}

/**
 * Serves one audio file with byte-range support. `<audio>` asks for ranges when
 * the user drags the progress bar; answering 200 for every request makes the
 * scrubber look alive but seek nowhere. Notes audio is small (tens of KB to a
 * few MB), so reading it whole costs less than a streaming helper.
 */
async function serveAudio(file: string, range: string | null): Promise<Response> {
  const data = await readFile(file)
  const type = file.toLowerCase().endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'
  const header = range ? /bytes=(\d*)-(\d*)/i.exec(range) : null
  if (header) {
    const total = data.length
    const start = header[1] ? Number(header[1]) : 0
    const rawEnd = header[2] ? Number(header[2]) : total - 1
    const end = Math.min(rawEnd, total - 1)
    if (!Number.isFinite(start) || start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` }
      })
    }
    const slice = new Uint8Array(data.subarray(start, end + 1))
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }
  return new Response(new Uint8Array(data), {
    headers: { 'Content-Type': type, 'Content-Length': String(data.length), 'Accept-Ranges': 'bytes' }
  })
}

export function registerNotesIpc(options: NotesIpcOptions): void {
  const { store, persistDir, broadcast } = options

  protocol.handle(NOTES_AUDIO_SCHEME, async (request) => {
    let id = ''
    try {
      // `typeless-audio://note/<id>` — the host is a fixed label, the id is the
      // path. Parse instead of slicing so a percent-encoded id still resolves.
      id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const file = id ? store.audioPathOf(id) : null
    if (!file) return new Response('not found', { status: 404 })
    try {
      return await serveAudio(file, request.headers.get('range'))
    } catch {
      return new Response('not readable', { status: 404 })
    }
  })

  ipcMain.handle('notes:list', () => store.list())

  ipcMain.handle(
    'notes:create',
    async (
      _event,
      input: { pcm: unknown; durationMs: number; categoryId?: string; tags?: string[] }
    ) => {
      const note = await store.create({
        pcm: asPcm(input?.pcm),
        durationMs: Number(input?.durationMs) || 0,
        categoryId: input?.categoryId,
        tags: input?.tags
      })
      broadcast()
      return note
    }
  )

  ipcMain.handle('notes:update', async (_event, id: string, patch: NotePatch) => {
    const note = await store.update(id, patch ?? {})
    broadcast()
    return note
  })

  ipcMain.handle('notes:remove', async (_event, id: string) => {
    await store.remove(id)
    broadcast()
  })

  /** Batch operations from the notes sidebar: delete, set category, add tag. */
  ipcMain.handle('notes:applyBulk', async (_event, ids: string[], bulk: NoteBulk) => {
    const result = await store.applyBulk(Array.isArray(ids) ? ids : [], bulk ?? {})
    if (result.changed > 0) broadcast()
    return result
  })

  ipcMain.handle('notes:repolish', async (_event, id: string) => {
    const note = await store.repolish(id)
    broadcast()
    return note
  })

  ipcMain.handle('notes:setCategories', async (_event, categories: NoteCategory[]) => {
    const next = await store.setCategories(Array.isArray(categories) ? categories : [])
    broadcast()
    return next
  })

  ipcMain.handle('notes:audioUrl', (_event, id: string) => {
    if (!id || !store.audioPathOf(id)) return null
    return `${NOTES_AUDIO_SCHEME}://note/${encodeURIComponent(id)}`
  })

  ipcMain.handle('notes:dataDir', () => store.dataDir())

  ipcMain.handle('notes:chooseDataDir', async () => {
    const result = await dialog.showOpenDialog({
      title: mt('选择随记数据目录'),
      defaultPath: store.dataDir().dir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, message: mt('没有选择目录') }
    }
    return { ok: true, dir: result.filePaths[0] }
  })

  ipcMain.handle('notes:migrate', async (_event, target: string) => {
    const result = await store.migrate(target ?? '')
    // Only a verified move may change the pointer: a half-copied target that
    // still had the old root would look to the user like deleted notes.
    if (result.ok) {
      await persistDir(store.dataDir().dir)
      broadcast()
    }
    return result
  })
}
