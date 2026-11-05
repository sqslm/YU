/**
 * Handing one document or one note to the knowledge queue, as the model-facing
 * tools do it.
 *
 * Two callers share this code: the saved-workflow executor (a page this run really
 * read) and the explicit note tool. Neither may invent a body — one publishes the
 * material it already holds, the other reads the note back through its own store.
 *
 * Every refusal here is a real state of the app (switch off, channel off, paused,
 * game mode, switched off turn), so the caller reports it instead of queueing
 * something the helper will never take.
 */
import type { ExtractSourceResult } from '@shared/knowledge'
import { mt } from '@shared/mainI18n'

/** The same material shape the summary path projects. */
export interface HandoffMaterial {
  origin: string
  title: string
  text?: string
  url?: string
  locator?: string
}

export interface HandoffDeps {
  /** Master switch for the knowledge base. */
  enabled(): boolean
  /** Per-channel switch, i.e. the same one the collector checks before publishing. */
  channelOn(channel: 'reading' | 'notes'): boolean
  /** Game mode holds back every collection channel. */
  gameActive(): boolean
  /** The pause flags live in the helper, so they are asked for, never guessed. */
  paused(): Promise<{ manual: boolean; game: boolean }>
  /** Publishes through the collector and answers the source id it minted or found. */
  publishReading(material: HandoffMaterial): Promise<string | null>
  /** Reads the note through its own store, publishes it, and answers the source id. */
  publishNote(noteId: string): Promise<string | null>
  /** Queues one published source and wakes the engine only when it was accepted. */
  extract(sourceId: string): Promise<ExtractSourceResult>
  log?(line: string): void
}

/** Why this run cannot hand anything over right now, or '' when it can. */
export async function handoffBlocker(
  deps: HandoffDeps,
  channel: 'reading' | 'notes',
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) return mt('本轮已取消')
  if (!deps.enabled()) return mt('知识采集未开启')
  if (!deps.channelOn(channel)) {
    return channel === 'reading' ? mt('知识库没有开启阅读采集') : mt('知识库没有开启随记采集')
  }
  if (deps.gameActive()) return mt('游戏模式已开启')
  try {
    const status = await deps.paused()
    if (status.manual) return mt('采集已暂停')
    if (status.game) return mt('游戏模式已开启')
  } catch (error) {
    // The helper may be down; publishing reports that with its own reason.
    deps.log?.(`[knowledge] 读取暂停状态失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return ''
}

/** A page this run already read, handed to the queue through the real source chain. */
export async function handoffReading(
  deps: HandoffDeps,
  material: HandoffMaterial,
  options: { signal?: AbortSignal } = {}
): Promise<ExtractSourceResult> {
  const blocked = await handoffBlocker(deps, 'reading', options.signal)
  if (blocked) return { queued: 0, reason: blocked }
  const sourceId = await deps.publishReading(material)
  if (!sourceId) return { queued: 0, reason: '这条读取还没有进入知识库' }
  return deps.extract(sourceId)
}

/** One real note, re-read through its own store and handed over. */
export async function handoffNote(deps: HandoffDeps, noteId: string): Promise<ExtractSourceResult> {
  const blocked = await handoffBlocker(deps, 'notes')
  if (blocked) return { queued: 0, reason: blocked }
  const sourceId = await deps.publishNote(noteId)
  if (!sourceId) return { queued: 0, reason: '这条随记还不能提炼' }
  return deps.extract(sourceId)
}
