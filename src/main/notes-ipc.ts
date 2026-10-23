import { clipboard, dialog, ipcMain, protocol } from 'electron'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { NoteBulk, NoteCategory, NoteExportFormat, NotePatch } from '@shared/types'
import type { NotesStore } from './notes'
import { mt } from '@shared/mainI18n'
import { exportNoteAudio, exportNoteText } from './notes-export'
import { decodeRecording } from './audio/decode'

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
 * scrubber look alive but seek nowhere. Stream only the requested bytes, so
 * seeking a long imported recording does not buffer the whole file each time.
 */
async function serveAudio(file: string, range: string | null): Promise<Response> {
  const handle = await open(file, 'r')
  const type = file.toLowerCase().endsWith('.ogg') ? 'audio/ogg' : 'audio/wav'
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Not a recording file')
    const total = info.size
    const header = range?.trim().match(/^bytes=(\d*)-(\d*)$/i)
    const suffix = header && !header[1] ? Number(header[2]) : null
    const start = header ? header[1] ? Number(header[1]) : Math.max(0, total - suffix!) : 0
    const end = header?.[1] && header[2] ? Math.min(Number(header[2]), total - 1) : total - 1
    if (header && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total || suffix !== null && suffix <= 0)) {
      await handle.close()
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
    }
    const headers = { 'Content-Type': type, 'Content-Length': String(Math.max(0, end - start + 1)), 'Accept-Ranges': 'bytes',
      ...(header ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}) }
    if (!total) { await handle.close(); return new Response(null, { headers }) }
    const body = Readable.toWeb(handle.createReadStream({ start, end, autoClose: true })) as ReadableStream<Uint8Array>
    return new Response(body, { status: header ? 206 : 200, headers })
  } catch (error) { await handle.close(); throw error }
}

export function registerNotesIpc(options: NotesIpcOptions): void {
  const { store, persistDir, broadcast } = options
  let audioJob: AbortController | null = null

  ipcMain.handle('notes:cancelAudioJob', () => audioJob?.abort())
  ipcMain.handle('notes:importAudio', async (_event, categoryId?: string) => {
    if (audioJob) throw new Error(mt('已有录音正在处理'))
    const job = new AbortController()
    audioJob = job
    try {
      const chosen = await dialog.showOpenDialog({ title: mt('导入录音'), properties: ['openFile'],
        filters: [{ name: mt('录音文件'), extensions: ['wav', 'mp3', 'm4a', 'ogg'] }] })
      if (chosen.canceled || !chosen.filePaths[0] || job.signal.aborted) return null
      const audio = await decodeRecording(chosen.filePaths[0], job.signal)
      const note = await store.create({ ...audio, categoryId }, job.signal)
      broadcast()
      return note
    } catch (error) {
      if (job.signal.aborted) return null
      throw error
    } finally { if (audioJob === job) audioJob = null }
  })
  ipcMain.handle('notes:retranscribe', async (_event, id: string) => {
    if (audioJob) throw new Error(mt('已有录音正在处理'))
    const job = new AbortController()
    audioJob = job
    try { return await store.retranscribe(id, job.signal) ?? null }
    catch (error) { if (job.signal.aborted) return null; throw error }
    finally { if (audioJob === job) audioJob = null; broadcast() }
  })

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
  ipcMain.handle('notes:exportText', (_event, ids: string[], format: NoteExportFormat) => exportNoteText(store, ids, format))
  ipcMain.handle('notes:exportAudio', (_event, id: string) => exportNoteAudio(store, id))
  ipcMain.handle('notes:createText', async (_event, input?: { categoryId?: string; fromClipboard?: boolean; text?: string }) => {
    const fromClipboard = input?.fromClipboard === true
    const text = fromClipboard ? clipboard.readText() : input?.text ?? ''
    if (fromClipboard && !text.trim()) throw new Error(mt('剪贴板中没有可用的文字'))
    const note = await store.createText({ text, categoryId: input?.categoryId })
    broadcast()
    return note
  })

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
