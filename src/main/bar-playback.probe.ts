/**
 * Real-renderer probe for the pill's playback path.
 *
 * The unit tests stop at the IPC boundary; this one boots Electron, loads the
 * built `out/renderer/bar.html` with the built preload, serves a synthesized WAV
 * over the app's own `typeless-audio://note/` scheme and drives the production
 * wiring — `createBarPlaybackHost`, `createBarReadiness`, `NoteAudioPlayer` and
 * `createSpeechPlayback` — against it. It exists to catch the failure the unit
 * tests cannot see: a command sent before the renderer's React effects have
 * subscribed is lost, which is exactly what happened to the first command after
 * the pill was (re)created.
 *
 * Every assertion is made on what the renderer actually did — the real
 * `playing`/`paused`/`ended` events it reports, the busy flag it drives, the
 * `positionMs`/`id` snapshot it answers `status` with — never on the number of
 * `webContents.send` calls.
 *
 * Bundled by `bar-playback.probe.test.ts` into `work/t19-probe/probe.cjs` and run
 * with the repo's Electron binary. Exit code 0 means every case passed; the
 * result file carries the case list plus the build identity R4's `playbackGate`
 * requires.
 */
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteAudioEvent, NoteAudioState } from '@shared/noteAudio'
import type { SpeechRequest } from './speech'
import { NoteAudioPlayer } from './note-audio'
import { createBarReadiness } from './bar-ready'
import { createBarPlaybackHost } from './bar-playback-host'
import { createSpeechPlayback } from './speech-playback'
import { createNoteAudioBusy } from './note-audio-busy'
import { subscribe, trustWindow } from './ipc-trust'

const REPO = process.cwd()
const OUT = process.env.PROBE_OUT ?? join(REPO, '../../work/t19-probe')
const BAR_HTML = join(REPO, 'out/renderer/bar.html')
const PRELOAD = join(REPO, 'out/preload/index.js')
const MAIN_ENTRY = join(REPO, 'out/main/index.js')
const BUDGET_MS = 150_000

interface CaseResult {
  id: string
  pass: boolean
  kind: 'real-window' | 'stub'
  detail: string
  ms: number
  skipped?: boolean
  skipReason?: string
}
const cases: CaseResult[] = []
const startedAt = Date.now()
let finished = false

function sha256(file: string): string | null {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}

/** The commit the probe was run from; a dirty tree is called out instead of hidden. */
function sourceRef(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim()
    return dirty ? `HEAD ${head} (dirty)` : `HEAD ${head}`
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`
  }
}

function finish(): void {
  if (finished) return
  finished = true
  const pass = cases.length > 0 && cases.every(entry => entry.pass === true && entry.skipped !== true)
  const barHtmlSha256 = sha256(BAR_HTML)
  const preloadSha256 = sha256(PRELOAD)
  const entrySha256 = sha256(MAIN_ENTRY)
  const payload = {
    pass,
    cases,
    timing: {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      totalMs: Date.now() - startedAt
    },
    artifacts: {
      barHtml: barHtmlSha256,
      preload: preloadSha256,
      mainEntry: entrySha256,
      paths: { barHtml: BAR_HTML, preload: PRELOAD, mainEntry: MAIN_ENTRY }
    },
    identity: {
      entrySha256,
      preloadSha256,
      barHtmlSha256,
      sourceRef: sourceRef(),
      command: 'pnpm exec vitest run src/main/bar-playback.probe.test.ts'
    },
    environment: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      userData: app.getPath('userData'),
      out: OUT
    }
  }
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, 'result.json')
  writeFileSync(file, JSON.stringify(payload, null, 2))
  console.log(`RESULT ${file}`)
  console.log(`RESULT_JSON ${JSON.stringify(payload)}`)
  app.exit(pass ? 0 : 1)
}

/** A case the environment refused to run: recorded as skipped, never as a pass. */
class CaseSkipped extends Error {}

async function step(id: string, run: () => Promise<string>): Promise<void> {
  const at = Date.now()
  try {
    const detail = await run()
    cases.push({ id, kind: 'real-window', pass: true, detail, ms: Date.now() - at })
    console.log(`ok   ${id} — ${detail} (${Date.now() - at} ms)`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const ms = Date.now() - at
    // A case the platform blocked is marked as not run, not as a pass and not as
    // a plain failure: the report has to say "untested" out loud.
    if (error instanceof CaseSkipped) {
      cases.push({ id, kind: 'real-window', pass: false, skipped: true, skipReason: detail, detail, ms })
      console.log(`SKIP ${id} — ${detail} (${ms} ms)`)
      return
    }
    cases.push({ id, kind: 'real-window', pass: false, detail, ms })
    console.log(`FAIL ${id} — ${detail} (${ms} ms)`)
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

interface Settled<T> { ok: boolean; value?: T; error: string; ms: number }

/** Waits for a promise that is expected to settle — a hang here is the failure being hunted. */
async function settleSoon<T>(what: string, promise: Promise<T>, budgetMs = 6000): Promise<Settled<T>> {
  const at = Date.now()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error(`${what} never settled (still pending after ${budgetMs} ms)`)), budgetMs)
  })
  try {
    const value = await Promise.race([promise, timeout])
    return { ok: true, value, error: '', ms: Date.now() - at }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - at }
  } finally {
    clearTimeout(timer)
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
const goneEvents: Array<{ webContentsId: number; reason: string; exitCode: number }> = []
let waiters: Array<{ match: (event: NoteAudioEvent) => boolean; resolve: (event: NoteAudioEvent) => void; cancel: () => void }> = []
let win: BrowserWindow | null = null
let created = 0
/** Read through a call so TypeScript cannot narrow the counter to a literal. */
const windowsCreated = (): number => created
/**
 * Probe-only gate for the cases that need a window which is genuinely *not*
 * ready yet: the renderer still reports `bar:ready`, the probe just holds it
 * back until the case releases it, so "before ready" is a real state instead of
 * a race against the page's mount speed.
 */
let holdReady = false
const heldReady = new Set<BrowserWindow>()

function createWindow(): BrowserWindow {
  created += 1
  const next = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' }
  })
  const webContentsId = next.webContents.id
  win = next
  trustWindow(next)
  next.on('closed', () => {
    if (win === next) win = null
    heldReady.delete(next)
    readiness.forget(next)
    busy.reset()
    // index.ts forgets the playback on the way out; without this a pending play
    // would keep owning the element after its window is gone.
    player.dispose()
  })
  next.webContents.on('render-process-gone', (_event, details) => {
    goneEvents.push({ webContentsId, reason: details.reason, exitCode: details.exitCode })
    // The app retires a renderer that died (index.ts does the same): a window
    // whose renderer is gone can never report ready again, so keeping it would
    // make the next command wait out its whole budget for a page that will
    // never listen. This is the probe's own window lifecycle, not the host.
    if (win === next) win = null
    heldReady.delete(next)
    readiness.forget(next)
    busy.reset()
    player.dispose()
    if (!next.isDestroyed()) next.destroy()
  })
  void next.loadFile(BAR_HTML)
  return next
}

function releaseReady(): void {
  holdReady = false
  const waiting = [...heldReady]
  heldReady.clear()
  for (const target of waiting) if (!target.isDestroyed()) readiness.markReady(target)
}

/**
 * Waits for a renderer event, including one that already arrived: the pill can
 * report `playing` before the command that caused it has even resolved, so a
 * waiter registered afterwards would miss it and wait out its budget. `backlog`
 * is scanned before the waiter is installed, in the same tick, so nothing can
 * slip between the two.
 */
function nextEvent(match: (event: NoteAudioEvent) => boolean, what: string, budgetMs = 6000, backlog: NoteAudioEvent[] = []): Promise<NoteAudioEvent> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const waiter = {
      match,
      resolve: (event: NoteAudioEvent) => {
        if (timer) clearTimeout(timer)
        resolve(event)
      },
      cancel: () => {
        if (timer) clearTimeout(timer)
        waiters = waiters.filter(entry => entry !== waiter)
      }
    }
    const already = backlog.find(match)
    if (already) {
      resolve(already)
      return
    }
    timer = setTimeout(() => {
      waiters = waiters.filter(entry => entry !== waiter)
      reject(Error(`timed out waiting for ${what}`))
    }, budgetMs)
    waiters.push(waiter)
  })
}

// The production wiring the app uses, imported rather than copied: the host, the
// readiness gate, the note player and the speech runner.
const host = createBarPlaybackHost({
  window: () => win,
  create: () => createWindow(),
  readiness,
  log: line => console.log(line)
})

const player = new NoteAudioPlayer(host, id => `typeless-audio://note/${encodeURIComponent(id)}`, (state: NoteAudioState) => busy.track(state), line => console.log(line))
player.register()

const speech = createSpeechPlayback(host)

subscribe('bar:ready', event => {
  const target = win
  if (!target || target.isDestroyed() || event.sender !== target.webContents) return
  if (holdReady) { heldReady.add(target); return }
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

// ── renderer-side observation ────────────────────────────────────────────────
/**
 * Records what the pill actually received, from inside the pill. It is an extra
 * listener next to the page's own, so it changes nothing about playback and it
 * is what lets the probe name a speech id the main process generated.
 */
const RECORDER = `(() => {
  window.__noteSeen = window.__noteSeen || [];
  window.__speechSeen = window.__speechSeen || [];
  if (typeof window.__probeOff === 'function') window.__probeOff();
  const offNote = window.api.bar.onNoteAudio(r => window.__noteSeen.push({ action: r.action, requestId: r.requestId, id: r.id }));
  const offSpeech = window.api.bar.onSpeechPlayback(r => window.__speechSeen.push({ id: r.id, action: r.action }));
  window.__probeOff = () => { offNote(); offSpeech(); };
  return true;
})()`

interface SeenNote { action: string; requestId: string; id?: string }
interface SeenSpeech { id: string; action: string }

async function installRecorder(target: BrowserWindow): Promise<void> {
  await target.webContents.executeJavaScript(RECORDER)
}

async function seenNotes(target: BrowserWindow): Promise<SeenNote[]> {
  return await target.webContents.executeJavaScript('window.__noteSeen || []') as SeenNote[]
}

async function seenSpeech(target: BrowserWindow): Promise<SeenSpeech[]> {
  return await target.webContents.executeJavaScript('window.__speechSeen || []') as SeenSpeech[]
}

const speechRequest = (clip: string): SpeechRequest => ({ action: 'speak', audio: { bytes: CLIPS[clip], mime: 'audio/wav' }, volume: 100, speed: 1 })

/** Drops the current pill and waits until the sink really reports none. */
async function destroyWindow(): Promise<void> {
  win?.destroy()
  await eventually('the pill to disappear', () => !host.peek(), 4000)
}

async function probe(): Promise<void> {
  // ── R3: the note cold path ────────────────────────────────────────────────
  await step('r3-note-cold-path', async () => {
    if (windowsCreated() !== 0) throw Error(`a window already existed (${windowsCreated()})`)
    const state = await player.control('play', 'short')
    const requestId = player.activePlayId
    if (!requestId) throw Error('the play has no owning id')
    if (state.state !== 'playing') throw Error(`expected playing, got ${state.state}`)
    if (state.id !== 'short') throw Error(`expected id=short, got ${state.id}`)
    if (state.durationMs < 300 || state.durationMs > 700) throw Error(`durationMs=${state.durationMs} is not the 450 ms clip`)
    if (windowsCreated() !== 1) throw Error(`expected exactly one window, got ${windowsCreated()}`)
    const started = await nextEvent(entry => entry.requestId === requestId && entry.state === 'playing', 'the real playing event', 5000, events)
    if (!busy.isBusy()) throw Error('busy was not set by the real playing event')
    // The first play in a freshly created window can take a moment before the
    // media clock advances, so poll the renderer's own snapshot instead of
    // assuming a fixed delay: what matters is that it advances at all.
    const advanceBy = Date.now() + 3000
    let live = await player.control('status')
    while (live.state === 'playing' && live.positionMs <= started.positionMs && Date.now() < advanceBy) {
      await delay(100)
      live = await player.control('status')
    }
    if (live.state !== 'playing' && live.state !== 'ended') throw Error(`status said ${JSON.stringify(live)}`)
    if (live.id !== 'short') throw Error(`status says id=${live.id}`)
    if (live.positionMs <= started.positionMs) throw Error(`position did not advance: ${started.positionMs} -> ${live.positionMs}`)
    return `window #1, playing event at ${started.positionMs}ms/${started.durationMs}ms, status=${live.state} id=${live.id} position=${live.positionMs}ms, busy=true`
  })

  await step('natural-end', async () => {
    const requestId = player.activePlayId
    if (!requestId) throw Error('no active play id')
    const event = await nextEvent(entry => entry.requestId === requestId && entry.state === 'ended', 'the real ended event', 8000, events)
    if (busy.isBusy()) throw Error('busy was still set after the real ended event')
    const idle = await player.control('status')
    if (idle.state !== 'ended') throw Error(`the element reports ${idle.state} instead of ended`)
    return `ended at positionMs=${event.positionMs} durationMs=${event.durationMs}; busy released; element=${idle.state}`
  })

  await step('ready-window-play', async () => {
    const before = windowsCreated()
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`expected playing, got ${state.state}`)
    const requestId = player.activePlayId
    const started = await nextEvent(entry => entry.requestId === requestId && entry.state === 'playing', 'the playing event', 4000, events)
    const stopped = await player.control('stop')
    if (stopped.state !== 'idle' || busy.isBusy()) throw Error(`stop left state=${stopped.state} busy=${busy.isBusy()}`)
    if (windowsCreated() !== before) throw Error(`an already-ready window was replaced (${before} -> ${windowsCreated()})`)
    return `playing at ${started.positionMs}ms then idle, windows=${windowsCreated()} (reused)`
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

  // ── R1: a newer play wins, and the replaced play's late replies change nothing ──
  await step('r1-playback-replacement', async () => {
    const target = host.peek()
    if (!target || !readiness.isReady(target)) throw Error('this case needs the ready pill')
    const first = await player.control('play', 'long')
    const oldId = player.activePlayId
    if (!oldId || first.state !== 'playing') throw Error(`the first play did not start: ${JSON.stringify(first)}`)
    const replacement = player.control('play', 'hold')
    const newId = player.activePlayId
    if (!newId || newId === oldId) throw Error(`expected a distinct replacement id, got ${oldId} / ${newId}`)
    const started = nextEvent(entry => entry.requestId === newId && entry.state === 'playing', 'the replacement to really start playing', 6000, events)
    const state = await replacement
    if (state.state !== 'playing' || state.id !== 'hold') throw Error(`the replacement reports ${JSON.stringify(state)}`)
    const playing = await started
    if (!busy.isBusy()) throw Error('busy was not held by the replacement')
    // A late `ended`/`error` from the play that was replaced must not release or
    // reshape the one that owns the element now.
    const mark = events.length
    const forge = (requestId: string, state: string): Promise<unknown> => target.webContents.executeJavaScript(
      `window.api.bar.reportNoteAudio({requestId:${JSON.stringify(requestId)},state:${JSON.stringify(state)},id:'long',positionMs:1600,durationMs:1600,rate:1})`
    )
    await forge(oldId, 'ended')
    await forge(oldId, 'error')
    await delay(250)
    if (!busy.isBusy()) throw Error('a late reply from the replaced play released the replacement')
    if (events.slice(mark).some(entry => entry.requestId === oldId)) throw Error('a late reply from the replaced play was accepted')
    if (player.activePlayId !== newId) throw Error(`the owner changed to ${player.activePlayId}`)
    const firstStatus = await player.control('status')
    await delay(250)
    const nextStatus = await player.control('status')
    if (firstStatus.state !== 'playing' || firstStatus.id !== 'hold') throw Error(`status says ${JSON.stringify(firstStatus)}`)
    if (nextStatus.positionMs <= firstStatus.positionMs) throw Error(`the replacement is not really playing: ${firstStatus.positionMs} -> ${nextStatus.positionMs}`)
    await player.control('stop')
    return `old ${oldId.slice(0, 8)} (long) replaced by ${newId.slice(0, 8)} (hold); replacement played at ${playing.positionMs}ms then ${nextStatus.positionMs}ms; stale ended+error ignored, busy stayed true`
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

  // ── R1: stop while the cold window is still starting must cancel the play ──
  await step('r1-stop-before-ready', async () => {
    await destroyWindow()
    holdReady = true
    const play = player.control('play', 'long')
    const settling = settleSoon('the play stopped before ready', play, 6000)
    const requestId = player.activePlayId
    if (!requestId) throw Error('the play has no owning id')
    const waiting = await eventually('the window a play is waiting for', () => host.peek(), 4000)
    if (readiness.isReady(waiting)) throw Error('the window was already ready; this case needs a cold one')
    const stopped = await player.control('stop')
    if (stopped.state !== 'idle' || stopped.id !== null) throw Error(`stop answered ${JSON.stringify(stopped)}`)
    const outcome = await settling
    if (outcome.ok) throw Error('the stopped play still resolved as if it had started')
    if (!/cancelled|superseded/i.test(outcome.error)) throw Error(`the stopped play failed with "${outcome.error}"`)
    if (outcome.ms > 3000) throw Error(`the stopped play took ${outcome.ms} ms to settle`)
    if (player.activePlayId !== null) throw Error(`the stopped play is still owning playback (${player.activePlayId})`)
    // Install the recorder while the window still cannot hear anything, then let
    // it report ready: every command it receives from here on is recorded.
    await installRecorder(waiting)
    releaseReady()
    await eventually('the released window to report ready', () => readiness.isReady(waiting), 5000)
    const status = await player.control('status')
    if (status.state !== 'idle' || status.id !== null) throw Error(`the window is not idle after being released: ${JSON.stringify(status)}`)
    await delay(400)
    const seen = await seenNotes(waiting)
    if (seen.some(entry => entry.action === 'play')) throw Error(`the cancelled play was still sent: ${JSON.stringify(seen)}`)
    if (events.some(entry => entry.requestId === requestId)) throw Error('the cancelled play produced a renderer event')
    if (busy.isBusy()) throw Error('the cancelled play left the pill busy')
    if (seen.length !== 1 || seen[0].action !== 'status') throw Error(`the renderer received ${JSON.stringify(seen)} instead of only the status probe`)
    return `play rejected "${outcome.error}" after ${outcome.ms} ms; renderer ordered [${seen.map(entry => entry.action).join(',')}]; status=idle id=null; busy=false`
  })

  // ── R2: destroying the window a play is waiting for settles it, and a rebuild plays ──
  await step('r2-destroy-or-cancel', async () => {
    await destroyWindow()
    holdReady = true
    const play = player.control('play', 'hold')
    const settling = settleSoon('the play waiting on a window that gets destroyed', play, 6000)
    const waiting = await eventually('the window the play is waiting for', () => host.peek(), 4000)
    if (readiness.isReady(waiting)) throw Error('the window was already ready; this case needs a waiting one')
    waiting.destroy()
    const outcome = await settling
    if (outcome.ok) throw Error('the play resolved although the window it waited for was destroyed')
    if (/没有响应/.test(outcome.error)) throw Error(`the play hung until its 8 s command budget instead of failing fast: "${outcome.error}"`)
    if (outcome.ms > 5000) throw Error(`the destroyed wait took ${outcome.ms} ms to settle`)
    if (host.peek()) throw Error('the destroyed window is still reported by the sink')
    if (busy.isBusy()) throw Error('busy stayed set after the waiting window was destroyed')
    if (player.activePlayId !== null) throw Error('the destroyed play still owns playback')
    holdReady = false
    const before = windowsCreated()
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`the rebuilt window did not play: ${JSON.stringify(state)}`)
    if (windowsCreated() !== before + 1) throw Error(`expected one rebuilt window, got ${windowsCreated() - before}`)
    const started = await nextEvent(entry => entry.requestId === player.activePlayId && entry.state === 'playing', 'the rebuilt window to play', 5000, events)
    await player.control('stop')
    return `in-flight play rejected "${outcome.error}" after ${outcome.ms} ms (not the 8 s budget); rebuilt window #${windowsCreated()} played at ${started.positionMs}ms`
  })

  // ── R3: speech playback through the real renderer ─────────────────────────
  await step('r3-speech-cold-path', async () => {
    // 1) cold creation: no window at all, the runner has to wait for a real one
    await destroyWindow()
    const before = windowsCreated()
    let started = 0
    const cold = await speech(speechRequest('short'), undefined, () => { started += 1 })
    if (!cold.ok) throw Error(`the cold speech playback failed: ${cold.error}`)
    if (started !== 1) throw Error(`the started callback fired ${started} times`)
    if (windowsCreated() !== before + 1) throw Error(`expected one speech window, got ${windowsCreated() - before}`)
    const coldWindow = host.peek()
    if (!coldWindow) throw Error('the speech window disappeared')
    await installRecorder(coldWindow)
    // The `ok` above is the renderer's own `ended` reply for the synthesized WAV.

    // 2) abort before the cold window is ready: cancelled, and nothing is sent
    holdReady = true
    await destroyWindow()
    const controller = new AbortController()
    let early = 0
    const pending = speech(speechRequest('hold'), controller.signal, () => { early += 1 })
    const waiting = await eventually('the window the speech playback waits for', () => host.peek(), 4000)
    if (readiness.isReady(waiting)) throw Error('the window was already ready; this case needs a cold one')
    controller.abort()
    const cancelled = await pending
    if (cancelled.ok || cancelled.error !== 'cancelled') throw Error(`expected cancelled, got ${JSON.stringify(cancelled)}`)
    await installRecorder(waiting)
    releaseReady()
    await eventually('the released window to report ready', () => readiness.isReady(waiting), 5000)
    await delay(300)
    const seenEarly = await seenSpeech(waiting)
    if (seenEarly.some(entry => entry.action === 'play')) throw Error(`the cancelled speech was still sent: ${JSON.stringify(seenEarly)}`)
    if (early !== 0) throw Error('the cancelled speech reported started')
    const noSpeaker = await speech.control!('pause')
    if (noSpeaker.ok !== false) throw Error('something is still speaking after the cancelled playback')

    // 3) abort after it started: the renderer is told to stop
    const ctrl2 = new AbortController()
    let startedSecond = 0
    const second = speech(speechRequest('hold'), ctrl2.signal, () => { startedSecond += 1 })
    await eventually('the speech to start', () => startedSecond === 1, 6000)
    const seenSecond = await seenSpeech(waiting)
    const oldId = seenSecond.filter(entry => entry.action === 'play').at(-1)?.id
    if (!oldId) throw Error(`the renderer never received the speech play: ${JSON.stringify(seenSecond)}`)
    ctrl2.abort()
    const aborted = await second
    if (aborted.ok || aborted.error !== 'cancelled') throw Error(`expected cancelled after start, got ${JSON.stringify(aborted)}`)
    await delay(200)
    const seenStop = await seenSpeech(waiting)
    if (!seenStop.some(entry => entry.action === 'stop' && entry.id === oldId)) throw Error(`the renderer was never told to stop ${oldId.slice(0, 8)}`)

    // 4) the old id's late ended/error must not touch the playback that follows
    let startedThird = 0
    const third = speech(speechRequest('short'), undefined, () => { startedThird += 1 })
    await delay(60)
    await waiting.webContents.executeJavaScript(`window.api.bar.replySpeechPlayback(${JSON.stringify({ id: oldId, event: 'ended' })})`)
    await waiting.webContents.executeJavaScript(`window.api.bar.replySpeechPlayback(${JSON.stringify({ id: oldId, event: 'error', error: 'stale speech' })})`)
    const thirdResult = await third
    if (!thirdResult.ok) throw Error(`a stale reply killed the new speech playback: ${thirdResult.error}`)
    if (startedThird !== 1) throw Error(`the new speech started ${startedThird} times`)

    return `cold ok (started=1, window #${before + 1}); pre-ready abort=cancelled and the renderer saw no play; post-start abort=${aborted.error} with stop for ${oldId.slice(0, 8)}; new speech still ok after the old id's ended+error`
  })

  // ── R3: a real renderer crash, through the real crash path ────────────────
  await step('r3-renderer-crash', async () => {
    const target = host.peek()
    if (!target || !readiness.isReady(target)) throw Error('this case needs the ready pill')
    const webContentsId = target.webContents.id
    const before = windowsCreated()
    const mark = goneEvents.length
    // `forcefullyCrashRenderer` is Electron's own entry point for killing a
    // renderer process: the process is really gone and `render-process-gone`
    // really fires. This is not `destroy()`.
    try {
      target.webContents.forcefullyCrashRenderer()
    } catch (error) {
      throw new CaseSkipped(`the crash entry point is unavailable here: ${error instanceof Error ? error.message : String(error)}`)
    }
    const record = await eventually('render-process-gone', () => goneEvents.slice(mark).find(entry => entry.webContentsId === webContentsId), 8000)
    if (record.reason === 'clean-exit') throw Error('the renderer exited cleanly instead of crashing')
    await eventually('the dead window to be retired', () => !host.peek(), 5000)
    if (busy.isBusy()) throw Error('busy stayed set after the renderer crashed')
    if (player.activePlayId !== null) throw Error('a crashed renderer still owns playback')
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`the rebuilt window did not play: ${JSON.stringify(state)}`)
    const rebuilt = host.peek()
    if (!rebuilt) throw Error('no rebuilt window after the crash')
    if (windowsCreated() !== before + 1) throw Error(`expected one rebuilt window, got ${windowsCreated() - before}`)
    if (rebuilt.webContents.id === webContentsId) throw Error('the crashed webContents was reused')
    await player.control('stop')
    return `render-process-gone reason=${record.reason} exitCode=${record.exitCode} for wc=${webContentsId}; window retired; rebuilt window #${windowsCreated()} (wc=${rebuilt.webContents.id}) played`
  })

  await step('recreate-after-destroy', async () => {
    const before = windowsCreated()
    await destroyWindow()
    if (busy.isBusy()) throw Error('busy stayed set after the window was destroyed')
    const state = await player.control('play', 'short')
    if (state.state !== 'playing') throw Error(`expected playing on a rebuilt window, got ${state.state}`)
    if (windowsCreated() !== before + 1) throw Error(`expected one new window, got ${windowsCreated() - before}`)
    await player.control('stop')
    return `state=playing on window #${windowsCreated()}`
  })

  await step('status-without-window', async () => {
    await destroyWindow()
    const before = windowsCreated()
    const state = await player.control('status')
    if (state.state !== 'idle' || state.id !== null) throw Error(`expected idle, got ${JSON.stringify(state)}`)
    if (windowsCreated() !== before) throw Error(`status created a window (${before} -> ${windowsCreated()})`)
    return `state=idle windows=${windowsCreated()} (no window was created)`
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
    cases.push({ id: 'budget', kind: 'stub', pass: false, detail: `probe exceeded ${BUDGET_MS} ms`, ms: BUDGET_MS })
    finish()
  }, BUDGET_MS)
  try { await probe() } catch (error) { cases.push({ id: 'probe', kind: 'stub', pass: false, detail: error instanceof Error ? error.message : String(error), ms: 0 }) }
  finish()
}).catch(error => {
  cases.push({ id: 'startup', kind: 'stub', pass: false, detail: error instanceof Error ? error.message : String(error), ms: 0 })
  finish()
})
