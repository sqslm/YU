/**
 * Projects finished content into the knowledge helper.
 *
 * The main process decides *when* something is worth keeping and hands over a
 * plain projection; every rule that has to survive a restart — fingerprints,
 * versions, the settling window, dedupe, task states — lives in the Rust helper.
 * Nothing here opens a database, and nothing here calls a model: stage 2 only
 * creates sources and pending tasks.
 */

import type { Settings } from '@shared/types'
import type {
  CollectChannel,
  HistoryJob,
  PublishInput,
  PublishResult,
  SourceKind
} from '@shared/knowledge'
import type { KnowledgeHost } from './host'
import { noteBodyField } from '@shared/noteBody'
import { createHash } from 'node:crypto'

/** A note as the notes store holds it, reduced to what a source needs. */
export interface NoteProjection {
  id: string
  title?: string
  transcript: string
  polished: string
  updatedAt: number
  /** True while the note is still waiting to be pushed to the server; not a persistence signal. */
  pending?: boolean
  polishStatus?: 'pending' | 'ok' | 'failed' | 'skipped'
}

/**
 * What a finished chat turn hands over. The materials are the ones the tools
 * actually returned during that turn, so the reading record never claims a page
 * it did not read.
 */
export interface ChatTurnDone {
  threadId: string
  threadTitle?: string
  userId: string
  answerId: string
  question: string
  answer: string
  at: number
  materials: ReadingMaterial[]
  /** Card ids the answer really cited this turn, from the tools' own results. */
  citedCardIds?: string[]
}

/** One finished question in the main-window chat. */
export interface ThreadProjection {
  threadId: string
  threadTitle?: string
  userId: string
  answerId: string
  question: string
  answer: string
  at: number
  /**
   * Card ids the answer really cited, so the projection can reuse their source
   * chain instead of minting a duplicate card from the same text.
   */
  citedCardIds?: string[]
}

/**
 * One reading material that was actually in front of the answer.
 *
 * `origin` is the identity the source keeps across turns: the page URL, the
 * document path, or the attachment reference. A turn id is never an identity —
 * the same page read twice must update one source, not create two.
 */
export interface ReadingMaterial {
  origin: string
  title: string
  text: string
  truncated?: boolean
  coverage?: string
  url?: string
  path?: string
  attachmentId?: string
  /** Page, chapter or section when the reader reported one. */
  locator?: string
}

/** A finished reading answer, from either the floating Ask or the chat page. */
export interface ReadingProjection {
  /** The conversation it happened in; deleting it retracts these sources. */
  threadId: string
  scope: string
  request: string
  materials: ReadingMaterial[]
  answer: string
  sources: Array<{ title: string; url?: string }>
  at: number
}

/**
 * A bounded, stable group key for one reading material.
 *
 * The origin can be a long URL or a document path, so the key is a digest of it:
 * fixed length, no prefix collisions from cutting the string, and identical every
 * time the same material is read.
 */
export function readingKey(origin: string): string {
  return `reading:${createHash('sha256').update(origin).digest('hex')}`
}

/** Which stored kind a material's identity implies. */
export function materialKind(material: ReadingMaterial): SourceKind {
  if (material.attachmentId) return 'document'
  if (material.path) return 'document'
  if (material.url) return 'web'
  return 'document'
}

const MAX_MATERIALS = 5
const MAX_MATERIAL_CHARS = 48_000
/** Cited ids travel with the projection; the helper caps them again. */
const MAX_CITED = 12
const STASH_BYTES = 16 * 1024 * 1024

/** What a store says about the text a pending task quoted. */
export type RecoveredBody = { text: string } | { missing: 'deleted' | 'temporary' | 'empty' | 'unknown' }

export interface CollectorDeps {
  settings: () => Settings
  host: () => KnowledgeHost | null
  /**
   * The production recovery entry: reads a source's current body back out of the
   * store it came from. Without it a note/chat task can only be retried while its
   * body is still in memory, so recovery never claims text it cannot produce.
   */
  readBody?: (channel: 'note' | 'chat' | 'reading', originRef: string) => RecoveredBody
  /**
   * Called after a source is queued so the extraction driver can look for work.
   * Collection and extraction stay separate: this file decides what to publish,
   * Rust decides what may be extracted and when.
   */
  onQueued?: () => void
  log?: (line: string) => void
  now?: () => number
}

export class KnowledgeCollector {
  /**
   * Reading bodies are held in this process only. The helper never stores them
   * anywhere else, so an evicted entry can only be reported as `needs_reread`.
   * A document also keeps the path the read came from: that is the only file
   * target this process can vouch for, and it outlives the writable source row.
   */
  private readonly stash = new Map<string, { text: string; size: number; path?: string }>()
  private stashed = 0
  /** Group id → stash key, so retry can find the body it is meant to reuse. */
  private readonly keys = new Map<string, string>()
  /**
   * The latest configuration hand-over. A publish waits for it, so a switch that
   * was just turned off cannot be overtaken by a publish carrying the old state.
   */
  private confirmed: Promise<void> = Promise.resolve()
  /** True only while a hand-over is in flight, so the common path stays synchronous. */
  private confirming = false
  /** The channel switches the helper already knows about. */
  private sent: Record<CollectChannel, boolean> | null = null

  constructor(private readonly deps: CollectorDeps) {}

  get enabled(): boolean {
    return this.deps.settings().knowledge?.enabled === true
  }

  get channel(): (name: CollectChannel) => boolean {
    return name => this.deps.settings().knowledge?.[name === 'note' ? 'notes' : name] !== false
  }

  private allows(name: CollectChannel): boolean {
    return this.enabled && this.deps.settings().knowledge?.[name === 'note' ? 'notes' : name] !== false
  }

  private host(): KnowledgeHost | null {
    return this.deps.host()
  }

  private error(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Mirrors the switches into the helper — including "off", which is the only
   * way the helper learns that further publishes must be refused.
   *
   * With the feature off and the helper not running there is nothing to tell and
   * nobody to tell it to: spawning a process just to write "off" would create the
   * databases the default is meant to leave alone.
   */
  async sync(options: { game?: boolean } = {}): Promise<{ closed: CollectChannel[] }> {
    const host = this.host()
    if (!host) return { closed: [] }
    const knowledge = this.deps.settings().knowledge
    const enabled = knowledge?.enabled === true
    // A channel that was on and is now off cannot be written any more, so a batch
    // already waiting for a provider has to be stopped instead of being paid for.
    const current: Record<CollectChannel, boolean> = {
      note: this.channel('note'),
      chat: this.channel('chat'),
      reading: this.channel('reading')
    }
    const closed = this.sent ? (Object.keys(current) as CollectChannel[]).filter(name => this.sent![name] && !current[name]) : []
    this.sent = current
    if (!enabled && !host.running) {
      this.confirmed = Promise.resolve()
      this.clear()
      return { closed }
    }
    this.confirming = true
    const handover = host
      .configureCollect({
        enabled,
        notes: knowledge?.notes !== false,
        chat: knowledge?.chat !== false,
        reading: knowledge?.reading !== false,
        paused: options.game === undefined ? undefined : { game: options.game }
      })
      .then(() => undefined)
      .catch(error => {
        this.deps.log?.(`[knowledge] 同步采集开关失败：${this.error(error)}`)
      })
    // Publishes await this, so a switch closed a moment ago is already known to
    // the helper before the next source is offered.
    this.confirmed = handover.finally(() => { this.confirming = false })
    await this.confirmed
    if (!enabled) this.clear()
    return { closed }
  }

  /** Drops every in-memory body; called when the feature is switched off. */
  clear(): void {
    // Bodies are dropped, but the tasks stay: every group that quoted one is
    // parked as needing a re-read, because nothing else holds that text.
    for (const origin of [...this.stash.keys()]) this.forget(origin)
    this.stash.clear()
    this.keys.clear()
    this.stashed = 0
  }

  /** A note version reached a saved body; empty or unsaved bodies create nothing. */
  noteSettled(note: NoteProjection): void {
    void this.publishNote(note)
  }

  /**
   * Publishes one note as a source and answers with what the store made of it.
   *
   * Publishing is idempotent for unchanged text, so an explicit "extract this
   * note" action goes through the same call the save path uses: the same source
   * chain, the same dedupe, no second copy of the same knowledge.
   */
  async publishNote(note: NoteProjection, citedCardIds: string[] = []): Promise<PublishResult | null> {
    if (!this.allows('note')) return null
    if (note.polishStatus === 'pending') return null
    const text = noteBody(note)
    if (!text) {
      // The body was cleared on purpose: the task that quoted the old text is
      // retracted rather than left pointing at something the user removed.
      this.noteRemoved(note.id, 'note body cleared')
      return null
    }
    return this.publish({
      channel: 'note',
      kind: 'note',
      originRef: note.id,
      groupKey: note.id,
      title: note.title ?? text.slice(0, 40),
      scope: '笔记',
      text,
      at: note.updatedAt,
      ...(citedCardIds.length ? { citedCardIds } : {})
    })
  }

  /** A deleted note must not leave pending extraction behind. */
  noteRemoved(id: string, reason = 'note deleted'): void {
    const host = this.host()
    if (!host || !this.enabled) return
    void host.invalidateTask({ channel: 'note', groupKey: id }, reason).catch(() => undefined)
  }

  /**
   * A deleted or temporary thread drops every pending task that quoted it —
   * the chat turn and any reading material read during it.
   */
  threadRemoved(threadId: string, reason = 'thread deleted'): void {
    const host = this.host()
    if (!host || !this.enabled) return
    void host.invalidateThread(threadId, reason).catch(error =>
      this.deps.log?.(`[knowledge] 撤回会话任务失败：${this.error(error)}`)
    )
  }

  /** One finished question; the thread is the group, the pair is the item. */
  threadFinished(turn: ThreadProjection): void {
    if (!this.allows('chat')) return
    const answer = turn.answer.trim()
    if (!turn.question.trim() || !answer) return
    const text = [turn.question.trim(), answer].join('\n\n')
    const cited = [...new Set((turn.citedCardIds ?? []).filter(Boolean))].slice(0, MAX_CITED)
    void this.publish({
      channel: 'chat',
      kind: 'chat',
      originRef: `${turn.threadId}:${turn.userId}:${turn.answerId}`,
      groupKey: turn.threadId,
      threadKey: turn.threadId,
      title: turn.threadTitle ?? turn.question.slice(0, 40),
      scope: '主界面问答',
      text,
      at: turn.at,
      ...(cited.length ? { citedCardIds: cited } : {})
    })
  }

  /**
   * A reading answer. Every material becomes its own source under its own
   * identity, so two documents never collapse into one unlocatable string and a
   * re-read of the same page updates that page instead of minting a new one.
   */
  readingFinished(reading: ReadingProjection): void {
    if (!this.allows('reading')) return
    const answer = reading.answer.trim()
    if (!answer) return
    const kept: ReadingMaterial[] = []
    let used = 0
    for (const material of reading.materials) {
      if (kept.length >= MAX_MATERIALS) break
      const text = material.text ?? ''
      if (!text.trim()) continue
      const room = MAX_MATERIAL_CHARS - used
      if (room <= 0) break
      kept.push(text.length > room ? { ...material, text: text.slice(0, room), truncated: true } : material)
      used += Math.min(text.length, room)
    }
    if (!kept.length) return
    kept.forEach((material, index) => {
      const range = `${index + 1}/${kept.length}，约 ${material.text.length} 字符${material.truncated ? '（已截断）' : ''}`
      // The stash holds the material's own text: that is the version the helper
      // stored a fingerprint for, so extraction can prove it read the same body.
      // The question and answer stay in the source scope, not in the version.
      const groupKey = readingKey(material.origin)
      this.remember(material.origin, groupKey, material.text, material.path)
      void this.publish({
        channel: 'reading',
        kind: materialKind(material),
        originRef: material.origin,
        groupKey,
        threadKey: reading.threadId,
        title: material.title.slice(0, 200),
        locator: material.locator ?? material.url ?? material.path ?? material.attachmentId ?? '',
        readAt: reading.at,
        scope: `${reading.scope}（材料 ${range}${material.coverage ? `，${material.coverage}` : ''}）`.slice(0, 1000),
        text: material.text,
        at: reading.at
      })
    })
  }

  /**
   * Retries a task. The body has to be reusable right now: a reading source
   * whose text was evicted is reported as `needs_reread` instead of leaving a
   * task that can never finish.
   */
  /**
   * Retries a parked task, but only after proving the text is still the text.
   *
   * The queue holds a reference and a fingerprint, not a copy. Recovery reads the
   * current body out of the original store (or the in-memory stash for a reading
   * summary), lets the helper re-hash it against the stored fingerprint, and only
   * then re-arms the task. A deleted note, a temporary thread, an evicted body or
   * an edited note ends the task instead of retrying stale content.
   */
  async retry(groupId: string): Promise<boolean> {
    const host = this.host()
    if (!host) return false
    try {
      const page = await host.queueItems({ groupId, limit: 1 })
      // `queue.items` returns the items of one group, not a list of groups.
      const item = page.items[0]
      if (!item) return false
      const channel = page.channel ?? 'reading'
      const body = this.bodyOf(channel, item.originRef, groupId)
      if ('missing' in body) {
        await this.retract(groupId, body.missing, channel)
        return false
      }
      if (channel !== 'reading') {
        // Rust re-hashes the body we just read; a changed source is a new version,
        // so the old task is retracted rather than retried with stale text.
        const check = await host.readSource(item.sourceId, undefined, body.text)
        if (!check.matched) {
          await this.retract(groupId, 'changed', channel)
          return false
        }
      }
      await host.retryTask({ groupId })
      return true
    } catch (error) {
      const message = this.error(error)
      this.deps.log?.(`[knowledge] 无法重试：${message}`)
      return false
    }
  }

  private bodyOf(channel: 'note' | 'chat' | 'reading', originRef: string, groupId: string): RecoveredBody {
    if (channel === 'reading') {
      const key = this.keys.get(groupId) ?? originRef
      const entry = this.stash.get(key)
      return entry ? { text: entry.text } : { missing: 'unknown' }
    }
    const read = this.deps.readBody?.(channel, originRef)
    return read ?? { missing: 'unknown' }
  }

  /** Ends a task whose source no longer says what it said. */
  private async retract(groupId: string, reason: string, channel: 'note' | 'chat' | 'reading'): Promise<void> {
    const host = this.host()
    if (!host) return
    if (channel === 'reading' && reason === 'unknown') {
      await host.needsReread({ groupId }, 'reading body no longer in memory').catch(() => undefined)
      return
    }
    const text =
      reason === 'deleted'
        ? 'source deleted'
        : reason === 'temporary'
          ? 'thread became temporary'
          : reason === 'empty'
            ? 'source body is empty'
            : 'source changed'
    await host.invalidateTask({ groupId }, text).catch(() => undefined)
  }

  /**
   * Resolves one source body for extraction. A reading source lives only in this
   * process, so a body that was evicted, or a restarted process, is reported as
   * missing instead of being read again from the network or the disk.
   */
  resolveBody(channel: CollectChannel, originRef: string): RecoveredBody {
    if (channel === 'reading') {
      const text = this.stash.get(originRef)?.text ?? null
      return text ? { text } : { missing: 'unknown' }
    }
    return this.deps.readBody?.(channel, originRef) ?? { missing: 'unknown' }
  }

  locate(origin: string): string | null {
    return this.stash.get(origin)?.text ?? null
  }

  /**
   * The read this process actually did for a source: the body it hashed and, for
   * a document, the path that read came from.
   *
   * This — not the writable source row — is what authorises handing a file to the
   * operating system. A row can be rewritten to point at any locator while the
   * recorded read still names the file that was really opened.
   */
  readRecord(channel: CollectChannel, originRef: string): { text: string; path?: string } | null {
    if (channel !== 'reading') return null
    const entry = this.stash.get(originRef)
    if (!entry) return null
    return entry.path ? { text: entry.text, path: entry.path } : { text: entry.text }
  }

  private remember(origin: string, groupKey: string, text: string, path?: string): void {
    const size = Buffer.byteLength(text, 'utf8')
    if (size > STASH_BYTES) return
    // The same origin can be published twice (a re-read of the same page). Its old
    // entry is replaced rather than counted twice, or the budget would drift.
    const previous = this.stash.get(origin)
    if (previous) {
      this.stash.delete(origin)
      this.stashed -= previous.size
    }
    while (this.stashed + size > STASH_BYTES) {
      const oldest = this.stash.keys().next()
      if (oldest.done) break
      this.forget(oldest.value)
    }
    this.stash.set(origin, path ? { text, size, path } : { text, size })
    this.stashed += size
    this.keys.set(groupKey, origin)
  }

  /**
   * Drops one stashed body and parks every task that quoted it.
   *
   * A task whose text is gone cannot be retried into `ready`: it is reported as
   * needing a re-read, which is the only honest state for a body that was never
   * stored anywhere but this process.
   */
  private forget(origin: string): void {
    const entry = this.stash.get(origin)
    if (!entry) return
    this.stash.delete(origin)
    this.stashed -= entry.size
    const host = this.host()
    for (const [groupId, key] of [...this.keys]) {
      if (key !== origin) continue
      this.keys.delete(groupId)
      void host?.needsReread({ groupId }, 'reading body evicted').catch(() => undefined)
    }
  }

  private async publish(input: PublishInput): Promise<PublishResult | null> {
    const host = this.host()
    if (!host) return null
    try {
      // Wait for a switch hand-over still in flight: the helper must already know
      // that this channel is off before the source is offered to it.
      if (this.confirming) await this.confirmed
      const result = await host.publishSource(input)
      const key = this.keys.has(input.groupKey) ? this.keys.get(input.groupKey) : undefined
      if (key) this.keys.set(result.groupId, key)
      if (!result.duplicate) this.deps.onQueued?.()
      return result
    } catch (error) {
      // A refused source is not a crash: the channel may be off, the group
      // excluded, or the body too large. The reason stays in the log only.
      this.deps.log?.(`[knowledge] 采集 ${input.channel} 失败：${this.error(error)}`)
      return null
    }
  }

  // ------------------------------------------------------------- history

  async startHistory(scopes: { notes: boolean; chat: boolean }): Promise<HistoryJob | null> {
    const host = this.host()
    if (!host || !this.enabled) return null
    const begun = await host.beginHistory(scopes)
    return begun.job
  }

  async stepHistory(
    jobId: string,
    kind: 'note' | 'chat',
    rows: PublishInput[],
    cursor: string | null,
    done: boolean
  ): Promise<HistoryJob | null> {
    const host = this.host()
    if (!host) return null
    const stepped = await host.stepHistory({ jobId, kind, rows, cursor, done })
    return stepped.job
  }

  async controlHistory(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<HistoryJob | null> {
    const host = this.host()
    if (!host) return null
    const call = action === 'pause' ? host.pauseHistory : action === 'resume' ? host.resumeHistory : host.cancelHistory
    return (await call.call(host, jobId)).job
  }

  async historyStatus(jobId?: string): Promise<HistoryJob | null> {
    const host = this.host()
    if (!host) return null
    if (jobId) return (await host.historyStatus(jobId)).job
    return (await host.latestHistory()).job
  }
}

/** A note's stored body, or null when it has nothing worth keeping. */
/**
 * The note body the way the notes page defines it.
 *
 * `polished || transcript` is wrong for an intentionally cleared body: with
 * `polishStatus: 'ok'` and an empty polished text the user meant "empty", not
 * "show the old transcript". The shared field rule already encodes that, so the
 * collector follows it instead of inventing a second interpretation.
 */
export function noteBody(note: {
  polished?: string
  transcript?: string
  polishStatus?: 'pending' | 'ok' | 'failed' | 'skipped'
}): string {
  const field = noteBodyField({
    polished: note.polished ?? '',
    polishStatus: note.polishStatus ?? 'skipped'
  })
  return (field === 'polished' ? (note.polished ?? '') : (note.transcript ?? '')).trim()
}

/** The note projection the collector expects. */
export function noteProjection(note: {
  id: string
  title?: string
  transcript?: string
  polished?: string
  updatedAt: number
  pending?: boolean
  polishStatus?: 'pending' | 'ok' | 'failed' | 'skipped'
}): NoteProjection {
  return {
    id: note.id,
    title: note.title,
    transcript: note.transcript ?? '',
    polished: note.polished ?? '',
    updatedAt: note.updatedAt,
    pending: note.pending,
    polishStatus: note.polishStatus
  }
}

export type { SourceKind }

/**
 * Normalizes a tool payload into reading material. `read_webpage`,
 * `read_current_content` and the document readers all answer with the same four
 * fields, so one projection covers them and an empty body is never recorded.
 */
export function readingMaterial(name: string, data: unknown): ReadingMaterial | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  const text = typeof row.text === 'string' ? row.text : ''
  if (!text.trim()) return null
  const url = typeof row.url === 'string' && row.url ? row.url : undefined
  const path = typeof row.path === 'string' && row.path ? row.path : undefined
  const title =
    (typeof row.title === 'string' && row.title.trim()) ||
    path ||
    url ||
    name
  const origin = url ?? path
  if (!origin) return null
  const material: ReadingMaterial = { origin, title: String(title), text }
  if (url) material.url = url
  if (path) material.path = path
  if (row.truncated === true) material.truncated = true
  if (typeof row.coverage === 'string' && row.coverage) material.coverage = row.coverage
  return material
}

/** An uploaded attachment that was actually sent to the model. */
export function attachmentMaterial(input: {
  id: string
  name?: string
  text: string
  truncated?: boolean
}): ReadingMaterial | null {
  const text = input.text ?? ''
  if (!text.trim()) return null
  const material: ReadingMaterial = {
    origin: `attachment:${input.id}`,
    title: input.name?.trim() || input.id,
    text,
    attachmentId: input.id
  }
  if (input.truncated) material.truncated = true
  return material
}

/** The reading tools whose bodies are worth keeping. */
export const READING_TOOLS = ['read_webpage', 'read_current_content', 'read_file', 'search_file_contents'] as const

export function isReadingTool(name: string): boolean {
  return (READING_TOOLS as readonly string[]).includes(name)
}
