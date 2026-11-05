import { randomUUID } from 'node:crypto'

import { mt } from '@shared/mainI18n'

import type {
  CleanupAction,
  CleanupPending,
  CleanupRetryResult,
  FindSourceInput,
  SourceIdentity
} from '@shared/knowledge'

import type { ReleaseOutcome } from './release'

/** What one retry needs from the library, as the app wires it. */
export interface CleanupDeps {
  purgeCards: (input: {
    record: SourceIdentity
    /** The confirmation the user already gave; the helper re-checks it itself. */
    confirm: { sources: { id: string; version: string }[]; ticket: string }
    cards: boolean
  }) => Promise<{ removed: string[]; kept: string[]; skipped: string[] }>
  release: (input: FindSourceInput, reason: string) => Promise<ReleaseOutcome>
  log: (line: string) => void
}

/**
 * The page the entry belongs to, so a query can hand each one only its own rows.
 */
type Channel = 'note' | 'chat'

/** A deletion always names a record: the cleanup never starts from a bare source. */
type RecordIdentity = Extract<SourceIdentity, { channel: Channel }>

/** One record whose ticked cleanup failed after the record itself was deleted. */
interface Entry {
  input: FindSourceInput
  identity: RecordIdentity
  channel: Channel
  /** The confirmation the user actually gave; empty when there was no ticket. */
  ticket?: string
  /** Why the last attempt failed, in the words the user is shown. */
  reason: string
  /** Once the helper refused the ticket, the range moved for good. */
  stale: boolean
  at: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The range moved: the helper refused the ticket it was handed. Anything else is
 * the library being unreachable, which stays retryable in exactly the same shape.
 */
function moved(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'source_changed'
}

/**
 * Remembers the cleanups that failed after their record was already deleted, so
 * the user can finish them from the deletion they already confirmed.
 *
 * The record is gone at this point, which is why nothing here can be derived from
 * the page: the identity and the confirmed ticket live in this map, and the page
 * only ever gets an opaque id back. The entry is in-memory only — a restart
 * forgets it, and no schema, file or retry queue is added for it.
 *
 * Duplicate clicks must not run twice: the first attempt's promise is handed to
 * every later caller until it settles, so one retry means one helper transaction.
 */
export class CleanupRetries {
  private readonly entries = new Map<string, Entry>()
  private readonly running = new Map<string, Promise<CleanupRetryResult>>()

  constructor(private readonly deps: () => CleanupDeps) {}

  /** Cleanups still waiting for the user to finish them. */
  get waiting(): number {
    return this.entries.size
  }

  /** Registers one failed cleanup and returns the handle the page may show. */
  add(
    input: FindSourceInput,
    identity: RecordIdentity,
    detail: { reason: string; ticket?: string }
  ): CleanupPending {
    const id = randomUUID()
    const at = Date.now()
    const channel: Channel = identity.channel
    this.entries.set(id, {
      input,
      identity,
      channel,
      ticket: detail.ticket,
      reason: detail.reason,
      stale: false,
      at
    })
    return { id, reason: detail.reason, cards: true, stale: false, at }
  }

  /**
   * What this channel still owes the user.
   *
   * This is a read of the same in-memory register, not a second source of truth:
   * a page that was unmounted, or a window that was closed and reopened, asks here
   * to get its rows back. Nothing about the record leaves the main process except
   * the opaque id, the reason it failed, and whether the ticket has been refused.
   */
  list(channel: string): CleanupPending[] {
    if (channel !== 'note' && channel !== 'chat') return []
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.channel === channel)
      .sort((left, right) => right[1].at - left[1].at)
      .map(([id, entry]) => ({
        id,
        reason: entry.reason,
        cards: true,
        stale: entry.stale,
        at: entry.at
      }))
  }

  /**
   * Runs the retry the user asked for.
   *
   * `purge` re-sends the confirmation the user already gave, so the helper decides
   * again whether that range still holds; a moved range reports `stale` and deletes
   * nothing. `release` is the explicit downgrade the user picks after that: it
   * withdraws the record's sources and queued work and keeps every card and its
   * now-dead link. Either way a failure keeps the entry, so the same offer stands.
   */
  retry(id: string, action: CleanupAction): Promise<CleanupRetryResult> {
    const held = this.running.get(id)
    if (held) return held
    const run = this.run(id, action).finally(() => {
      this.running.delete(id)
    })
    this.running.set(id, run)
    return run
  }

  private async run(id: string, action: CleanupAction): Promise<CleanupRetryResult> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(mt('这次知识清理已经结束，不需要再重试'))
    const deps = this.deps()
    if (action === 'release') {
      let released: ReleaseOutcome
      try {
        released = await deps.release(entry.input, '记录已删除')
      } catch (error) {
        const reason = message(error)
        entry.reason = reason
        deps.log(`[knowledge] 重试知识清理失败：${reason}`)
        return { status: 'failed', reason, removed: 0, kept: 0, released: 0 }
      }
      if (released.failures.length) {
        entry.reason = released.failures[0]
        deps.log(`[knowledge] 重试知识清理失败：${released.failures[0]}`)
        return { status: 'failed', reason: released.failures[0], removed: 0, kept: 0, released: 0 }
      }
      this.entries.delete(id)
      deps.log(
        `[knowledge] 保留卡片并只撤回来源：失效 ${released.retired} 个来源，保留 ${released.detached} 条共享出处，` +
          `停止 ${released.cancelled.length} 项排队任务`
      )
      return { status: 'done', removed: 0, kept: released.detached, released: released.retired }
    }
    try {
      const result = await deps.purgeCards({
        record: entry.identity,
        confirm: { sources: [], ticket: entry.ticket ?? '' },
        cards: true
      })
      this.entries.delete(id)
      deps.log(
        `[knowledge] 重试知识清理：移除 ${result.removed.length} 张卡片，保留 ${result.kept.length} 张，` +
          `跳过 ${result.skipped.length} 个已变更来源`
      )
      return { status: 'done', removed: result.removed.length, kept: result.kept.length, released: 0 }
    } catch (error) {
      const reason = message(error)
      entry.reason = reason
      if (moved(error)) {
        // The refusal is about the range, so it stays true no matter what the
        // next attempt fails on; the downgrade stays on offer.
        entry.stale = true
        deps.log(`[knowledge] 关联知识已变化，未删除卡片：${reason}`)
        return { status: 'stale', reason, removed: 0, kept: 0, released: 0 }
      }
      deps.log(`[knowledge] 重试知识清理失败：${reason}`)
      return { status: 'failed', reason, removed: 0, kept: 0, released: 0 }
    }
  }
}
