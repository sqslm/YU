/**
 * Manual extraction of one named source.
 *
 * The body is read and described *before* the queue is touched: the helper parks
 * or refuses from that description inside its own write transaction, so a lost or
 * changed text can never reset the progress an earlier run committed. Only a
 * really accepted task wakes the engine.
 *
 * Every ordering decision stays in Rust: this reads text and states what it read.
 */

import type { CollectChannel, ExtractSourceResult, KnowledgeSource } from '@shared/knowledge'
import type { KnowledgeHost } from './host'
import type { RecoveredBody } from './collector'
import { fingerprintOf } from './engine'

export interface ManualExtractDeps {
  host: () => KnowledgeHost
  /** This turn's signal: a cancel stops the queueing before it happens. */
  signal?: AbortSignal
  /** The master switch, i.e. the same gate every other channel uses. */
  enabled: () => boolean
  /** False while paused, in game mode, or when the channel is off. */
  allowed: () => boolean
  resolveBody: (channel: CollectChannel, originRef: string) => RecoveredBody
  /**
   * Asked once more right before the write request. A hand-over already passed the
   * publish gate, but reading the source back is another await: the tool may have
   * been switched off or collection paused in between, and queueing then would be
   * a write nobody allowed. Answers a reason to refuse with, or '' to go ahead.
   *
   * Optional on purpose: the UI's own extract action and the background collector
   * keep their existing semantics.
   */
  admit?: () => Promise<string>
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

/** The helper refused because the text this caller read is no longer current. */
const STALE = 'source_changed'
const STALE_REASON = '原文已变更，需要重新读取该来源'

/**
 * Runs one manual extraction.
 *
 * A body that is gone is reported as `missing` (parked by the helper, progress
 * kept). A body that is present is sent together with its version and hash, so a
 * source that changed in between is refused instead of re-extracted. Both answers
 * come back from one write transaction, and a storage failure is returned as it is.
 */
export async function extractSourceNow(id: string, deps: ManualExtractDeps): Promise<ExtractSourceResult> {
  const cancelled = (): ExtractSourceResult => ({ queued: 0, reason: '本轮已取消' })
  if (deps.signal?.aborted) return cancelled()
  if (!deps.enabled()) return { queued: 0, reason: '知识采集未开启' }
  if (!deps.allowed()) return { queued: 0, reason: '采集已暂停' }
  /** The last gate before a write: asked after every await, cancel checked last. */
  const lastCheck = async (): Promise<ExtractSourceResult | null> => {
    const denied = deps.admit ? await deps.admit() : ''
    if (denied) return { queued: 0, reason: denied }
    return deps.signal?.aborted ? cancelled() : null
  }
  const host = deps.host()
  const source = await host.getSource(id)
  // Reading the source and its body is an await: the turn may be gone by now, and
  // a task queued for a cancelled turn is work nobody asked for.
  if (deps.signal?.aborted) return cancelled()
  if (source.state !== 'active') return { queued: 0, reason: source.invalidReason || '来源已失效' }
  const channel = sourceChannel(source)
  const body = deps.resolveBody(channel, source.originRef)

  if ('missing' in body) {
    const reason = missingReason(body.missing, channel === 'reading')
    // The snapshot travels with the news as well: a source that was invalidated,
    // replaced or cancelled while this read was in flight must not be parked by a
    // request that described an older state.
    const refused = await lastCheck()
    if (refused) return refused
    const parked = await host.extractSource({
      sourceId: id,
      expectVersion: source.version,
      expectFingerprint: source.fingerprint,
      missing: reason
    })
    // A batch already holds the task: its claim is not pulled out from under the
    // running call, and nothing is claimed to be parked when it was not.
    if (parked.state !== 'needs_reread') {
      if (parked.reason === STALE) return { ...parked, reason: STALE_REASON }
      return parked
    }
    deps.log?.(`[knowledge] 手动提炼缺原文，已挂起：${source.kind} ${parked.groupId ?? ''}`.trim())
    return { queued: 0, reason, groupId: parked.groupId ?? null, state: 'needs_reread' }
  }

  const refused = await lastCheck()
  if (refused) return refused
  const queued = await host.extractSource({
    sourceId: id,
    expectVersion: source.version,
    expectFingerprint: fingerprintOf(body.text)
  })
  if (!queued.queued) {
    if (queued.reason === STALE) return { ...queued, reason: STALE_REASON }
    return queued
  }
  deps.wake()
  deps.log?.(`[knowledge] 手动提炼已排队：${source.kind} ${queued.groupId ?? ''}`.trim())
  return queued
}
