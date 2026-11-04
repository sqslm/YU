/**
 * The Electron side of the knowledge helper.
 *
 * The helper is a plain child process on inherited pipes: no port, no socket,
 * no listening surface. This class owns its lifetime (lazy start, idle exit,
 * teardown), the frame protocol and the model callback bridge. It never parses
 * knowledge content itself — every storage rule lives in Rust.
 *
 * Two rules shape this file:
 *  - every request has one total deadline, from the call to the answer, so a
 *    helper that never becomes ready cannot hold a request forever;
 *  - every frame, timer and model answer is bound to the process generation it
 *    came from, so a late frame from a replaced helper can never settle a
 *    request, a model call or a pending table of its successor.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'

import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROTOCOL_VERSION,
  KnowledgeError,
  type CardQuery,
  type CardSearchQuery,
  type HelperFrame,
  type HostFrame,
  type KnowledgeCard,
  type KnowledgeCardPage,
  type KnowledgeMethod,
  type KnowledgeSource,
  type KnowledgeStatus,
  type ProfileItem,
  type ProfilePage,
  type SaveCardInput,
  type SaveProfileInput,
  type SaveSourceInput,
  type UpdateCardInput,
  type UpdateProfileInput
} from '@shared/knowledge'

import type { KnowledgeCompleter } from './model'

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  child: ChildProcessWithoutNullStreams
  generation: number
}

interface ModelCall {
  controller: AbortController
  parentId: string
  generation: number
}

/** The raw `status` result of a running helper. */
interface HelperStatus {
  version: number
  schema: { knowledge: number; profile: number }
  opened: boolean
  fts5: boolean
  trigram: boolean
}

export interface KnowledgeHostOptions {
  /** Absolute path of the helper executable. */
  entry: string
  /** Directory the helper appends `data/knowledge` and `data/profile` to. */
  root: string
  completer?: KnowledgeCompleter
  idleMs?: number
  requestMs?: number
  log?: (message: string) => void
  onChanged?: (scope: string) => void
  /** Test seam: replace the executable with a script run by another runtime. */
  spawn?: (entry: string, root: string) => ChildProcessWithoutNullStreams
}

const defaultSpawn: KnowledgeHostOptions['spawn'] = (entry, root) => {
  const options: SpawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  return spawn(entry, ['--root', root], options) as ChildProcessWithoutNullStreams
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class KnowledgeHost {
  private child?: ChildProcessWithoutNullStreams
  /** Bumped on every start, stop and discard; stale frames carry an older value. */
  private generation = 0
  private ready?: Promise<void>
  private readySettled = false
  private settleReady?: { resolve: () => void; reject: (error: Error) => void }
  private readonly pending = new Map<string, Pending>()
  private readonly models = new Map<string, ModelCall>()
  private counter = 0
  private idleTimer?: NodeJS.Timeout
  /**
   * Set only by `shutdown()`. An idle exit or a game-mode pause calls `stop()`,
   * which must leave the host able to start again on the next explicit request.
   */
  private closed = false

  constructor(private readonly options: KnowledgeHostOptions) {}

  /** The helper's pid, for the existing resource figures. Undefined when idle. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  get running(): boolean {
    return this.child !== undefined
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  private get requestMs(): number {
    return this.options.requestMs ?? KNOWLEDGE_LIMITS.requestMs
  }

  private get idleMs(): number {
    return this.options.idleMs ?? KNOWLEDGE_LIMITS.idleMs
  }

  /**
   * Starts the helper on the first explicit request. Constructing the host,
   * booting the app or asking about an unused feature spawns nothing.
   */
  private start(): void {
    if (this.child || this.closed) return
    this.generation += 1
    const generation = this.generation
    const child = (this.options.spawn ?? defaultSpawn)!(this.options.entry, this.options.root)
    this.child = child
    this.readySettled = false
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = { resolve, reject }
    })
    this.ready.catch(() => undefined)

    const frameError = new KnowledgeError('internal', 'the knowledge helper broke the frame protocol')
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child || this.generation !== generation) return
      buffer += chunk
      // A line that never ends must be rejected before it grows without bound.
      if (buffer.length > KNOWLEDGE_LIMITS.frame) {
        this.log('the knowledge helper wrote more than one frame without a newline')
        this.discard(child, frameError)
        return
      }
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) this.onLine(child, generation, line)
        if (this.child !== child || this.generation !== generation) return
        index = buffer.indexOf('\n')
      }
    })
    child.stdout.on('error', (error) => {
      if (this.child !== child) return
      this.log(`cannot read the knowledge helper output: ${describe(error)}`)
      this.discard(child, new KnowledgeError('internal', 'cannot read the knowledge helper output'))
    })
    // A broken pipe surfaces on stdin, not on the request that caused it.
    child.stdin.on('error', (error) => {
      this.log(`the knowledge helper pipe failed: ${describe(error)}`)
      if (this.child === child) {
        this.discard(child, new KnowledgeError('internal', 'the knowledge helper pipe failed'))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.log(`yu-knowledge: ${line.trim().slice(0, 400)}`)
      }
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.log(`cannot start the knowledge helper: ${describe(error)}`)
      this.discard(
        child,
        new KnowledgeError('internal', `cannot start the knowledge helper: ${describe(error)}`)
      )
    })
    child.on('close', (code) => {
      // A replaced process closes after its successor is already current; it must
      // not clear the new child's state or fail the new child's requests.
      if (this.child !== child) return
      if (code !== 0) this.log(`the knowledge helper exited with code ${code}`)
      this.discard(child, new KnowledgeError('internal', 'the knowledge helper stopped'))
    })
  }

  /**
   * Drops the current process: everything bound to it fails, everything it might
   * still send is ignored from now on.
   */
  private discard(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return
    this.child = undefined
    this.generation += 1
    this.ready = undefined
    this.readySettled = false
    this.settleReady?.reject(error)
    this.settleReady = undefined
    this.clearIdle()
    this.failAll(error)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }

  private onLine(child: ChildProcessWithoutNullStreams, generation: number, line: string): void {
    if (line.length > KNOWLEDGE_LIMITS.frame) {
      this.log('the knowledge helper wrote an oversized frame')
      this.discard(child, new KnowledgeError('internal', 'the knowledge helper wrote an oversized frame'))
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.log('the knowledge helper wrote a malformed frame')
      return
    }
    // `null`, arrays and scalars are not frames; they must not throw here.
    if (raw === null || typeof raw !== 'object') {
      this.log('the knowledge helper wrote a frame that is not an object')
      return
    }
    const frame = raw as HelperFrame
    // Objects without a type are not frames: ignore them instead of treating a
    // stray value as a protocol mismatch and tearing down a healthy helper.
    if (typeof (raw as { type?: unknown }).type !== 'string') {
      this.log('the knowledge helper wrote an object without a frame type')
      return
    }
    if (frame.v !== KNOWLEDGE_PROTOCOL_VERSION) {
      this.log(`the knowledge helper speaks protocol ${String(frame.v)}`)
      void this.stop()
      return
    }
    switch (frame.type) {
      case 'ready':
        if (this.child !== child || this.generation !== generation) return
        this.readySettled = true
        this.settleReady?.resolve()
        this.settleReady = undefined
        this.armIdle()
        return
      case 'changed':
        if (this.child !== child || this.generation !== generation) return
        this.options.onChanged?.(frame.scope)
        return
      case 'result': {
        const entry = this.pending.get(frame.id)
        if (!entry || entry.child !== child || entry.generation !== generation) return
        this.pending.delete(frame.id)
        clearTimeout(entry.timer)
        this.abortModelsOf(frame.id, generation)
        if (frame.ok) entry.resolve(frame.result)
        else entry.reject(new KnowledgeError(frame.error.code, frame.error.message))
        this.armIdle()
        return
      }
      case 'model.request':
        void this.answerModel(child, generation, frame)
        return
      default:
        this.log('the knowledge helper sent an unknown frame')
    }
  }

  private writeTo(child: ChildProcessWithoutNullStreams, frame: HostFrame): void {
    if (this.child !== child) throw new KnowledgeError('cancelled', 'the knowledge helper was stopped')
    if (!child.stdin.writable) throw new KnowledgeError('internal', 'the knowledge helper is not running')
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private rejectPending(id: string, error: Error): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.abortModelsOf(id, entry.generation)
    entry.reject(error)
  }

  /** Stops every model call a finished request had started. */
  private abortModelsOf(parentId: string, generation: number): void {
    for (const [id, call] of this.models) {
      if (call.parentId !== parentId || call.generation !== generation) continue
      this.models.delete(id)
      call.controller.abort()
    }
  }

  private async answerModel(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    frame: Extract<HelperFrame, { type: 'model.request' }>
  ): Promise<void> {
    const parent = this.pending.get(frame.parentId)
    // No in-flight parent, an old process, or a reused sub id: no model call, no
    // write, no mapping — the helper's own deadline handles the silence.
    if (!parent || parent.child !== child || parent.generation !== generation) {
      this.log('dropped a model request whose parent is not in flight')
      return
    }
    if (this.models.has(frame.id)) {
      this.log(`dropped a duplicate model request ${frame.id}`)
      return
    }
    const controller = new AbortController()
    this.models.set(frame.id, { controller, parentId: frame.parentId, generation })
    const current = (): boolean =>
      this.child === child && this.generation === generation && !controller.signal.aborted
    try {
      const completer = this.options.completer
      if (!completer) throw new KnowledgeError('model_unavailable', 'no model bridge is configured')
      const messages = Array.isArray(frame.messages) ? frame.messages : []
      if (messages.length === 0 || messages.length > 64) {
        throw new KnowledgeError('invalid_params', 'a model callback must carry 1..64 messages')
      }
      const text = await completer({
        profileId: frame.profileId,
        effort: frame.effort || 'high',
        messages,
        maxTokens: frame.maxTokens ?? undefined,
        signal: controller.signal
      })
      if (!current()) return
      this.writeTo(child, { v: KNOWLEDGE_PROTOCOL_VERSION, type: 'model.result', id: frame.id, ok: true, text })
    } catch (error) {
      if (!current()) return
      const code = error instanceof KnowledgeError ? error.code : 'model_unavailable'
      try {
        this.writeTo(child, {
          v: KNOWLEDGE_PROTOCOL_VERSION,
          type: 'model.result',
          id: frame.id,
          ok: false,
          error: { code, message: describe(error).slice(0, 300) }
        })
      } catch {
        // The pipe is gone; the close handler already settles the request.
      }
    } finally {
      if (this.models.get(frame.id)?.controller === controller) this.models.delete(frame.id)
      this.armIdle()
    }
  }

  /**
   * One deadline covers the whole call: spawn, the ready handshake and the
   * request itself. It is never restarted when the helper becomes ready.
   */
  private call<T>(method: KnowledgeMethod, params: unknown, timeoutMs = this.requestMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new KnowledgeError('internal', 'the knowledge helper is shutting down'))
    }
    this.start()
    const child = this.child
    const generation = this.generation
    const ready = this.ready
    if (!child || !ready) {
      return Promise.reject(new KnowledgeError('internal', 'the knowledge helper is not running'))
    }
    const id = `r${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        this.abortModelsOf(id, generation)
        if (this.child === child) {
          try {
            this.writeTo(child, { v: KNOWLEDGE_PROTOCOL_VERSION, type: 'cancel', id })
          } catch {
            // The pipe is already gone; the close handler fails the request.
          }
        }
        reject(new KnowledgeError('timeout', `${method} did not answer within ${timeoutMs} ms`))
        // A helper that never became ready is unusable: tear it down so the next
        // explicit request starts a fresh process instead of queueing forever.
        if (!this.readySettled && this.pending.size === 0) void this.stop()
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        child,
        generation
      })
      ready.then(
        () => {
          if (!this.pending.has(id)) return
          // A stop that landed while this request waited for `ready` must fail it
          // as cancelled instead of letting it write into a dead pipe.
          if (this.child !== child || this.generation !== generation) {
            this.rejectPending(id, new KnowledgeError('cancelled', 'the knowledge helper was stopped'))
            return
          }
          try {
            this.writeTo(child, { v: KNOWLEDGE_PROTOCOL_VERSION, type: 'request', id, method, params })
          } catch (error) {
            this.rejectPending(id, error instanceof Error ? error : new Error(describe(error)))
          }
        },
        (error: unknown) => {
          this.rejectPending(id, error instanceof Error ? error : new Error(describe(error)))
        }
      )
    })
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    for (const [id, call] of this.models) {
      this.models.delete(id)
      call.controller.abort()
    }
  }

  /** The helper leaves on its own after the idle window; the next request respawns it. */
  private armIdle(): void {
    this.clearIdle()
    if (this.closed) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0 || this.models.size > 0) {
        this.armIdle()
        return
      }
      void this.stop()
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Stops the helper and fails every request in flight. Safe to call twice. */
  async stop(): Promise<void> {
    this.clearIdle()
    const child = this.child
    this.child = undefined
    this.generation += 1
    this.ready = undefined
    this.readySettled = false
    this.settleReady?.reject(new KnowledgeError('cancelled', 'the knowledge helper was stopped'))
    this.settleReady = undefined
    this.failAll(new KnowledgeError('cancelled', 'the knowledge helper was stopped'))
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2_000)
      done.unref?.()
      child.once('close', () => {
        clearTimeout(done)
        resolve()
      })
      child.kill()
    })
  }

  /** Application quit: stop now and never start again. */
  async shutdown(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  /**
   * Reports what is known without starting anything: a host that never ran the
   * helper has no probed capabilities to report, so they stay `null` instead of
   * being guessed. A running helper answers with its measured values.
   */
  async status(): Promise<KnowledgeStatus> {
    if (!this.child) {
      return {
        version: KNOWLEDGE_PROTOCOL_VERSION,
        running: false,
        schema: null,
        opened: false,
        fts5: null,
        trigram: null
      }
    }
    const live = await this.call<HelperStatus>('status', {})
    return {
      version: live.version,
      running: true,
      schema: live.schema,
      opened: live.opened,
      fts5: live.fts5,
      trigram: live.trigram
    }
  }

  saveSource(input: SaveSourceInput): Promise<KnowledgeSource> {
    return this.call<KnowledgeSource>('source.save', input)
  }

  getSource(id: string): Promise<KnowledgeSource> {
    return this.call<KnowledgeSource>('source.get', { id })
  }

  invalidateSource(id: string, reason?: string): Promise<KnowledgeSource> {
    return this.call<KnowledgeSource>('source.invalidate', { id, reason })
  }

  saveCard(input: SaveCardInput): Promise<KnowledgeCard> {
    return this.call<KnowledgeCard>('card.save', input)
  }

  updateCard(input: UpdateCardInput): Promise<KnowledgeCard> {
    return this.call<KnowledgeCard>('card.update', input)
  }

  getCard(id: string): Promise<KnowledgeCard> {
    return this.call<KnowledgeCard>('card.get', { id })
  }

  deleteCard(id: string): Promise<{ removed: boolean }> {
    return this.call<{ removed: boolean }>('card.delete', { id })
  }

  listCards(query: CardQuery = {}): Promise<KnowledgeCardPage> {
    return this.call<KnowledgeCardPage>('card.list', query)
  }

  searchCards(query: CardSearchQuery): Promise<KnowledgeCardPage> {
    return this.call<KnowledgeCardPage>('card.search', query)
  }

  saveProfile(input: SaveProfileInput): Promise<ProfileItem> {
    return this.call<ProfileItem>('profile.save', input)
  }

  updateProfile(input: UpdateProfileInput): Promise<ProfileItem> {
    return this.call<ProfileItem>('profile.update', input)
  }

  getProfile(id: string): Promise<ProfileItem> {
    return this.call<ProfileItem>('profile.get', { id })
  }

  deleteProfile(id: string): Promise<{ removed: boolean }> {
    return this.call<{ removed: boolean }>('profile.delete', { id })
  }

  listProfiles(query: CardQuery = {}): Promise<ProfilePage> {
    return this.call<ProfilePage>('profile.list', query)
  }
}
