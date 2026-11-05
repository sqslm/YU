import type { CleanupPending, CleanupRetryResult } from '@shared/knowledge'

/**
 * One row of "this record was deleted but its knowledge could not be settled".
 *
 * Pages never own these: the main process holds the identity and the confirmed
 * ticket, and this is just the projection a page renders and acts on by id.
 */
export interface CleanupRow {
  id: string
  reason: string
  /** The helper refused the confirmed range, so only the downgrade can finish it. */
  stale: boolean
  at: number
}

/** What one page shows for the cleanups its channel still owes the user. */
export interface CleanupQueue {
  rows: CleanupRow[]
  /** Ids with a retry in flight: they are the ones whose controls are disabled. */
  busy: string[]
  /** Ids that are already settled; a late reply about them changes nothing. */
  finished: string[]
}

export const EMPTY_QUEUE: CleanupQueue = { rows: [], busy: [], finished: [] }

function newestFirst(rows: CleanupRow[]): CleanupRow[] {
  return [...rows].sort((left, right) => right.at - left.at)
}

function toRow(pending: CleanupPending, previous?: CleanupRow): CleanupRow {
  return {
    id: pending.id,
    reason: pending.reason,
    // Once the range moved it stays moved: a later failure must not take the
    // downgrade away, and a stale list answer must not resurrect it either.
    stale: pending.stale === true || previous?.stale === true,
    at: pending.at ?? previous?.at ?? 0
  }
}

/**
 * Folds a channel query into what the page already shows.
 *
 * The query is the recovery path for a page that was unmounted or a window that
 * was closed and reopened, so it must never undo newer state: finished ids stay
 * finished, a row that is mid-retry keeps its `stale`, and rows the page learned
 * from a delete reply are kept even when the answer was read before they existed.
 */
export function mergeList(queue: CleanupQueue, pending: CleanupPending[]): CleanupQueue {
  const rows = new Map(queue.rows.map(row => [row.id, row]))
  for (const entry of pending) {
    if (queue.finished.includes(entry.id)) continue
    rows.set(entry.id, toRow(entry, rows.get(entry.id)))
  }
  return { ...queue, rows: newestFirst([...rows.values()]) }
}

/** Adds the handle one delete came back with, without touching the other rows. */
export function addPending(queue: CleanupQueue, pending: CleanupPending): CleanupQueue {
  if (queue.finished.includes(pending.id)) return queue
  const rows = queue.rows.filter(row => row.id !== pending.id)
  rows.push(toRow(pending))
  return { ...queue, rows: newestFirst(rows) }
}

export function startRetry(queue: CleanupQueue, id: string): CleanupQueue {
  if (queue.busy.includes(id)) return queue
  return { ...queue, busy: [...queue.busy, id] }
}

/** Applies one retry's answer to that id only. */
export function settleRetry(queue: CleanupQueue, id: string, result: CleanupRetryResult): CleanupQueue {
  const busy = queue.busy.filter(entry => entry !== id)
  if (result.status === 'done') {
    return {
      rows: queue.rows.filter(row => row.id !== id),
      busy,
      finished: queue.finished.includes(id) ? queue.finished : [...queue.finished, id]
    }
  }
  const rows = queue.rows.map(row =>
    row.id === id
      ? {
          ...row,
          reason: result.reason ?? row.reason,
          stale: result.status === 'stale' ? true : row.stale
        }
      : row
  )
  return { ...queue, rows, busy }
}

/** The request itself failed: the row stays exactly as it was, only the lock clears. */
export function abandonRetry(queue: CleanupQueue, id: string): CleanupQueue {
  return { ...queue, busy: queue.busy.filter(entry => entry !== id) }
}

export function isBusy(queue: CleanupQueue, id: string): boolean {
  return queue.busy.includes(id)
}
