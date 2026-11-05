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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
  type KnowledgeErrorCode,
  type KnowledgeSource,
  type KnowledgeStatus,
  type CollectChannels,
  type ExclusionEntry,
  type ExtractFailInput,
  type ExtractSourceQuery,
  type ExtractSourceResult,
  type AcceptedSuggestion,
  type KnowledgeSuggestion,
  type RejectedSuggestion,
  type SuggestionPage,
  type ProfileConfigureInput,
  type ProfileContext,
  type ProfileEvidenceInput,
  type ProfileLearnFailInput,
  type ProfileLearnRunInput,
  type ProfileNext,
  type ProfileStatus,
  type ExtractNext,
  type ExtractOutcome,
  type ExtractRunInput,
  type HistoryJob,
  type PublishInput,
  type PublishResult,
  type ProfileItem,
  type ProfilePage,
  type QueueItemPage,
  type QueuePage,
  type QueueStatus,
  type SaveCardInput,
  type SaveProfileInput,
  type SaveSourceInput,
  type UpdateCardInput,
  type UpdateProfileInput,
  type AddRelationInput,
  type CardExport,
  type CardRevisions,
  type GraphQuery,
  type KnowledgeGraph,
  type KnowledgeRelation,
  type MergeCardsInput,
  type MergedCards,
  type RelationList,
  type TopicList,
  type CardImpact,
  type PurgeCardsInput,
  type PurgeCardsResult,
  type SourceCardsQuery,
  type FindSourceInput,
  type FoundSource
} from '@shared/knowledge'

import type { KnowledgeCompleter } from './model'
import type { SourceIdentity, TaskRefusal, TaskTarget } from '@shared/knowledge'

export type { TaskTarget, TaskRefusal } from '@shared/knowledge'


interface Pending {
  method: KnowledgeMethod
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

const NEWLINE = 0x0a

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `ready` frame carries the schema versions and the probing results. */
function readReady(frame: Record<string, unknown>): HelperStatus['schema'] | undefined {
  const schema = frame.schema
  if (!isRecord(schema)) return undefined
  const { knowledge, profile } = schema
  if (typeof knowledge !== 'number' || typeof profile !== 'number') return undefined
  if (typeof frame.fts5 !== 'boolean' || typeof frame.trigram !== 'boolean') return undefined
  return { knowledge, profile }
}

/** A failed result must carry a usable error; a broken one is not a result. */
function readFailure(
  frame: Record<string, unknown>
): { code: KnowledgeErrorCode; message: string } | undefined {
  const error = frame.error
  if (!isRecord(error)) return undefined
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined
  return { code: error.code as KnowledgeErrorCode, message: error.message }
}

/**
 * Requests that own a model call. Cancelling one of these must not touch a plain
 * CRUD call, and the two modules cancel only their own: closing the profile never
 * aborts an extraction batch.
 */
const LONG_RUNNING = new Set<KnowledgeMethod>(['extract.run', 'profile.learn.run'])

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

  /**
   * Whether a profile database already exists on disk. A withdrawal still has to be
   * applied while the switch is closed, but it must not create the database itself.
   */
  /** True when a knowledge database exists, even with the loop switched off. */
  hasData(): boolean { return existsSync(join(this.options.root, 'data', 'knowledge', 'knowledge.db')) }

  hasProfileData(): boolean {
    return existsSync(join(this.options.root, 'data', 'profile', 'profile.db'))
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

    const oversizeError = new KnowledgeError('internal', 'the knowledge helper wrote an oversized frame')
    // The transport limit is two megabytes of UTF-8, so the frames are split on
    // raw bytes and only decoded once a frame is complete: a string length is a
    // character count, and Chinese text would slip past the limit.
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child || this.generation !== generation) return
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      let index = buffer.indexOf(NEWLINE)
      while (index >= 0) {
        const line = buffer.subarray(0, index)
        buffer = buffer.subarray(index + 1)
        if (line.length > KNOWLEDGE_LIMITS.frame) {
          this.log('the knowledge helper wrote an oversized frame')
          this.discard(child, oversizeError)
          return
        }
        if (line.length > 0) this.onLine(child, generation, line.toString('utf8'))
        if (this.child !== child || this.generation !== generation) return
        index = buffer.indexOf(NEWLINE)
      }
      // No newline left: the helper is accumulating one frame. Refuse before the
      // buffer grows without bound, even if that frame never ends.
      if (buffer.length > KNOWLEDGE_LIMITS.frame) {
        this.log('the knowledge helper wrote more than one frame without a newline')
        this.discard(child, oversizeError)
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
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.log('the knowledge helper wrote a malformed frame')
      return
    }
    // `null`, arrays and scalars are not frames; they must not throw here.
    if (!isRecord(raw)) {
      this.log('the knowledge helper wrote a frame that is not an object')
      return
    }
    const frame = raw as unknown as HelperFrame
    // Objects without a type are not frames: ignore them instead of treating a
    // stray value as a protocol mismatch and tearing down a healthy helper.
    if (typeof raw.type !== 'string') {
      this.log('the knowledge helper wrote an object without a frame type')
      return
    }
    if (frame.v !== KNOWLEDGE_PROTOCOL_VERSION) {
      this.log(`the knowledge helper speaks protocol ${String(frame.v)}`)
      void this.stop()
      return
    }
    switch (frame.type) {
      case 'ready': {
        if (this.child !== child || this.generation !== generation) return
        const schema = readReady(raw)
        if (!schema) {
          this.log('the knowledge helper wrote an unusable ready frame')
          this.discard(child, new KnowledgeError('internal', 'the knowledge helper wrote an unusable ready frame'))
          return
        }
        this.readySettled = true
        this.settleReady?.resolve()
        this.settleReady = undefined
        this.armIdle()
        return
      }
      case 'changed':
        if (this.child !== child || this.generation !== generation) return
        if (typeof (raw as { scope?: unknown }).scope !== 'string') {
          this.log('the knowledge helper wrote a change notification without a scope')
          return
        }
        this.options.onChanged?.(frame.scope)
        return
      case 'result': {
        const id = (raw as { id?: unknown }).id
        if (typeof id !== 'string') {
          this.log('the knowledge helper wrote a result without a request id')
          return
        }
        const entry = this.pending.get(id)
        if (!entry || entry.child !== child || entry.generation !== generation) return
        // Validate the envelope before touching the pending entry: a broken
        // failure frame used to throw after the request was already removed.
        if (typeof (raw as { ok?: unknown }).ok !== 'boolean') {
          this.protocolBreak(child, id, entry, 'a result without an ok flag')
          return
        }
        if (raw.ok === false) {
          const failure = readFailure(raw)
          if (!failure) {
            this.protocolBreak(child, id, entry, 'a failure without a usable error')
            return
          }
          this.settle(id, entry)
          entry.reject(new KnowledgeError(failure.code, failure.message))
          return
        }
        this.settle(id, entry)
        entry.resolve((raw as { result?: unknown }).result)
        return
      }
      case 'model.request':
        if (
          typeof (raw as { id?: unknown }).id !== 'string' ||
          typeof (raw as { parentId?: unknown }).parentId !== 'string' ||
          !Array.isArray((raw as { messages?: unknown }).messages)
        ) {
          this.log('the knowledge helper wrote an unusable model request')
          return
        }
        void this.answerModel(child, generation, frame)
        return
      default:
        this.log('the knowledge helper sent an unknown frame')
    }
  }

  /** Removes one pending request and the model calls it owned. */
  private settle(id: string, entry: Pending): void {
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.abortModelsOf(id, entry.generation)
    this.armIdle()
  }

  /**
   * A frame that cannot be understood makes the whole stream untrustworthy: the
   * matched request fails with a bounded error and the process is replaced.
   */
  private protocolBreak(
    child: ChildProcessWithoutNullStreams,
    id: string,
    entry: Pending,
    what: string
  ): void {
    this.log(`the knowledge helper wrote ${what}`)
    const error = new KnowledgeError('internal', `the knowledge helper wrote ${what}`)
    this.settle(id, entry)
    entry.reject(error)
    this.discard(child, error)
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

  /**
   * Fails the batch that is waiting for a provider. The helper is told to stop too,
   * so a late answer cannot be written; the claim is released by the caller through
   * `extract.fail`.
   */
  cancelInFlight(reason = 'the request was cancelled', only?: KnowledgeMethod): number {
    let cancelled = 0
    for (const [id, entry] of [...this.pending]) {
      if (only ? entry.method !== only : !LONG_RUNNING.has(entry.method)) continue
      try {
        this.writeTo(entry.child, { v: KNOWLEDGE_PROTOCOL_VERSION, type: 'cancel', id })
      } catch {
        // The pipe is already gone; the close handler fails the request.
      }
      this.rejectPending(id, new KnowledgeError('cancelled', reason))
      cancelled += 1
    }
    return cancelled
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

  /** Cards generated from one original record, paged and sorted by the store. */
  /**
   * Cards one record produced.
   *
   * A detail page only knows the record, so the record identity is translated
   * here: the helper answers by source id, or by the channel and origin the
   * record published under.
   */
  cardsBySource(query: SourceCardsQuery): Promise<KnowledgeCardPage> {
    const { sourceId, noteId, threadId, ...rest } = query
    if (noteId) return this.call<KnowledgeCardPage>('card.by_source', { channel: 'note', originRef: noteId, ...rest })
    if (threadId) return this.call<KnowledgeCardPage>('card.by_source', { channel: 'chat', groupKey: threadId, ...rest })
    return this.call<KnowledgeCardPage>('card.by_source', { sourceId, ...rest })
  }

  /** The sources a record already published; empty when it published none. */
  findSources(input: FindSourceInput): Promise<FoundSource> {
    return this.call<FoundSource>('source.find', input)
  }

  /** What deleting this record would do to the cards derived from it. */
  cardImpact(identity: string | SourceIdentity): Promise<CardImpact> {
    // One call for the whole record: the helper resolves every source of it, so
    // the preview and the purge that follows agree on the same numbers.
    return this.call<CardImpact>('card.impact', typeof identity === 'string' ? { sourceId: identity } : identity)
  }

  /** Removes or unlinks the cards of records that were just deleted, atomically. */
  /** The helper takes the record identity, the confirmed snapshot and the ticket. */
  purgeCards(input: PurgeCardsInput): Promise<PurgeCardsResult> {
    return this.call<PurgeCardsResult>('card.purge', { ...input.record, confirm: input.confirm, cards: input.cards })
  }

  listTopics(limit?: number): Promise<TopicList> {
    return this.call<TopicList>('topic.list', { limit })
  }

  cardRevisions(id: string, limit?: number): Promise<CardRevisions> {
    return this.call<CardRevisions>('card.revisions', { id, limit })
  }

  mergeCards(input: MergeCardsInput): Promise<MergedCards> {
    return this.call<MergedCards>('card.merge', input)
  }

  exportCard(id: string): Promise<CardExport> {
    return this.call<CardExport>('card.export', { id })
  }

  addRelation(input: AddRelationInput): Promise<KnowledgeRelation> {
    return this.call<KnowledgeRelation>('relation.add', input)
  }

  removeRelation(id: string): Promise<{ removed: boolean }> {
    return this.call<{ removed: boolean }>('relation.remove', { id })
  }

  listRelations(cardId: string, limit?: number): Promise<RelationList> {
    return this.call<RelationList>('relation.list', { cardId, limit })
  }

  queryGraph(query: GraphQuery = {}): Promise<KnowledgeGraph> {
    return this.call<KnowledgeGraph>('graph.query', query)
  }

  /**
   * Re-queues one stored source for extraction; the helper owns every check.
   * The caller states what it read, so a stale body is refused before the
   * helper resets that version's progress.
   */
  extractSource(query: ExtractSourceQuery): Promise<ExtractSourceResult> {
    return this.call<ExtractSourceResult>('queue.extract', query)
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
  // ---------------------------------------------------------------- stage 2

  configureCollect(input: {
    enabled?: boolean
    notes?: boolean
    chat?: boolean
    reading?: boolean
    paused?: { manual?: boolean; game?: boolean }
  }): Promise<CollectChannels> {
    return this.call<CollectChannels>('collect.configure', input)
  }

  pauseCollect(reason: 'manual' | 'game', paused: boolean): Promise<CollectChannels> {
    return this.call<CollectChannels>('queue.pause', { reason, paused })
  }

  publishSource(input: PublishInput): Promise<PublishResult> {
    return this.call<PublishResult>('source.publish', input)
  }

  listQueue(query: { state?: string; offset?: number; limit?: number } = {}): Promise<QueuePage> {
    return this.call<QueuePage>('queue.list', query)
  }

  queueStatus(): Promise<QueueStatus> {
    return this.call<QueueStatus>('queue.status', {})
  }

  /** A task is addressed by its id, or by the channel and key that minted it. */
  cancelTask(target: TaskTarget): Promise<TaskRefusal> {
    return this.call<TaskRefusal>('queue.cancel', target)
  }

  retryTask(target: TaskTarget): Promise<TaskRefusal> {
    return this.call<TaskRefusal>('queue.retry', target)
  }

  /** Cancels every task that quoted this conversation, chat and reading alike. */
  invalidateThread(threadKey: string, reason: string): Promise<{ threadKey: string; cancelled: string[] }> {
    return this.call<{ threadKey: string; cancelled: string[] }>('queue.invalidate_thread', { threadKey, reason })
  }

  /** One page of a task's items; a long thread never arrives in one frame. */
  queueItems(query: { groupId: string; offset?: number; limit?: number }): Promise<QueueItemPage> {
    return this.call<QueueItemPage>('queue.items', query)
  }

  /** Reads a stored source by id and says whether the expected text still matches. */
  /**
   * Asks the helper whether a source still matches. Passing `text` makes the
   * helper re-hash the body the host just read, so "unchanged" is decided by the
   * store, not by the caller's own claim.
   */
  readSource(
    id: string,
    expectFingerprint?: string,
    text?: string
  ): Promise<{ source: unknown; matched: boolean; fingerprint: string | null; size: number | null }> {
    return this.call('source.read', { id, expectFingerprint, text })
  }

  /** Claims one runnable task, or reports when nothing is due yet. */
  extractNext(): Promise<ExtractNext> {
    return this.call<ExtractNext>('extract.next', {})
  }

  /**
   * Runs one claimed batch. The helper asks this process for a model call while
   * it is waiting, so the completion budget covers reading, prompting and the
   * provider round trip alike.
   */
  extractRun(input: ExtractRunInput): Promise<ExtractOutcome> {
    return this.call<ExtractOutcome>('extract.run', input, KNOWLEDGE_LIMITS.modelRequestMs)
  }

  extractFail(input: ExtractFailInput): Promise<{ groupId: string; state: string }> {
    return this.call<{ groupId: string; state: string }>('extract.fail', input)
  }

  /** Proposals waiting for a person to accept or reject them. */
  listSuggestions(
    query: { state?: string; offset?: number; limit?: number } = {}
  ): Promise<SuggestionPage> {
    return this.call<SuggestionPage>('suggestion.list', query)
  }

  getSuggestion(id: string): Promise<KnowledgeSuggestion> {
    return this.call<KnowledgeSuggestion>('suggestion.get', { id })
  }

  acceptSuggestion(id: string): Promise<AcceptedSuggestion> {
    return this.call<AcceptedSuggestion>('suggestion.accept', { id })
  }

  rejectSuggestion(id: string): Promise<RejectedSuggestion> {
    return this.call<RejectedSuggestion>('suggestion.reject', { id })
  }

  invalidateTask(target: TaskTarget, reason: string): Promise<TaskRefusal> {
    return this.call<TaskRefusal>('queue.invalidate', { ...target, reason })
  }

  // ------------------------------------------------------------ user profile

  configureProfile(input: ProfileConfigureInput): Promise<ProfileStatus> {
    return this.call<ProfileStatus>('profile.configure', input)
  }

  pauseProfile(reason: 'manual' | 'game', paused: boolean): Promise<ProfileStatus> {
    return this.call<ProfileStatus>('profile.pause', { reason, paused })
  }

  profileStatus(): Promise<ProfileStatus> {
    return this.call<ProfileStatus>('profile.status', {})
  }

  /** Counts one completed action; the helper ignores a repeated operation id. */
  recordProfileEvent(input: {
    opId: string
    feature: string
    at?: number
  }): Promise<{ counted: boolean; reason?: string }> {
    return this.call('profile.event', input)
  }

  /** Queues the user's own words; long text is split by the helper. */
  queueProfileEvidence(items: ProfileEvidenceInput[]): Promise<{
    queued: number
    skipped?: number
    reason?: string
  }> {
    return this.call('profile.evidence', { items })
  }

  learnNext(): Promise<ProfileNext> {
    return this.call<ProfileNext>('profile.learn.next', {})
  }

  /** Synthesis may think: the 120 s budget covers the whole batch. */
  learnRun(input: ProfileLearnRunInput): Promise<{
    written: { id: string; action: string }[]
    skipped: number
    evidence: number
  }> {
    return this.call('profile.learn.run', input, KNOWLEDGE_LIMITS.modelRequestMs)
  }

  learnFail(input: ProfileLearnFailInput): Promise<{ released: number; state: string }> {
    return this.call('profile.learn.fail', input)
  }

  profileContext(): Promise<ProfileContext> {
    return this.call<ProfileContext>('profile.context', {})
  }

  retractProfileSource(
    sourceKind: string,
    sourceId: string,
    reason?: string
  ): Promise<{ retracted: boolean; dropped: number }> {
    return this.call('profile.retract', { sourceKind, sourceId, reason })
  }

  clearProfile(): Promise<{ cleared: boolean; items: number; pending: number; epoch: number }> {
    return this.call('profile.clear', {})
  }

  /** The explicit retry path for batches that failed for a real reason. */
  retryProfile(): Promise<{ retried: number }> {
    return this.call('profile.retry', {})
  }

  needsReread(target: TaskTarget, reason: string): Promise<TaskRefusal> {
    return this.call<TaskRefusal>('queue.needs_reread', { ...target, reason })
  }

  exclude(kind: string, key: string, reason = ''): Promise<{ kind: string; key: string; excluded: boolean }> {
    return this.call<{ kind: string; key: string; excluded: boolean }>('exclude.add', { kind, key, reason })
  }

  unexclude(kind: string, key: string): Promise<{ kind: string; key: string; excluded: boolean }> {
    return this.call<{ kind: string; key: string; excluded: boolean }>('exclude.remove', { kind, key })
  }

  listExclusions(): Promise<ExclusionEntry[]> {
    return this.call<ExclusionEntry[]>('exclude.list', {})
  }

  beginHistory(
    scopes: { notes: boolean; chat: boolean },
    bounds: { noteBound: string | null; chatBound: number | null } = { noteBound: null, chatBound: null }
  ): Promise<{ job: HistoryJob; resumed: boolean }> {
    return this.call<{ job: HistoryJob; resumed: boolean }>('history.begin', { ...scopes, ...bounds })
  }

  stepHistory(input: {
    jobId: string
    kind: 'note' | 'chat'
    cursor?: string | null
    rows: PublishInput[]
    done: boolean
  }): Promise<{ job: HistoryJob; done: boolean }> {
    return this.call<{ job: HistoryJob; done: boolean }>('history.step', input)
  }

  pauseHistory(jobId: string): Promise<{ job: HistoryJob }> {
    return this.call<{ job: HistoryJob }>('history.pause', { jobId })
  }

  resumeHistory(jobId: string): Promise<{ job: HistoryJob }> {
    return this.call<{ job: HistoryJob }>('history.resume', { jobId })
  }

  cancelHistory(jobId: string): Promise<{ job: HistoryJob }> {
    return this.call<{ job: HistoryJob }>('history.cancel', { jobId })
  }

  historyStatus(jobId: string): Promise<{ job: HistoryJob }> {
    return this.call<{ job: HistoryJob }>('history.status', { jobId })
  }

  latestHistory(): Promise<{ job: HistoryJob | null }> {
    return this.call<{ job: HistoryJob | null }>('history.latest', {})
  }
}
