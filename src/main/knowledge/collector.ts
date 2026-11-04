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

/** One reading material that was actually in front of the answer. */
export interface ReadingMaterial {
  title: string
  text: string
  truncated?: boolean
  coverage?: string
  url?: string
  path?: string
}

/** A finished reading answer, from either the floating Ask or the chat page. */
export interface ReadingProjection {
  originRef: string
  groupKey: string
  title: string
  scope: string
  request: string
  materials: ReadingMaterial[]
  answer: string
  sources: Array<{ title: string; url?: string }>
  at: number
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

  constructor(private readonly deps: CollectorDeps) {}

  private get enabled(): boolean {
    return this.deps.settings().knowledge?.enabled === true
  }

  private channel(name: CollectChannel): boolean {
    return this.deps.settings().knowledge?.[name === 'note' ? 'notes' : name] !== false
  }

  private host(): KnowledgeHost | null {
    return this.deps.host()
  }

  private error(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Mirrors the switches into the helper; also called at startup and on save. */
  async sync(): Promise<void> {
    const host = this.host()
    if (!host || !this.enabled) return
    try {
      await host.configureCollect({
        notes: this.deps.settings().knowledge.notes,
        chat: this.deps.settings().knowledge.chat,
        reading: this.deps.settings().knowledge.reading
      })
    } catch (error) {
      this.deps.log?.(`[knowledge] 同步采集开关失败：${this.error(error)}`)
    }
  }

  /** A note version reached a saved body; empty or unsaved bodies create nothing. */
  noteSettled(note: NoteProjection): void {
    if (!this.enabled || !this.channel('note')) return
    const text = (note.polished || note.transcript || '').trim()
    if (!text) return
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
  noteRemoved(id: string): void {
    const host = this.host()
    if (!host || !this.enabled) return
    void host.invalidateTask({ channel: 'note', groupKey: id }, 'note deleted').catch(() => undefined)
  }

  /** A deleted thread drops its pending extraction the same way. */
  threadRemoved(threadId: string): void {
    const host = this.host()
    if (!host || !this.enabled) return
    void host.invalidateTask({ channel: 'chat', groupKey: threadId }, 'thread deleted').catch(() => undefined)
  }

  /** One finished question; the thread is the group, the pair is the item. */
  threadFinished(turn: ThreadProjection): void {
    if (!this.enabled || !this.channel('chat')) return
    const answer = turn.answer.trim()
    if (!turn.question.trim() || !answer) return
    const text = [turn.question.trim(), answer].join('\n\n')
    void this.publish({
      channel: 'chat',
      kind: 'chat',
      originRef: `${turn.threadId}:${turn.userId}:${turn.answerId}`,
      groupKey: turn.threadId,
      title: turn.threadTitle ?? turn.question.slice(0, 40),
      scope: '主界面问答',
      text,
      at: turn.at
    })
  }

  /**
   * A reading answer. The materials are copied into the body with an explicit
   * range note, so a later reader can tell what was actually included instead of
   * assuming the whole page was seen.
   */
  readingFinished(reading: ReadingProjection): void {
    if (!this.enabled || !this.channel('reading')) return
    const answer = reading.answer.trim()
    if (!answer) return
    const kept: ReadingMaterial[] = []
    let used = 0
    for (const material of reading.materials) {
      if (kept.length >= MAX_MATERIALS) break
      const text = material.text ?? ''
      if (!text) continue
      const room = MAX_MATERIAL_CHARS - used
      if (room <= 0) break
      kept.push(text.length > room ? { ...material, text: text.slice(0, room), truncated: true } : material)
      used += Math.min(text.length, room)
    }
    const included = `${kept.length}/${reading.materials.length}，约 ${used} 字符${reading.materials.some((item, index) => item.truncated || index >= kept.length) ? '（已截断）' : ''}`
    const parts = [reading.request.trim(), ...kept.map((material, index) => `【材料 ${index + 1}】${material.title}\n${material.text}`), `【回答】\n${answer}`]
    const links = reading.sources.filter(item => item.url).map(item => item.url as string)
    if (links.length) parts.push(`【来源】\n${links.join('\n')}`)
    const text = parts.join('\n\n')
    this.remember(reading.originRef, text)
    void this.publish({
      channel: 'reading',
      kind: 'web',
      originRef: reading.originRef,
      groupKey: reading.groupKey,
      title: reading.title,
      scope: `${reading.scope}（材料 ${included}）`,
      text,
      at: reading.at
    })
  }

  /** Retries a task, or reports that the reading body is gone for good. */
  async retry(groupId: string): Promise<void> {
    const host = this.host()
    if (!host) return
    const body = this.stash.get(groupId)
    try {
      await host.retryTask({ groupId })
    } catch (error) {
      if (body) return
      await host.needsReread({ groupId }, 'reading body no longer in memory').catch(() => undefined)
      this.deps.log?.(`[knowledge] 无法重试：${this.error(error)}`)
    }
  }

  locate(originRef: string): string | null {
    return this.stash.get(originRef)?.text ?? null
  }

  private remember(key: string, text: string): void {
    const size = Buffer.byteLength(text, 'utf8')
    if (size > STASH_BYTES) return
    while (this.stashed + size > STASH_BYTES && this.stash.size) {
      const oldest = this.stash.keys().next()
      if (oldest.done) break
      this.stashed -= this.stash.get(oldest.value)?.size ?? 0
      this.stash.delete(oldest.value)
    }
    this.stash.set(key, { text, size })
    this.stashed += size
  }

  private async publish(input: PublishInput): Promise<PublishResult | null> {
    const host = this.host()
    if (!host) return null
    try {
      return await host.publishSource(input)
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
}): NoteProjection {
  return {
    id: note.id,
    title: note.title,
    transcript: note.transcript ?? '',
    polished: note.polished ?? '',
    updatedAt: note.updatedAt
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
  const title =
    (typeof row.title === 'string' && row.title.trim()) ||
    (typeof row.path === 'string' && row.path) ||
    (typeof row.url === 'string' && row.url) ||
    name
  const material: ReadingMaterial = { title: String(title), text }
  if (typeof row.url === 'string' && row.url) material.url = row.url
  if (typeof row.path === 'string' && row.path) material.path = row.path
  if (row.truncated === true) material.truncated = true
  if (typeof row.coverage === 'string' && row.coverage) material.coverage = row.coverage
  return material
}

/** The reading tools whose bodies are worth keeping. */
export const READING_TOOLS = ['read_webpage', 'read_current_content', 'read_file', 'search_file_contents'] as const

export function isReadingTool(name: string): boolean {
  return (READING_TOOLS as readonly string[]).includes(name)
}
