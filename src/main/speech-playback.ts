import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { handle } from './ipc-trust'
import type { SpeechPlaybackReply, SpeechPlaybackRequest } from '@shared/speech'
import type { SpeechResult, SpeechRunner } from './speech'

/** Uses the existing always-alive bar, without a new window or files containing speech. */
export function createSpeechPlayback(window: () => BrowserWindow | null): SpeechRunner {
  let current: { id: string; win: BrowserWindow; started?: () => void; finish: (result: SpeechResult) => void } | null = null
  const controls = new Map<string, (result: SpeechResult) => void>()
  handle('speech:playback-reply', (event, reply: SpeechPlaybackReply) => {
    if (event.sender !== window()?.webContents) throw Error('Playback owner required')
    if (reply.event === 'control') { controls.get(reply.id)?.({ ok: true }); return }
    if (reply.event === 'error' && controls.has(reply.id)) { controls.get(reply.id)?.({ ok: false, error: reply.error }); return }
    if (current?.id !== reply.id) return
    if (reply.event === 'started') current.started?.()
    else current.finish({ ok: reply.event === 'ended', error: reply.error })
  })
  const send = (win: BrowserWindow, request: SpeechPlaybackRequest): void => win.webContents.send('speech:playback', request)
  const run: SpeechRunner = (request, signal, started) => new Promise(resolve => {
    const win = window()
    if (signal?.aborted) { resolve({ ok: false, error: 'cancelled' }); return }
    if (!win || win.isDestroyed() || !request.audio) { resolve({ ok: false, error: 'Speech playback is not ready' }); return }
    current?.finish({ ok: false, error: 'Speech interrupted' })
    const id = randomUUID()
    let timer: ReturnType<typeof setTimeout>
    const finish = (result: SpeechResult): void => {
      if (current?.id !== id) return
      clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      win.webContents.removeListener('destroyed', closed)
      win.webContents.removeListener('render-process-gone', closed)
      current = null
      resolve(result)
    }
    const cancel = (): void => { if (!win.isDestroyed()) send(win, { id, action: 'stop' }); finish({ ok: false, error: 'cancelled' }) }
    const closed = (): void => finish({ ok: false, error: 'Speech player closed' })
    current = { id, win, started: () => { clearTimeout(timer); started?.() }, finish }
    timer = setTimeout(() => { cancel() }, 20_000)
    signal?.addEventListener('abort', cancel, { once: true })
    win.webContents.once('destroyed', closed)
    win.webContents.once('render-process-gone', closed)
    send(win, { id, action: 'play', audio: request.audio, volume: request.volume, speed: request.speed })
  })
  run.control = action => new Promise(resolve => {
    if (!current || current.win.isDestroyed()) { resolve({ ok: false, error: 'Speech playback is not ready' }); return }
    const id = randomUUID()
    const timer = setTimeout(() => { controls.delete(id); resolve({ ok: false, error: 'Speech control timeout' }) }, 5000)
    controls.set(id, result => { clearTimeout(timer); controls.delete(id); resolve(result) })
    send(current.win, { id, action })
  })
  return run
}
