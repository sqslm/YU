import type { CleanupPending, CleanupSnapshot } from '@shared/knowledge'

/** One row as the page shows it. */
export interface CleanupRow {
  id: string
  reason: string
  stale: boolean
  at: number
  busy: boolean
}

/**
 * What one page knows about its channel.
 *
 * `revision` is the main process's, not the page's: a reply carrying an older
 * revision than the page already holds is dropped, so a late list answer, a late
 * delete reply and a late retry reply cannot overwrite what happened after them,
 * and a row that was settled cannot be brought back by them.
 */
export interface CleanupQueue {
  revision: number
  rows: CleanupRow[]
}

export const EMPTY_QUEUE: CleanupQueue = { revision: 0, rows: [] }

function row(input: CleanupPending): CleanupRow {
  return {
    id: input.id,
    reason: input.reason,
    stale: Boolean(input.stale),
    at: input.at ?? 0,
    busy: Boolean(input.busy)
  }
}

/**
 * Replaces the page's view with the channel's authoritative rows.
 *
 * Anything older than what the page already applied is ignored — including a
 * mount-time query that resolves after a change notification already arrived.
 */
export function applySnapshot(queue: CleanupQueue, snapshot: CleanupSnapshot): CleanupQueue {
  if (snapshot.revision < queue.revision) return queue
  return {
    revision: snapshot.revision,
    rows: snapshot.rows.map(row).sort((left, right) => right.at - left.at)
  }
}

/**
 * Blocks a row for an attempt this page just started.
 *
 * The click has to take effect before the helper answers, so the row is marked
 * busy locally; the main process's own `busy` and the single-flight promise take
 * over as soon as the next snapshot lands.
 */
export function markRetry(queue: CleanupQueue, id: string): CleanupQueue {
  return {
    revision: queue.revision,
    rows: queue.rows.map(entry => (entry.id === id ? { ...entry, busy: true } : entry))
  }
}

/** The attempt never reached the register, so the row is actionable again. */
export function clearRetry(queue: CleanupQueue, id: string): CleanupQueue {
  return {
    revision: queue.revision,
    rows: queue.rows.map(entry => (entry.id === id ? { ...entry, busy: false } : entry))
  }
}

export function isBusy(queue: CleanupQueue, id: string): boolean {
  return queue.rows.some(entry => entry.id === id && entry.busy)
}
