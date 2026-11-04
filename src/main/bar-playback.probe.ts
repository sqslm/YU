/**
 * Real-renderer probe for the pill's playback path.
 *
 * The unit tests stop at the IPC boundary; this one boots Electron, loads the
 * built `out/renderer/bar.html` with the built preload, serves a synthesized WAV
 * over the app's own `typeless-audio://note/` scheme and drives the production
 * `NoteAudioPlayer` / readiness gate against it. It exists to catch the failure
 * the unit tests cannot see: a command sent before the renderer's React effects
 * have subscribed is lost, which is exactly what happened to the first command
 * after the pill was (re)created.
 *
 * Bundled by `bar-playback.probe.test.ts` into `work/t19-probe/probe.cjs` and run
 * with the repo's Electron binary. Exit code 0 means every case passed.
 */
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteAudioEvent, NoteAudioState } from '@shared/noteAudio'
import { NoteAudioPlayer } from './note-audio'
import { createBarReadiness } from './bar-ready'
import { createNoteAudioBusy } from './note-audio-busy'
import { subscribe, trustWindow } from './ipc-trust'

const OUT = process.env.PROBE_OUT ?? 'E:/code/deepseek-harness/work/t19-probe'
const REPO = process.cwd()
const BAR_HTML = join(REPO, 'out/renderer/bar.html')
const PRELOAD = join(REPO, 'out/preload/index.js')
const BUDGET_MS = 150_000

interface CaseResult { name: string; ok: boolean; detail: string }
const cases: CaseResult[] = []
const startedAt = Date.now()
let finished = false

function finish(): void {
  if (finished) return
  finished = true
  const pass = cases.length > 0 && cases.every(entry => entry.ok)
  const payload = { pass, cases, timing: { totalMs: Date.now() - startedAt, startedAt: new Date(startedAt).toISOString() }, artifacts: { barHtml: BAR_HTML, preload: PRELOAD } }
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, 'result.json')
  writeFileSync(file, JSON.stringify(payload, null, 2))
  console.log(`RESULT ${file}`)
  console.log(`RESULT_JSON ${JSON.stringify(payload)}`)
  app.exit(pass ? 0 : 1)
}

async function step(name: string, run: () => Promise<string>): Promise<void> {
  const at = Date.now()
  try {
    const detail = await run()
    cases.push({ name, ok: true, detail: `${detail} (${Date.now() - at} ms)` })
    console.log(`ok   ${name} — ${detail}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    cases.push({ name, ok: false, detail: `${detail} (${Date.now() - at} ms)` })
    console.log(`FAIL ${name} — ${detail}`)
  }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function eventually<T>(what: string, probe: () => T | null | undefined | false, budgetMs = 5000): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() > deadline) throw Error(`timed out waiting for ${what}`)
    await delay(20)
  }
}

// ── synthesized audio ────────────────────────────────────────────────────────
function wav(seconds: number, frequency = 440): Buffer {
  const rate = 8000
  const frames = Math.round(rate * seconds)
  const data = Buffer.alloc(frames * 2)
  for (let index = 0; index < frames; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / rate) * 0.3 * 32767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** `short` ends on its own quickly, `long` and `hold` stay playing, `stream` never reports a length. */
const CLIPS: Record<string, Buffer> = { short: wav(0.45), long: wav(1.6), hold: wav(3), stream: wav(60) }
// An open-ended data chunk: the element cannot know when this one ends.
CLIPS.stream.writeUInt32LE(0xffffffff, 40)
CLIPS.stream.writeUInt32LE(0xffffffff - 36, 4)

protocol.registerSchemesAsPrivileged([{ scheme: 'typeless-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])

app.setPath('userData', join(OUT, `profile-${process.pid}`))
app.on('window-all-closed', () => undefined)

// ── playback state shared with the probe cases ───────────────────────────────
const readiness = createBarReadiness()
const busy = createNoteAudioBusy()
const events: NoteAudioEvent[] = []
let waiters: Array<{ match: (event: NoteAudioEvent) => boolean; resolve: (event: NoteAudioEvent) => void; cancel: () => void }> = []
let win: BrowserWindow | null = null
let created = 0

function nextEvent(match: (event: NoteAudioEvent) => boolean, what: string, budgetMs = 6000): Promise<NoteAudioEvent> {
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve: (event: NoteAudioEvent) => { clearTimeout(timer); resolve(event) }, cancel: () => undefined }
    const timer = setTimeout(() => {
      waiters = waiters.filter(entry => entry !== waiter)
      reject(Error(`timed out waiting for ${what}`))
    }, budgetMs)
    waiter.cancel = () => { clearTimeout(timer); waiters = waiters.filter(entry => entry !== waiter) }
    waiters.push(waiter)
  })
}

function createWindow(): BrowserWindow {
  created += 1
  const next = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  win = next
  trustWindow(next)
  next.on('closed', () => { if (win === next) win = null; readiness.forget(next); busy.reset() })
  next.webContents.on('render-process-gone', () => { readiness.forget(next); busy.reset() })
  void next.loadFile(BAR_HTML)
  return next
}

const host = {
  peek: () => (win && !win.isDestroyed() ? win : null),
  ensure: async (): Promise<BrowserWindow | null> => {
    const target = win && !win.isDestroyed() ? win : createWindow()
    await readiness.wait(target).promise
    return target.isDestroyed() ? null : target
  }
}

const player = new NoteAudioPlayer(host, id => `typeless-audio://note/${encodeURIComponent(id)}`, (state: NoteAudioState) => busy.track(state))
player.register()

subscribe('bar:ready', event => {
  const target = win
  if (!target || target.isDestroyed() || event.sender !== target.webContents) return
  readiness.markReady(target)
})
subscribe('note-audio:event', (event, state: NoteAudioEvent) => {
  const target = host.peek()
  if (!target || event.sender !== target.webContents) return
  const accepted = player.acceptEvent(state)
  if (!accepted) return
  busy.track(accepted)
  events.push(accepted)
  for (const waiter of [...waiters]) {
    if (!waiter.match(accepted)) continue
    waiter.cancel()
    waiter.resolve(accepted)
  }
})

async function probe(): Promise<void> {
  await step('cold-play', async () => {
    // No window exists and nothing was awaited: this is the failing case — the
    // command must wait for the real `bar:ready` instead of being lost.
    const before = created
    if (before !== 0) throw Error(`a window already existed (${before})`)
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`expected playing, got ${state.state}`)
    if (created !== before + 1) throw Error(`expected exactly one window, got ${created}`)
    return `state=playing created=${created} durationMs=${state.durationMs}`
  })

  await step('natural-end', async () => {
    const requestId = player.activePlayId
    if (!requestId) throw Error('no active play id')
    const event = await nextEvent(entry => entry.requestId === requestId && entry.state === 'ended', 'the real ended event', 8000)
    if (busy.isBusy()) throw Error('busy was still set after the real ended event')
    return `ended at positionMs=${event.positionMs} durationMs=${event.durationMs}; busy released`
  })

  await step('ready-window-play', async () => {
    const before = created
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`expected playing, got ${state.state}`)
    const stopped = await player.control('stop')
    if (stopped.state !== 'idle' || busy.isBusy()) throw Error(`stop left state=${stopped.state} busy=${busy.isBusy()}`)
    if (created !== before) throw Error(`an already-ready window was replaced (${before} -> ${created})`)
    return `state=playing then idle, windows=${created}`
  })

  await step('pause-resume', async () => {
    await player.control('play', 'long')
    await eventually('the pill to report playing', () => busy.isBusy())
    await delay(300)
    const paused = await player.control('pause')
    if (paused.state !== 'paused') throw Error(`expected paused, got ${paused.state}`)
    if (paused.positionMs <= 0) throw Error(`pause reported positionMs=${paused.positionMs}`)
    const resumed = await player.control('resume')
    if (resumed.state !== 'playing') throw Error(`expected playing after resume, got ${resumed.state}`)
    if (resumed.positionMs < paused.positionMs) throw Error(`resume rewound to ${resumed.positionMs}ms (was ${paused.positionMs}ms)`)
    if (resumed.rate !== paused.rate) throw Error(`rate changed across resume: ${paused.rate} -> ${resumed.rate}`)
    await player.control('stop')
    return `paused at ${paused.positionMs}ms, resumed at ${resumed.positionMs}ms, rate=${resumed.rate}`
  })

  await step('seek-and-rate', async () => {
    await player.control('play', 'long')
    const rated = await player.control('rate', undefined, { rate: 1.5 })
    if (Math.abs(rated.rate - 1.5) > 0.01) throw Error(`rate=${rated.rate} after the rate command`)
    const sought = await player.control('seek', undefined, { positionMs: 1000 })
    if (Math.abs(sought.positionMs - 1000) > 200) throw Error(`seek landed at ${sought.positionMs}ms`)
    const kept = await player.control('status')
    if (Math.abs(kept.rate - 1.5) > 0.01) throw Error(`rate=${kept.rate} did not survive the seek`)
    await player.control('stop')
    return `rate=${rated.rate} seek=${sought.positionMs}ms statusRate=${kept.rate}`
  })

  await step('recreate-after-destroy', async () => {
    const before = created
    win?.destroy()
    await eventually('the pill to disappear', () => !host.peek())
    if (busy.isBusy()) throw Error('busy stayed set after the window was destroyed')
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`expected playing on a rebuilt window, got ${state.state}`)
    if (created !== before + 1) throw Error(`expected one new window, got ${created - before}`)
    await player.control('stop')
    return `state=playing on window #${created}`
  })

  // A paused track with a known length must stay busy: the old duration estimate
  // released it at (duration - position)/rate + 1.5 s even though it still held
  // the recording.
  await step('long-pause-holds-busy', async () => {
    await player.control('play', 'hold')
    await eventually('the pill to report playing', () => busy.isBusy())
    await delay(300)
    const paused = await player.control('pause')
    if (paused.state !== 'paused') throw Error(`expected paused, got ${paused.state}`)
    const mark = events.length
    await delay(5000)
    if (!busy.isBusy()) throw Error('busy was released while the recording was still paused')
    const released = events.slice(mark).some(entry => entry.state !== 'paused')
    if (released) throw Error('an event released the paused playback on its own')
    await player.control('stop')
    return `still busy after 5 s paused at ${paused.positionMs}ms of ${paused.durationMs}ms`
  })

  // A source with no known length reports an unusable duration; nothing may
  // estimate an end from it, and its playback must not self-release either.
  await step('unknown-duration-busy', async () => {
    const state = await player.control('play', 'stream')
    if (state.state !== 'playing') throw Error(`expected playing, got ${state.state}`)
    const mark = events.length
    await delay(3000)
    if (!busy.isBusy()) throw Error('busy was released while the unknown-length source was still playing')
    const ended = events.slice(mark).some(entry => entry.state === 'ended' || entry.state === 'error')
    if (ended) throw Error('the unknown-length source reported its own end during the wait')
    await player.control('stop')
    return `durationMs=${state.durationMs} and busy held for 3 s with no expiry`
  })

  // Only events for the play that currently owns the element may move the flag.
  await step('stale-event-ignored', async () => {
    await player.control('play', 'long')
    const stale = player.activePlayId
    await player.control('play', 'long')
    const live = player.activePlayId
    if (!stale || !live || stale === live) throw Error(`expected two distinct plays, got ${stale} / ${live}`)
    const target = host.peek()
    if (!target) throw Error('no window to inject from')
    const forge = (requestId: string, state: string): Promise<unknown> => target.webContents.executeJavaScript(
      `window.api.bar.reportNoteAudio({requestId:${JSON.stringify(requestId)},state:${JSON.stringify(state)},id:'long',positionMs:0,durationMs:1600,rate:1})`
    )
    const mark = events.length
    await forge(stale, 'ended')
    await delay(200)
    if (!busy.isBusy()) throw Error('a stale ended event released the current playback')
    if (events.slice(mark).some(entry => entry.requestId === stale)) throw Error('the stale event was accepted')
    // The same channel must still work for the play that owns the element, or the
    // check would pass just by ignoring everything.
    await forge(live, 'ended')
    await eventually('the owned event to be accepted', () => !busy.isBusy(), 3000)
    await player.control('stop')
    return `late ended for ${stale.slice(0, 8)} ignored; the owned ${live.slice(0, 8)} released the flag`
  })

  await step('status-without-window', async () => {
    win?.destroy()
    await eventually('the pill to disappear', () => !host.peek())
    const before = created
    const state = await player.control('status')
    if (state.state !== 'idle' || state.id !== null) throw Error(`expected idle, got ${JSON.stringify(state)}`)
    if (created !== before) throw Error(`status created a window (${before} -> ${created})`)
    return `state=idle windows=${created} (no window was created)`
  })
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // The bar asks for its settings before it reports ready; without an answer the
  // effects never finish and no command would ever be deliverable.
  ipcMain.handle('settings:get', () => ({
    uiLanguage: 'zh-CN', themeMode: 'dark', themePack: 'classic', showModeInBar: true, playSounds: false,
    inputDeviceId: '', audioProcessing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }))
  protocol.handle('typeless-audio', async request => {
    const url = new URL(request.url)
    const key = url.pathname.slice(1) || 'short'
    if (key === 'stream') {
      // The body is never closed and carries no length: the element can neither
      // learn the duration nor reach the end of it.
      const clip = CLIPS.stream
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(clip)) } })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    const clip = CLIPS[key]
    if (!clip) return new Response('not found', { status: 404 })
    const range = request.headers.get('Range')
    if (!range) return new Response(clip, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(clip.length), 'Accept-Ranges': 'bytes' } })
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match?.[1] ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), clip.length - 1) : clip.length - 1
    const slice = clip.subarray(start, end + 1)
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': 'audio/wav', 'Content-Length': String(slice.length), 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${clip.length}`
      }
    })
  })
  setTimeout(() => {
    cases.push({ name: 'budget', ok: false, detail: `probe exceeded ${BUDGET_MS} ms` })
    finish()
  }, BUDGET_MS)
  try { await probe() } catch (error) { cases.push({ name: 'probe', ok: false, detail: error instanceof Error ? error.message : String(error) }) }
  finish()
}).catch(error => {
  cases.push({ name: 'startup', ok: false, detail: error instanceof Error ? error.message : String(error) })
  finish()
})
