/**
 * Manual extraction of one named source.
 *
 * The helper only enqueues; something still has to read the text and let the
 * engine pick the task up. This module is that "something": it answers from the
 * real stores, wakes the extraction driver when a task really became runnable,
 * and reports a body that is gone as `needs_reread` instead of pretending the
 * manual request was accepted.
 *
 * Every decision about ordering, the settling window, dedupe and exclusion stays
 * in Rust: this only reads a body and asks.
 */

import type { CollectChannel, ExtractSourceResult, KnowledgeSource } from '@shared/knowledge'
import type { KnowledgeHost } from './host'
import type { RecoveredBody } from './collector'

export interface ManualExtractDeps {
  host: () => KnowledgeHost
  /** The master switch, i.e. the same gate every other channel uses. */
  enabled: () => boolean
  /** False while paused, in game mode, or when the channel is off. */
  allowed: () => boolean
  resolveBody: (channel: CollectChannel, originRef: string) => RecoveredBody
  wake: () => void
  log?: (line: string) => void
}

/** The channel a stored source belongs to. Reading covers web and documents. */
export function sourceChannel(source: Pick<KnowledgeSource, 'kind'>): CollectChannel {
  if (source.kind === 'note') return 'note'
  if (source.kind === 'chat') return 'chat'
  return 'reading'
}

/** What a missing body means for the caller, in the words the UI shows. */
export function missingReason(missing: 'deleted' | 'temporary' | 'empty' | 'unknown', reading: boolean): string {
  if (missing === 'deleted') return '原记录已删除'
  if (missing === 'temporary') return '临时对话不进入知识库'
  if (missing === 'empty') return '原文为空'
  return reading ? '原文已不在内存，需要重新读取该来源' : '无法读取原文'
}

/**
 * Runs one manual extraction.
 *
 * The body is checked before the queue is touched, so a source whose text only
 * survives as metadata is reported — and persisted — as `needs_reread` without a
 * provider call. A runnable task is handed to the engine through `wake`, which is
 * the only thing an idle driver is missing.
 */
export async function extractSourceNow(id: string, deps: ManualExtractDeps): Promise<ExtractSourceResult> {
  if (!deps.enabled()) return { queued: 0, reason: '知识采集未开启' }
  if (!deps.allowed()) return { queued: 0, reason: '采集已暂停' }
  const host = deps.host()
  const source = await host.getSource(id)
  if (source.state !== 'active') return { queued: 0, reason: source.invalidReason || '来源已失效' }
  const channel = sourceChannel(source)
  const body = deps.resolveBody(channel, source.originRef)
  const missing = 'missing' in body ? body.missing : null
  const queued = await host.extractSource(id)
  if (!queued.queued || !queued.groupId) return queued
  if (missing) {
    // Rust keeps the source and its cards; only the task is parked.
    await host.needsReread({ groupId: queued.groupId }, missingReason(missing, channel === 'reading')).catch(() => undefined)
    return { queued: 0, reason: missingReason(missing, channel === 'reading'), groupId: queued.groupId, state: 'needs_reread' }
  }
  deps.wake()
  deps.log?.(`[knowledge] 手动提炼已排队：${source.kind} ${queued.groupId}`)
  return queued
}
