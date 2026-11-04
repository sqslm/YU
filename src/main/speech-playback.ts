import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { handle } from './ipc-trust'
import type { SpeechPlaybackReply, SpeechPlaybackRequest } from '@shared/speech'
import type { SpeechResult, SpeechRunner } from './speech'

/**
 * Where the pill can be reached. `peek` must not create the window (a late reply
 * from a retired renderer must not resurrect it); `ensure` may, and only
 * resolves once that window can receive `speech:playback`.
 */
export interface SpeechPlaybackHost {
  peek: () => BrowserWindow | null
  ensure: () => Promise<BrowserWindow | null>
}

/** Uses the existing always-alive bar, without a new window or files containing speech. */
export function createSpeechPlayback(host: SpeechPlaybackHost): SpeechRunner {
  let current: { id: string; win: BrowserWindow | null; started?: () => void; finish: (result: SpeechResult) => void } | null = null
  const controls = new Map<string, (result: SpeechResult) => void>()
  handle('speech:playback-reply', (event, reply: SpeechPlaybackReply) => {
    if (!reply || typeof reply.id !== 'string') return
    const owner = host.peek()
    // A window that no longer exists — or one that is not the current owner —
    // has nothing to say about playback; ignore it instead of throwing, which
    // the renderer would see as an unhandled rejection.
    if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) return
    if (reply.event === 'control') { controls.get(reply.id)?.({ ok: true }); return }
    if (reply.event === 'error' && controls.has(reply.id)) { controls.get(reply.id)?.({ ok: false, error: reply.error }); return }
    if (current?.id !== reply.id) return
    if (reply.event === 'started') current.started?.()
    else current.finish({ ok: reply.event === 'ended', error: reply.error })
  })
  const send = (win: BrowserWindow, request: SpeechPlaybackRequest): void => win.webContents.send('speech:playback', request)
  const run: SpeechRunner = (request, signal, started) => new Promise(resolve => {
    if (signal?.aborted) { resolve({ ok: false, error: 'cancelled' }); return }
    if (!request.audio) { resolve({ ok: false, error: 'Speech playback is not ready' }); return }
    current?.finish({ ok: false, error: 'Speech interrupted' })
    const id = randomUUID()
    let settled = false
    const finish = (result: SpeechResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      const win = current?.id === id ? current.win : null
      if (win && !win.isDestroyed()) {
        win.webContents.removeListener('destroyed', closed)
        win.webContents.removeListener('render-process-gone', closed)
      }
      if (current?.id === id) current = null
      resolve(result)
    }
    const cancel = (): void => {
      const win = current?.id === id ? current.win : null
      if (win && !win.isDestroyed()) send(win, { id, action: 'stop' })
      finish({ ok: false, error: 'cancelled' })
    }
    const closed = (): void => finish({ ok: false, error: 'Speech player closed' })
    current = { id, win: null, started: () => { clearTimeout(timer); started?.() }, finish }
    // The budget covers creation and readiness as well: a pill that never reports
    // ready must not hold the caller past the same 20 s it always had.
    const timer = setTimeout(() => { cancel() }, 20_000)
    signal?.addEventListener('abort', cancel, { once: true })
    void (async () => {
      const win = await host.ensure()
      if (settled) return
      if (!win || win.isDestroyed()) { finish({ ok: false, error: 'Speech playback is not ready' }); return }
      if (current?.id === id) current.win = win
      if (signal?.aborted) { cancel(); return }
      win.webContents.once('destroyed', closed)
      win.webContents.once('render-process-gone', closed)
      send(win, { id, action: 'play', audio: request.audio!, volume: request.volume, speed: request.speed })
    })().catch(error => finish({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  })
  run.control = action => new Promise(resolve => {
    const win = current?.win ?? null
    if (!current || !win || win.isDestroyed()) { resolve({ ok: false, error: 'Speech playback is not ready' }); return }
    const id = randomUUID()
    const timer = setTimeout(() => { controls.delete(id); resolve({ ok: false, error: 'Speech control timeout' }) }, 5000)
    controls.set(id, result => { clearTimeout(timer); controls.delete(id); resolve(result) })
    send(win, { id, action })
  })
  return run
}
