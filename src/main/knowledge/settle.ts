import type { FindSourceInput, SourceIdentity } from '@shared/knowledge'
import { RecordReleaser, type ReleaseOutcome } from './release'

export type SettleChannel = 'chat' | 'note'

/**
 * The key one record's registration lives under. A note id and a thread id are
 * different records even when they read the same, so the channel is part of it.
 */
export function settleKey(channel: SettleChannel, id: string): string {
  return `${channel}:${id}`
}

/**
 * One owner for a record's whole deletion: the row write and the knowledge
 * settlement both, so the store's own change callbacks stay out of the way.
 *
 * The count matters as much as the key. Two overlapping deletes of the same
 * record must not release the guard when the first one returns — the second is
 * still writing and settling — so the registration is dropped only when the last
 * holder leaves.
 */
export class SettleRegistry {
  private readonly held = new Map<string, number>()

  constructor(private readonly releaser: RecordReleaser) {}

  /** Whether this record's deletion is still in flight. */
  holds(channel: SettleChannel, id: string): boolean {
    return this.held.has(settleKey(channel, id))
  }

  /** How many deletions of this record are in flight. */
  depth(channel: SettleChannel, id: string): number {
    return this.held.get(settleKey(channel, id)) ?? 0
  }

  /** Runs the delete under this record's registration, whatever the body does. */
  async run<T>(channel: SettleChannel, id: string, body: () => Promise<T>): Promise<T> {
    const key = settleKey(channel, id)
    this.held.set(key, (this.held.get(key) ?? 0) + 1)
    try {
      return await body()
    } finally {
      const left = (this.held.get(key) ?? 1) - 1
      if (left > 0) this.held.set(key, left)
      else this.held.delete(key)
    }
  }

  /** Hands the deleted record's claims back, keeping cards and other readers. */
  release(input: FindSourceInput, reason: string): Promise<ReleaseOutcome> {
    return this.releaser.release(input, reason)
  }

  /** Cleanups waiting for the helper to answer again. */
  get waiting(): number {
    return this.releaser.waiting
  }

  /** Re-runs every cleanup still waiting and reports how many finished. */
  retry(): Promise<number> {
    return this.releaser.retry()
  }
}

/** What one record's deletion needs from the library, as the app wires it. */
export interface SettleRecordDeps {
  release: (input: FindSourceInput, reason: string) => Promise<ReleaseOutcome>
  /** Whether the library still has anything worth settling. */
  active: () => boolean
  find: (input: FindSourceInput) => Promise<{ sources: { id: string; version: string; state: string }[] }>
  purgeCards: (input: {
    record: SourceIdentity
    confirm: { sources: { id: string; version: string }[]; ticket: string }
    cards: boolean
  }) => Promise<{ removed: string[]; kept: string[]; skipped: string[] }>
  log: (line: string) => void
}

/**
 * Settles one deleted record's knowledge.
 *
 * The default keeps every card and the link that says where it came from: it only
 * takes back what this record really owned, so a material another record also read
 * keeps its row and its reader's queued work. A failed release is reported, never
 * swallowed into a false success — the record is already gone, so the caller sees a
 * retryable partial failure while the releaser keeps the same call queued.
 *
 * With cards ticked, the helper re-checks the versions and the ticket inside its
 * write transaction, so a preview that no longer holds refuses instead of widening.
 */
export async function settleRecordKnowledge(
  deps: SettleRecordDeps,
  input: FindSourceInput,
  identity: SourceIdentity,
  options: { cards?: boolean; ticket?: string } = {}
): Promise<void> {
  // A switched-off loop must not block the invalidation of knowledge that already
  // exists; with no database there is nothing to settle and no helper to wake.
  if (!deps.active()) return
  const found = await deps.find(input)
  const sources = found.sources
    .filter(source => source.state !== 'invalid')
    .map(source => ({ id: source.id, version: source.version }))
  // Nothing was published for this record: there is no knowledge to settle.
  if (!sources.length) return
  if (!options.cards) {
    const released = await deps.release(input, '记录已删除')
    if (released.failures.length) throw new Error(released.failures[0])
    deps.log(
      `[knowledge] 记录删除后：失效 ${released.retired} 个来源，保留 ${released.detached} 条共享出处，` +
        `停止 ${released.cancelled.length} 项排队任务，卡片与来源关联保留`
    )
    return
  }
  const result = await deps.purgeCards({
    record: identity,
    confirm: { sources, ticket: options.ticket ?? '' },
    cards: true
  })
  deps.log(
    `[knowledge] 记录删除后：移除 ${result.removed.length} 张卡片，保留 ${result.kept.length} 张，` +
      `跳过 ${result.skipped.length} 个已变更来源`
  )
}
