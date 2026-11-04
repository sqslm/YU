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

/** Which stored kind a material's identity implies. */
export function materialKind(material: ReadingMaterial): SourceKind {
  if (material.attachmentId) return 'document'
  if (material.path) return 'document'
  if (material.url) return 'web'
  return 'document'
}

const MAX_MATERIALS = 5
const MAX_MATERIAL_CHARS = 48_000
const STASH_BYTES = 16 * 1024 * 1024

export interface CollectorDeps {
  settings: () => Settings
  host: () => KnowledgeHost | null
  log?: (line: string) => void
  now?: () => number
}

export class KnowledgeCollector {
  /**
   * Reading bodies are held in this process only. The helper never stores them
   * anywhere else, so an evicted entry can only be reported as `needs_reread`.
   */
  private readonly stash = new Map<string, { text: string; size: number }>()
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
  async sync(options: { game?: boolean } = {}): Promise<void> {
    const host = this.host()
    if (!host) return
    const knowledge = this.deps.settings().knowledge
    const enabled = knowledge?.enabled === true
    if (!enabled && !host.running) {
      this.confirmed = Promise.resolve()
      this.clear()
      return
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
  }

  /** Drops every in-memory body; called when the feature is switched off. */
  clear(): void {
    this.stash.clear()
    this.keys.clear()
    this.stashed = 0
  }

  /** A note version reached a saved body; empty or unsaved bodies create nothing. */
  noteSettled(note: NoteProjection): void {
    if (!this.allows('note')) return
    if (note.polishStatus === 'pending') return
    const text = noteBody(note)
    if (!text) {
      // The body was cleared on purpose: the task that quoted the old text is
      // retracted rather than left pointing at something the user removed.
      this.noteRemoved(note.id, 'note body cleared')
      return
    }
    void this.publish({
      channel: 'note',
      kind: 'note',
      originRef: note.id,
      groupKey: note.id,
      title: note.title ?? text.slice(0, 40),
      scope: '笔记',
      text,
      at: note.updatedAt
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
    void this.publish({
      channel: 'chat',
      kind: 'chat',
      originRef: `${turn.threadId}:${turn.userId}:${turn.answerId}`,
      groupKey: turn.threadId,
      threadKey: turn.threadId,
      title: turn.threadTitle ?? turn.question.slice(0, 40),
      scope: '主界面问答',
      text,
      at: turn.at
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
      const parts = [
        `【问题】\n${reading.request.trim()}`,
        `【材料】${material.title}`,
        material.coverage ? `【覆盖】${material.coverage}` : '',
        material.text,
        `【回答】\n${answer}`
      ].filter(part => part !== '')
      const links = reading.sources.filter(item => item.url).map(item => item.url as string)
      if (links.length) parts.push(`【来源】\n${links.join('\n')}`)
      const text = parts.join('\n\n')
      const groupKey = `reading:${material.origin}`.slice(0, 200)
      this.remember(material.origin, groupKey, text)
      void this.publish({
        channel: 'reading',
        kind: materialKind(material),
        originRef: material.origin,
        groupKey,
        threadKey: reading.threadId,
        title: material.title.slice(0, 200),
        locator: material.locator ?? material.url ?? material.path ?? material.attachmentId ?? '',
        readAt: reading.at,
        scope: `${reading.scope}（材料 ${range}）`.slice(0, 1000),
        text,
        at: reading.at
      })
    })
  }

  /**
   * Retries a task. The body has to be reusable right now: a reading source
   * whose text was evicted is reported as `needs_reread` instead of leaving a
   * task that can never finish.
   */
  async retry(groupId: string): Promise<boolean> {
    const host = this.host()
    if (!host) return false
    const key = this.keys.get(groupId)
    if (key && !this.stash.has(key)) {
      await host.needsReread({ groupId }, 'reading body no longer in memory').catch(() => undefined)
      return false
    }
    try {
      await host.retryTask({ groupId })
      return true
    } catch (error) {
      const message = this.error(error)
      this.deps.log?.(`[knowledge] 无法重试：${message}`)
      if (key) await host.needsReread({ groupId }, 'reading body no longer in memory').catch(() => undefined)
      return false
    }
  }

  locate(origin: string): string | null {
    return this.stash.get(origin)?.text ?? null
  }

  private remember(origin: string, groupKey: string, text: string): void {
    const size = Buffer.byteLength(text, 'utf8')
    if (size > STASH_BYTES) return
    while (this.stashed + size > STASH_BYTES && this.stash.size) {
      const oldest = this.stash.keys().next()
      if (oldest.done) break
      this.stashed -= this.stash.get(oldest.value)?.size ?? 0
      this.stash.delete(oldest.value)
    }
    this.stash.set(origin, { text, size })
    this.stashed += size
    this.keys.set(groupKey, origin)
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
export function noteBody(note: { polished?: string; transcript?: string }): string {
  return (note.polished || note.transcript || '').trim()
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
