/**
 * Pure view model for the 知识库 page.
 *
 * Everything the page can decide without a DOM lives here — the request built
 * from the filters, paging over `nextOffset`, the stale-response gate, the
 * master/detail decision, relation and profile grouping, the merge preview and
 * the graph adaptation — so `knowledgeView.test.ts` can pin the behaviour
 * without mounting React. The page only wires this module to MUI and to
 * `window.api.knowledge`.
 */

import type {
  CardKind,
  CardQuery,
  ExtractSourceResult,
  GraphEdge,
  GraphNode,
  KnowledgeCard,
  KnowledgeCardPage,
  KnowledgeCardSummary,
  KnowledgeGraph,
  KnowledgeModelInfo,
  ProfileCategory,
  ProfileItem,
  RelationKind,
  RelationList,
  RelationNeighbour
} from '@shared/knowledge'

/** One page of the card list; the backend caps `limit` at 30. */
export const CARD_PAGE_SIZE = 20

/** Every kind the backend knows, in the order the picker offers them. */
export const CARD_KINDS: readonly CardKind[] = ['concept', 'method', 'question', 'decision', 'comparison', 'reading', 'review']

/** Relation kinds, in the order the picker offers them. */
export const RELATION_KINDS: readonly RelationKind[] = ['contains', 'prerequisite', 'applies', 'contrast', 'derives']

/** Profile groups, in the order the panel shows them. */
export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['explicit', 'observed', 'inferred']

export interface CardFilters {
  /** Exact topic, `''` for no topic constraint. */
  topic: string
  /** `''` for every kind. */
  kind: CardKind | ''
  /** Favourites only. */
  favorite: boolean
  /** Free text; routes the request to `searchCards`. */
  query: string
}

export const EMPTY_FILTERS: CardFilters = { topic: '', kind: '', favorite: false, query: '' }

export function filtersActive(filters: CardFilters): boolean {
  return Boolean(filters.topic || filters.kind || filters.favorite || filters.query.trim())
}

export interface CardRequest {
  /** `true` means `searchCards`, `false` means `listCards`. */
  search: boolean
  query: CardQuery & { query?: string }
}

/**
 * Builds the one request a filter state needs. A query with text goes to
 * `searchCards` because only the backend has the full-text index; everything
 * else is a plain `listCards`, so the page never filters rows it already has.
 */
export function cardRequest(filters: CardFilters, offset: number, limit = CARD_PAGE_SIZE): CardRequest {
  const query: CardQuery & { query?: string } = { offset: Math.max(0, Math.trunc(offset)), limit }
  if (filters.topic) query.topic = filters.topic
  if (filters.kind) query.kind = filters.kind
  if (filters.favorite) query.favorite = true
  const text = filters.query.trim()
  if (!text) return { search: false, query }
  return { search: true, query: { ...query, query: text } }
}

export interface CardList {
  items: KnowledgeCardSummary[]
  /** Matching cards before paging, as the backend counted them. */
  total: number
  /** `null` once the backend has nothing more to give. */
  nextOffset: number | null
}

export const EMPTY_LIST: CardList = { items: [], total: 0, nextOffset: null }

/**
 * Appends one page, or replaces everything when `current` is `null`.
 *
 * Paging always continues from `page.nextOffset` and never from
 * `offset + limit`: a card deleted between two requests shifts every later row,
 * and arithmetic on the old offset silently skips one. Rows are de-duplicated by
 * id so a refresh that overlaps the previous page does not double a card.
 */
export function mergePage(current: CardList | null, page: KnowledgeCardPage): CardList {
  const items: KnowledgeCardSummary[] = []
  const seen = new Set<string>()
  for (const row of [...(current?.items ?? []), ...page.items]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    items.push(row)
  }
  return { items, total: page.total, nextOffset: page.nextOffset ?? null }
}

/**
 * Monotonic request gate. Every request takes a ticket; only the newest ticket
 * may write, so a slow answer for a filter the user already left cannot replace
 * the newer selection's rows.
 */
export interface RequestGate {
  next(): number
  isCurrent(ticket: number): boolean
}

export function createGate(): RequestGate {
  let issued = 0
  return {
    next: () => {
      issued += 1
      return issued
    },
    isCurrent: (ticket: number) => ticket === issued
  }
}

/** The row a selection still points at, or `null` after a filter change. */
export function selectedSummary(list: CardList, id: string | null): KnowledgeCardSummary | null {
  if (!id) return null
  return list.items.find((row) => row.id === id) ?? null
}

export type PaneMode = 'split' | 'list' | 'detail'

/** Wide windows show the three panes; narrow ones swap master and detail. */
export function paneMode(wide: boolean, hasSelection: boolean): PaneMode {
  if (wide) return 'split'
  return hasSelection ? 'detail' : 'list'
}

/**
 * Width the split actually needs: a 320px list plus a card pane that can still
 * show a body. The window breakpoint is not a substitute — the nav rail and the
 * page margins take ~250px away from it, so a 900px window has no split left.
 */
export const SPLIT_MIN_WIDTH = 720

export function splitFit(availableWidth: number): boolean {
  return availableWidth >= SPLIT_MIN_WIDTH
}

/** Pane layout from the space the page really has, measured on its own box. */
export function paneModeFor(availableWidth: number, hasSelection: boolean): PaneMode {
  return paneMode(splitFit(availableWidth), hasSelection)
}

export type LibraryEmpty = 'none' | 'library' | 'filters'

/**
 * Empty copy is a choice, not a guess: a library with cards but no matches asks
 * for a filter reset, an empty library explains what fills it.
 */
export function emptyState(input: { shown: number; filters: CardFilters }): LibraryEmpty {
  if (input.shown > 0) return 'none'
  return filtersActive(input.filters) ? 'filters' : 'library'
}

/** i18n key for a card kind and for a relation kind. */
export function kindKey(kind: CardKind): string {
  return `knowledge.kinds.${kind}`
}

export function relationKey(kind: RelationKind): string {
  return `knowledge.relations.${kind}`
}

/** i18n key for where a source came from. */
export function sourceKindKey(kind: string): string {
  return `knowledge.sources.${kind}`
}

export interface RelationGroups {
  out: RelationNeighbour[]
  in: RelationNeighbour[]
  total: number
}

/**
 * A card lists the relations it starts and the ones pointing at it separately:
 * 包含 and 前置 read differently depending on the direction, so mixing them in
 * one list would mislabel half of them.
 */
export function groupRelations(list: RelationList): RelationGroups {
  const out: RelationNeighbour[] = []
  const incoming: RelationNeighbour[] = []
  for (const row of list.items) (row.direction === 'out' ? out : incoming).push(row)
  return { out, in: incoming, total: list.total }
}

export interface MergePreview {
  title: string
  body: string
  /** De-duplicated source ids, both cards counted once. */
  sourceIds: string[]
  topics: string[]
}

/**
 * What the user is about to confirm: the kept card's title, both bodies joined,
 * and the source and topic sets that survive the merge. Relations are not
 * previewed here because their count is the backend's answer (`MergedCards`).
 */
export function mergePreview(keep: KnowledgeCard, merged: KnowledgeCard): MergePreview {
  const parts = [keep.body.trim(), merged.body.trim()].filter((part) => part.length > 0)
  const sourceIds: string[] = []
  for (const id of [...keep.sourceIds, ...merged.sourceIds]) if (!sourceIds.includes(id)) sourceIds.push(id)
  const topics: string[] = []
  for (const topic of [...keep.topics, ...merged.topics]) if (!topics.includes(topic)) topics.push(topic)
  return { title: keep.title, body: parts.join('\n\n'), sourceIds, topics }
}

export function mergeQuery(keep: KnowledgeCard, merged: KnowledgeCard): { keepId: string; mergeId: string; keepRevision: number; mergeRevision: number } {
  return { keepId: keep.id, mergeId: merged.id, keepRevision: keep.revision, mergeRevision: merged.revision }
}

export interface ForceNode extends GraphNode {
  x?: number
  y?: number
  fx?: number
  fy?: number
}

export interface ForceLink {
  id: string
  source: string
  target: string
  kind: RelationKind
  origin: GraphEdge['origin']
}

export interface ForceData {
  nodes: ForceNode[]
  links: ForceLink[]
}

export function toForceData(graph: KnowledgeGraph): ForceData {
  const ids = new Set(graph.nodes.map((node) => node.id))
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    links: graph.edges
      .filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId))
      .map((edge) => ({ id: edge.id, source: edge.fromId, target: edge.toId, kind: edge.kind, origin: edge.origin }))
  }
}

/**
 * Union of two graph answers, by id. Expanding one hop must not delete what the
 * canvas already shows, and must not duplicate it either. The counts always come
 * from the newer answer, which is the one that knows the current budget.
 */
export function mergeGraph(current: KnowledgeGraph | null, next: KnowledgeGraph): KnowledgeGraph {
  if (!current) return next
  const nodes = new Map(current.nodes.map((node) => [node.id, node]))
  for (const node of next.nodes) nodes.set(node.id, node)
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]))
  for (const edge of next.edges) edges.set(edge.id, edge)
  const ids = new Set(nodes.keys())
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId)),
    total: next.total,
    shown: next.shown,
    truncated: next.truncated,
    limitedBy: next.limitedBy,
    focused: next.focused,
    expanded: next.expanded
  }
}

export interface GraphNotice {
  /** Which budget stopped the expansion. */
  limitedBy: 'nodes' | 'bytes'
  total: number
  shown: number
}

/** The wording the canvas owes the user when the backend trimmed the graph. */
export function graphNotice(graph: KnowledgeGraph): GraphNotice | null {
  if (!graph.truncated || !graph.limitedBy) return null
  return { limitedBy: graph.limitedBy, total: graph.total, shown: graph.shown }
}

export interface ProfileGroup {
  category: ProfileCategory
  items: ProfileItem[]
}

/** Fixed category order, empty categories dropped, order inside a group kept. */
export function groupProfile(items: readonly ProfileItem[]): ProfileGroup[] {
  return PROFILE_CATEGORIES.map((category) => ({ category, items: items.filter((item) => item.category === category) })).filter(
    (group) => group.items.length > 0
  )
}

export interface ExtractStatus {
  /** `true` only when the helper really took the source back into the queue. */
  queued: boolean
  count: number
  /** The helper's own words when it queued nothing; the row shows them as-is. */
  reason: string
}

/**
 * What `extractSource` answered, in the shape the source row shows. Zero queued
 * is not an error: the helper says why (capacity, needs reread, already queued)
 * and that reason is the only honest thing to display.
 */
export function extractStatus(result: Pick<ExtractSourceResult, 'queued' | 'reason'>): ExtractStatus {
  const count = Math.max(0, Math.trunc(result.queued))
  return { queued: count > 0, count, reason: (result.reason ?? '').trim() }
}

export interface ModelOption {
  id: string
  label: string
}

export interface ModelView {
  /** Enabled profiles only: a disabled one can never receive the request. */
  options: ModelOption[]
  /** The stored choice that is no longer selectable, so the select can name it. */
  staleId: string | null
  effectiveLabel: string
  /** `true` whenever what is stored and what the helper would use differ. */
  fallback: boolean
}

/**
 * The model select from the helper's own report. Rendering `settings.profiles`
 * directly lists disabled entries as if they were usable; this filters them and
 * still names an unavailable stored choice instead of silently showing another.
 */
export function modelView(info: KnowledgeModelInfo): ModelView {
  const options = info.profiles
    .filter((profile) => profile.enabled)
    .map((profile) => ({ id: profile.id, label: profile.label }))
  const staleId = info.selectedId && !options.some((option) => option.id === info.selectedId) ? info.selectedId : null
  return { options, staleId, effectiveLabel: info.effectiveLabel, fallback: info.fallback || staleId !== null }
}
