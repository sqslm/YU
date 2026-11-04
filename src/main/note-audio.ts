import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { handle } from './ipc-trust'
import type { NoteAudioAction, NoteAudioEvent, NoteAudioReply, NoteAudioRequest, NoteAudioState } from '@shared/noteAudio'

/**
 * Where the pill can be reached.
 *
 * `peek` must never create the window: a status query, a pause or a late reply
 * has no business resurrecting a window that was just retired. `ensure` may
 * create it, but only resolves once that window's renderer is listening for
 * `note-audio:command` — sending earlier loses the command outright. Its signal
 * is the calling command's own cancellation, so a command that was stopped or
 * replaced stops waiting for a window instead of holding listeners on one.
 */
export interface NoteAudioHost {
  peek: () => BrowserWindow | null
  /**
   * Whether that exact window is listening yet. A window that exists but has not
   * announced `bar:ready` drops everything sent to it, so a command that can be
   * answered from the preparation state must not be sent there.
   */
  ready?: (win: BrowserWindow) => boolean
  ensure: (signal?: AbortSignal) => Promise<BrowserWindow | null>
}

const IDLE: NoteAudioState = { id: null, state: 'idle', positionMs: 0, durationMs: 0, rate: 1 }
const COMMAND_TIMEOUT_MS = 8000
/** Actions the renderer can only answer once it is actually listening. */
const NEEDS_WINDOW = new Set<NoteAudioAction>(['play', 'resume', 'seek', 'rate'])
const ACTIONS = new Set<NoteAudioAction>(['play', 'pause', 'resume', 'stop', 'status', 'seek', 'rate'])
const SUPERSEDED = 'Playback superseded'
const CANCELLED = 'Playback cancelled'

interface Pending {
  /** The play generation this command belongs to; older commands may not speak for newer ones. */
  gen: number
  /** What was asked. `status` is a query: it owns nothing and may not be cancelled. */
  action: NoteAudioAction
  /** True once the command actually reached the renderer. */
  sent: boolean
  resolve: (state: NoteAudioState) => void
  reject: (error: Error) => void
  abort: (error: Error) => void
}

/** One player in the existing bar renderer, shared by the notes page and voice tools. */
export class NoteAudioPlayer {
  private pending = new Map<string, Pending>()
  private playId: string | null = null
  /** The last window a command was actually sent to; its replies are still ours. */
  private asked: BrowserWindow | null = null
  /** Bumped by every `play`: a reply tagged with an older generation is stale. */
  private gen = 0
  constructor(private host: NoteAudioHost, private audioUrl: (id: string) => string | null, private onState?: (state: NoteAudioState) => void, private log?: (line: string) => void) {}

  /** The `play` command the pill currently owes; events for any other one are stale. */
  get activePlayId(): string | null { return this.playId }

  register(): void {
    handle('note-audio:control', (_event, action: NoteAudioAction, id?: string, options?: { positionMs?: number; rate?: number }) => this.control(action, id, options))
    handle('note-audio:reply', (event, reply: NoteAudioReply) => this.receive(event, reply))
  }

  /**
   * A reply may only settle a command that is still owed an answer — and only
   * move the playback state when it speaks for the newest play. Anything else is
   * a leftover: a timeout, a replaced play, or a renderer from a window that no
   * longer owns playback.
   */
  private receive(event: { sender: unknown }, reply: NoteAudioReply): void {
    if (!reply || typeof reply.requestId !== 'string') return
    // Replies come from whichever window holds playback at that moment, and only
    // `peek` may answer that: asking the sink here used to recreate the pill
    // whenever a late reply arrived after retirement. A window this player has
    // already sent to counts as its own even if `peek` no longer reports it —
    // it is still the renderer that was asked.
    const owner = this.replyWindow()
    if (!owner || event.sender !== owner.webContents) { this.log?.('[note-audio] ignored a reply from a window that does not own playback'); return }
    const pending = this.pending.get(reply.requestId)
    // The command is settled (timeout, cancellation, replacement) or was never
    // issued here: a late reply from the same renderer must not resolve anything
    // and must not touch the busy flag, or a replaced playback releases the pill
    // that replaced it.
    if (!pending) return
    if (reply.error) { pending.reject(new Error(reply.error)); return }
    if (!reply.state) { pending.reject(new Error('Invalid playback reply')); return }
    // Playback the page drives on its own reports through `note-audio:event`,
    // which is already tagged with the play that owns it; a reply is a snapshot
    // of the command, so only the newest play may pass it on.
    if (pending.gen >= this.gen) this.onState?.(reply.state)
    pending.resolve(reply.state)
  }

  /**
   * Events the renderer reports on its own (real `playing`/`paused`/`ended`/
   * `error`/`stop`). Only the play that is currently owned may move the busy
   * flag, so a late `ended` from a replaced playback cannot release the new one.
   */
  acceptEvent(event: NoteAudioEvent | null | undefined): NoteAudioEvent | null {
    if (!event || typeof event.requestId !== 'string') return null
    if (!this.playId || event.requestId !== this.playId) return null
    return event
  }

  async control(action: NoteAudioAction, id?: string, options: { positionMs?: number; rate?: number } = {}): Promise<NoteAudioState> {
    if (!ACTIONS.has(action)) throw Error('Invalid playback action')
    if (options.positionMs !== undefined && (!Number.isFinite(options.positionMs) || options.positionMs < 0)) throw Error('Invalid playback position')
    if (options.rate !== undefined && (!Number.isFinite(options.rate) || options.rate < 0.5 || options.rate > 3)) throw Error('Playback rate must be 0.5-3')
    const url = action === 'play' && id ? this.audioUrl(id) : undefined
    if (action === 'play' && !url) throw Error('随记没有可播放的录音')

    const requestId = randomUUID()
    if (action === 'play') {
      // The newest effective play wins: the previous generation is dropped
      // *before* this one is issued, so the page can only ever be told about the
      // last of them. The whole generation goes with it — a resume/seek/rate that
      // was still waiting for the pill used to survive the replacement and be
      // delivered once that window became ready.
      this.gen += 1
      this.cancelBefore(this.gen, SUPERSEDED)
      this.playId = requestId
    }
    const win = this.window()
    if (!win && !NEEDS_WINDOW.has(action)) {
      // Nothing can hear this command, and a page that never received anything
      // would only spend the whole budget here. A paused or stopped request must
      // not start playing later on its own, so it ends the commands that were
      // still being prepared — a query must not: `status` only reports.
      this.cancelPending(action)
      return { ...IDLE }
    }
    // A command that has not reached the renderer yet would start *after* this
    // one: cancel it so the page's command order stays honest. `stop` also drops
    // an already queued one; the page is told to stop rather than to pause.
    this.cancelPending(action)

    const request: NoteAudioRequest = { requestId, action, id, ...options, ...(url ? { url } : {}) }
    return await this.issue(request, NEEDS_WINDOW.has(action))
  }

  /**
   * What a `pause` or `stop` interrupts.
   *
   * A `pause` only drops the commands the renderer has not received yet: a
   * resume that is still waiting for the pill must not resume playback after it,
   * while a playback that already started keeps its recording, position and rate
   * so it can be resumed.
   *
   * A `stop` ends the generation: the play *and* every resume/seek/rate that was
   * still preparing belong to it, so each settles now instead of arriving after
   * the stop. A `status` is a query and cancels nothing.
   */
  private cancelPending(action: NoteAudioAction): void {
    if (action === 'pause') { this.cancelUnsent(CANCELLED); return }
    if (action !== 'stop') return
    this.gen += 1
    this.cancelBefore(this.gen, CANCELLED)
    this.playId = null
  }

  /** Cancel every command of a generation older than `gen` — the whole exchange. */
  private cancelBefore(gen: number, error: string): void {
    for (const pending of [...this.pending.values()]) {
      // A query only reports what the page sees and never owns playback; let its
      // answer come back instead of rejecting a read.
      if (pending.action === 'status' || pending.gen >= gen) continue
      pending.abort(new Error(error))
    }
  }

  /** Cancel the commands the renderer has not received yet. */
  private cancelUnsent(error: string): void {
    for (const pending of [...this.pending.values()]) {
      if (!pending.sent) pending.abort(new Error(error))
    }
  }

  private issue(request: NoteAudioRequest, needsWindow: boolean): Promise<NoteAudioState> {
    return new Promise<NoteAudioState>((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const finish = (error?: Error, state?: NoteAudioState): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        // The window wait belongs to this command: ending the command has to end
        // that wait too, or it stays attached to a window nobody asks about.
        controller.abort()
        if (!error) { resolve(state as NoteAudioState); return }
        if (this.playId === request.requestId) this.playId = null
        reject(error)
      }
      // One budget covers creation, readiness and the reply. Waiting for the
      // window is part of the command, so it may not be given extra time.
      const timer = setTimeout(() => finish(new Error('录音播放没有响应')), COMMAND_TIMEOUT_MS)
      this.pending.set(request.requestId, {
        gen: this.gen,
        action: request.action,
        sent: false,
        resolve: state => finish(undefined, state),
        reject: error => finish(error),
        abort: error => finish(error)
      })
      // A query or a stop goes to the window that exists right now (`win` was
      // already checked above); only the actions that need a listening renderer
      // may create one.
      const deliver = (target: BrowserWindow | null): void => {
        const pending = this.pending.get(request.requestId)
        // Replaced, stopped or timed out while the pill was still starting: the
        // command is gone and must not be sent to the renderer.
        if (!pending) return
        // A generation that lost ownership owns nothing either: a window that
        // becomes ready late must not receive the command it was discarded with.
        if (pending.gen < this.gen) { finish(new Error(SUPERSEDED)); return }
        if (!target || target.isDestroyed()) { finish(new Error('录音播放服务尚未就绪')); return }
        pending.sent = true
        this.asked = target
        target.webContents.send('note-audio:command', request)
      }
      if (!needsWindow) { deliver(this.window()); return }
      void this.host.ensure(controller.signal).then(
        deliver,
        error => finish(error instanceof Error ? error : new Error(String(error)))
      )
    })
  }

  /** The window that can hear commands right now, or null. Never creates one. */
  private window(): BrowserWindow | null {
    const win = this.host.peek()
    if (!win || win.isDestroyed()) return null
    if (this.host.ready && !this.host.ready(win)) return null
    return win
  }

  /** The renderer a reply may come from: the current pill, else the last one asked. */
  private replyWindow(): BrowserWindow | null {
    const win = this.host.peek()
    if (win && !win.isDestroyed()) return win
    const asked = this.asked
    return asked && !asked.isDestroyed() ? asked : null
  }

  dispose(): void {
    for (const pending of [...this.pending.values()]) pending.reject(new Error('Playback closed'))
    this.playId = null
    this.asked = null
  }
}
