import type { QuotaConnection } from '@shared/quota'

/** Tabs run from the models people actually use daily to the local ones. */
export const QUOTA_KIND_ORDER = ['llm', 'multimodal', 'asr', 'tts', 'local-asr'] as const
export type QuotaKindFilter = (typeof QUOTA_KIND_ORDER)[number] | 'all'

export interface QuotaKindCount { kind: QuotaKindFilter; count: number }

export interface QuotaFilterResult {
  /** Rows that survive both the query and the chosen kind. */
  rows: QuotaConnection[]
  /** Rows that survive the query, before the kind narrows them — the 全部 chip's count. */
  matched: number
  /** Kinds that survive the query, with their counts — the chip row is built from this. */
  counts: QuotaKindCount[]
  /** Chosen kind, falling back to `all` when the query emptied it. */
  kind: QuotaKindFilter
}

const kindRank = (kind: QuotaConnection['kind']): number => {
  const index = QUOTA_KIND_ORDER.indexOf(kind as (typeof QUOTA_KIND_ORDER)[number])
  return index < 0 ? QUOTA_KIND_ORDER.length : index
}

/**
 * One list, two narrowings: a free-text query over name/model/kind, and a kind chip.
 * Counts are computed after the query but before the kind, so a chip keeps showing how
 * much it would reveal. The chosen kind is resolved rather than stored, so a query that
 * removes every row of that kind falls back to "all" instead of showing an empty page.
 */
export function filterQuotaConnections(
  rows: readonly QuotaConnection[],
  query: string,
  kind: QuotaKindFilter,
  kindLabel: (kind: QuotaConnection['kind']) => string,
  nameOf: (row: QuotaConnection) => string
): QuotaFilterResult {
  const needle = query.trim().toLocaleLowerCase()
  const matched = rows.filter(row => !needle || [nameOf(row), row.model, kindLabel(row.kind)].some(field => field.toLocaleLowerCase().includes(needle)))
  const tally = new Map<QuotaKindFilter, number>()
  for (const row of matched) tally.set(row.kind as QuotaKindFilter, (tally.get(row.kind as QuotaKindFilter) ?? 0) + 1)
  const counts = [...tally.entries()].sort((a, b) => kindRank(a[0] as QuotaConnection['kind']) - kindRank(b[0] as QuotaConnection['kind'])).map(([key, count]) => ({ kind: key, count }))
  const active: QuotaKindFilter = kind !== 'all' && tally.has(kind) ? kind : 'all'
  return { rows: active === 'all' ? matched : matched.filter(row => row.kind === active), matched: matched.length, counts, kind: active }
}
