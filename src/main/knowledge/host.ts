/**
 * The Electron side of the knowledge helper.
 *
 * The helper is a plain child process on inherited pipes: no port, no socket,
 * no listening surface. This class owns its lifetime (lazy start, idle exit,
 * teardown), the frame protocol and the model callback bridge. It never parses
 * knowledge content itself — every storage rule lives in Rust.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { createInterface } from 'node:readline'

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
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
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
  private ready?: Promise<void>
  private settleReady?: { resolve: () => void; reject: (error: Error) => void }
  private readonly pending = new Map<string, Pending>()
  private readonly models = new Map<string, AbortController>()
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
    const child = (this.options.spawn ?? defaultSpawn)!(this.options.entry, this.options.root)
    this.child = child
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = { resolve, reject }
    })
    const failure = new KnowledgeError('internal', 'the knowledge helper stopped')
    this.ready.catch(() => undefined)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.onLine(line, failure))
    lines.on('close', () => undefined)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.log(`yu-knowledge: ${line.trim().slice(0, 400)}`)
      }
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.log(`cannot start the knowledge helper: ${describe(error)}`)
      this.settleReady?.reject(
        new KnowledgeError('internal', `cannot start the knowledge helper: ${describe(error)}`)
      )
      this.settleReady = undefined
      this.failAll(failure)
      this.child = undefined
    })
    child.on('close', (code) => {
      lines.close()
      // A replaced process closes after its successor is already current; it must
      // not clear the new child's state or fail the new child's requests.
      if (this.child !== child) return
      this.child = undefined
      this.ready = undefined
      this.settleReady?.reject(failure)
      this.settleReady = undefined
      this.clearIdle()
      for (const controller of this.models.values()) controller.abort()
      this.models.clear()
      this.failAll(failure)
      if (code !== 0) this.log(`the knowledge helper exited with code ${code}`)
    })
  }

  private onLine(line: string, failure: KnowledgeError): void {
    if (line.length > KNOWLEDGE_LIMITS.frame) {
      this.log('the knowledge helper wrote an oversized frame')
      this.failAll(failure)
      return
    }
    let frame: HelperFrame
    try {
      frame = JSON.parse(line) as HelperFrame
    } catch {
      this.log('the knowledge helper wrote a malformed frame')
      return
    }
    if (frame.v !== KNOWLEDGE_PROTOCOL_VERSION) {
      this.log(`the knowledge helper speaks protocol ${String(frame.v)}`)
      void this.stop()
      return
    }
    switch (frame.type) {
      case 'ready':
        this.settleReady?.resolve()
        this.settleReady = undefined
        return
      case 'changed':
        this.options.onChanged?.(frame.scope)
        return
      case 'result': {
        const pending = this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve(frame.result)
        else pending.reject(new KnowledgeError(frame.error.code, frame.error.message))
        this.armIdle()
        return
      }
      case 'model.request':
        void this.answerModel(frame)
        return
      default:
        this.log('the knowledge helper sent an unknown frame')
    }
  }

  private write(frame: HostFrame): void {
    const child = this.child
    if (!child?.stdin.writable) throw new KnowledgeError('internal', 'the knowledge helper is not running')
    child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private async answerModel(frame: Extract<HelperFrame, { type: 'model.request' }>): Promise<void> {
    const controller = new AbortController()
    this.models.set(frame.id, controller)
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
      if (controller.signal.aborted) return
      this.write({ v: KNOWLEDGE_PROTOCOL_VERSION, type: 'model.result', id: frame.id, ok: true, text })
    } catch (error) {
      if (controller.signal.aborted) return
      const code = error instanceof KnowledgeError ? error.code : 'model_unavailable'
      this.write({
        v: KNOWLEDGE_PROTOCOL_VERSION,
        type: 'model.result',
        id: frame.id,
        ok: false,
        error: { code, message: describe(error).slice(0, 300) }
      })
    } finally {
      this.models.delete(frame.id)
      this.armIdle()
    }
  }

  private async call<T>(method: KnowledgeMethod, params: unknown, timeoutMs = this.requestMs): Promise<T> {
    this.start()
    const child = this.child
    const ready = this.ready
    if (!child || !ready) throw new KnowledgeError('internal', 'the knowledge helper is not running')
    await ready
    // A stop that lands while this request was waiting for `ready` must fail it
    // as cancelled instead of letting it write into a dead pipe.
    if (this.child !== child) throw new KnowledgeError('cancelled', 'the knowledge helper was stopped')
    const id = `r${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        try {
          this.write({ v: KNOWLEDGE_PROTOCOL_VERSION, type: 'cancel', id })
        } catch {
          // The pipe is already gone; the close handler fails the request.
        }
        reject(new KnowledgeError('timeout', `${method} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.write({ v: KNOWLEDGE_PROTOCOL_VERSION, type: 'request', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(describe(error)))
      }
    })
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
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
    this.ready = undefined
    this.settleReady?.reject(new KnowledgeError('cancelled', 'the knowledge helper was stopped'))
    this.settleReady = undefined
    this.failAll(new KnowledgeError('cancelled', 'the knowledge helper was stopped'))
    for (const controller of this.models.values()) controller.abort()
    this.models.clear()
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

  status(): Promise<KnowledgeStatus> {
    return this.call<KnowledgeStatus>('status', {})
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
