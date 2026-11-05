import type { FindSourceInput } from '@shared/knowledge'

/** The identity one record has for the helper, as a release command carries it. */
export interface ReleaseTarget {
  channel: 'note' | 'chat'
  originRef?: string
  groupKey?: string
}

/** The helper call one record's deletion needs; the host object satisfies this. */
export interface ReleaseHost {
  releaseRecord(
    target: ReleaseTarget,
    reason: string
  ): Promise<{ retired: number; detached: number; cancelled: string[] }>
}

export interface ReleaseOutcome {
  /** Rows only this record supported: the helper retired them. */
  retired: number
  /** Rows another record — or an older claim that cannot be proved — still supports. */
  detached: number
  /** Queued work that lost its last live row and stopped. */
  cancelled: string[]
  failures: string[]
}

/** The record a deletion is about, or nothing when the input carries no identity. */
export function releaseTarget(input: FindSourceInput): ReleaseTarget | null {
  if ('groupKey' in input && input.groupKey && (!('channel' in input) || input.channel === 'chat')) {
    return { channel: 'chat', groupKey: input.groupKey }
  }
  if ('originRef' in input && input.originRef) return { channel: 'note', originRef: input.originRef }
  return null
}

function key(target: ReleaseTarget): string {
  return target.channel === 'chat' ? `chat:${target.groupKey}` : `note:${target.originRef}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Hands deleted records' claims back to the library, keeping cards and other
 * readers, and finishes the job later when the helper cannot be reached now.
 *
 * The helper does the work in one transaction over every row the record holds, so
 * this never depends on how many rows a preview showed. A cleanup that fails stays
 * queued: the record is already gone, so the only honest thing left is to run the
 * same idempotent call again — the next helper answer does exactly that.
 */
export class RecordReleaser {
  private readonly pending = new Map<string, { target: ReleaseTarget; reason: string }>()

  constructor(
    private readonly host: () => ReleaseHost,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** Cleanups waiting for the helper to answer again. */
  get waiting(): number {
    return this.pending.size
  }

  async release(input: FindSourceInput, reason: string): Promise<ReleaseOutcome> {
    const target = releaseTarget(input)
    const outcome: ReleaseOutcome = { retired: 0, detached: 0, cancelled: [], failures: [] }
    if (!target) return outcome
    try {
      const released = await this.host().releaseRecord(target, reason)
      this.pending.delete(key(target))
      return {
        retired: released.retired,
        detached: released.detached,
        cancelled: released.cancelled,
        failures: []
      }
    } catch (error) {
      this.pending.set(key(target), { target, reason })
      outcome.failures.push(message(error))
      return outcome
    }
  }

  /** Re-runs every cleanup still waiting, and reports how many finished. */
  async retry(): Promise<number> {
    let finished = 0
    for (const [id, entry] of [...this.pending]) {
      try {
        const released = await this.host().releaseRecord(entry.target, entry.reason)
        this.pending.delete(id)
        finished += 1
        this.log(
          `[knowledge] 补做知识清理：失效 ${released.retired} 个来源，保留 ${released.detached} 条共享出处`
        )
      } catch {
        // Still unreachable: it stays queued for the next answer.
      }
    }
    return finished
  }
}
