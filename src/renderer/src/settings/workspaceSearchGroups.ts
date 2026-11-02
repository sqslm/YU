import type { LocalRecord } from '@shared/workspace'

/**
 * The order groups appear in: conversations first (usually what people search
 * for), then the records they wrote or scheduled, then the log of what the
 * assistant saw. Kinds the query did not match drop out entirely, so a search
 * with a single kind of hit still shows exactly one header.
 */
export const SEARCH_GROUPS: Array<LocalRecord['kind']> = ['chat', 'note', 'event', 'reminder', 'history']

export interface SearchGroup {
  kind: LocalRecord['kind']
  rows: LocalRecord[]
}

/** Hits bucketed by kind, in `SEARCH_GROUPS` order, keeping their relevance order inside each bucket. */
export function groupRecords(items: LocalRecord[]): SearchGroup[] {
  return SEARCH_GROUPS
    .map(kind => ({ kind, rows: items.filter(item => item.kind === kind) }))
    .filter(group => group.rows.length > 0)
}
