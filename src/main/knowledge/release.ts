import type { FindSourceInput, SourceIdentity } from '@shared/knowledge'

/** The helper calls one record's deletion needs; the host object satisfies this. */
export interface ReleaseHost {
  findSources(input: FindSourceInput): Promise<{ sources: { id: string; state: string }[] }>
  invalidateSource(id: string, reason: string): Promise<unknown>
  invalidateTask(group: { channel: 'note'; groupKey: string }, reason: string): Promise<unknown>
  invalidateThread(threadKey: string, reason: string): Promise<{ cancelled: string[]; detached: string[] }>
}

export interface ReleaseOutcome {
  /** Sources whose claim this record gave up, retired or left to their other owners. */
  sources: string[]
  /** Sources another record also supports: the row, its cards and its readers stay. */
  detached: string[]
  /** Queued work that belonged to this record alone. */
  cancelled: string[]
  /** Invalidation failures; the record is already gone, so the caller reports them. */
  failures: string[]
}

/**
 * Hands one deleted record's claims back to the library, keeping cards and other
 * readers. A material two conversations read stays for the other one; a source
 * nothing else supports is retired.
 */
export async function releaseRecord(
  host: ReleaseHost,
  input: FindSourceInput,
  identity: SourceIdentity,
  reason: string
): Promise<ReleaseOutcome> {
  const found = await host.findSources(input)
  const sources = found.sources.filter(source => source.state !== 'invalid')
  const outcome: ReleaseOutcome = { sources: [], detached: [], cancelled: [], failures: [] }
  // Nothing was published for this record: there is no knowledge to settle.
  if (!sources.length) return outcome

  // A conversation is the record, so the helper settles it by owner: a page read
  // elsewhere survives, and only this conversation's queued work stops.
  if ('groupKey' in identity && identity.channel === 'chat') {
    const released = await host.invalidateThread(identity.groupKey, reason)
    return {
      sources: sources.map(source => source.id),
      detached: released.detached,
      cancelled: released.cancelled,
      failures: []
    }
  }

  // A note is only ever its own record: no other record claims what it published.
  for (const source of sources) {
    try {
      await host.invalidateSource(source.id, reason)
      outcome.sources.push(source.id)
    } catch (error) {
      outcome.failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if ('channel' in input) {
    const group = 'groupKey' in input ? input.groupKey : input.originRef
    await host
      .invalidateTask({ channel: 'note', groupKey: group }, reason)
      .catch(() => undefined)
  }
  return outcome
}
