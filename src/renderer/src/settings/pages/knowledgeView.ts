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
  CardImpact,
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
 * Node colours follow the card kinds, so the preview canvas, the full canvas and
 * the chips agree on what a colour means.
 */
export function kindColor(kind: CardKind, dark: boolean): string {
  const palette: Record<CardKind, [string, string]> = {
    concept: ['#286fc1', '#8bbdff'],
    method: ['#1f8a5f', '#7fd6ae'],
    question: ['#9a6b13', '#e0be79'],
    decision: ['#8b4ca5', '#d4a8ed'],
    comparison: ['#0f7d8c', '#79d6e2'],
    reading: ['#b0552f', '#f0a986'],
    review: ['#5b6474', '#aeb8c8']
  }
  return dark ? palette[kind][1] : palette[kind][0]
}

/** Content width that fits a third card column; two gaps included in the number. */
export const GRID_THREE_WIDTH = 900

/** Content width below which one column is the only readable choice. */
export const GRID_TWO_WIDTH = 600

/**
 * Columns the card grid may use. The decision is made from the width the page
 * itself measured, not the window: the nav rail and the page margins eat ~250px,
 * so a 1080px window has roughly 780px to lay cards out in — two columns there,
 * three only once the page really has the room.
 */
export function gridColumns(availableWidth: number): 1 | 2 | 3 {
  if (availableWidth >= GRID_THREE_WIDTH) return 3
  if (availableWidth >= GRID_TWO_WIDTH) return 2
  return 1
}

/** Nodes the default page draws in its preview; the full graph asks for its own. */
export const GRAPH_PREVIEW_NODES = 40

/** Height of the preview canvas. It is a glance, not a workspace. */
export const GRAPH_PREVIEW_HEIGHT = 260

/** Topics the card face shows before it stops stacking chips. */
export const CARD_TOPIC_LIMIT = 3

/**
 * The chips a card face may print. A card with eight topics gets three and a
 * count: the grid is for scanning titles and summaries, and a chip wall would
 * push the summary out of the card. An empty topic list is allowed — many cards
 * have none, and the face then simply has no third line.
 */
export function cardTopics(topics: readonly string[], limit = CARD_TOPIC_LIMIT): { shown: string[]; rest: number } {
  const unique: string[] = []
  for (const topic of topics) {
    const text = topic.trim()
    if (text && !unique.includes(text)) unique.push(text)
  }
  const keep = Math.max(0, Math.min(limit, unique.length))
  return { shown: unique.slice(0, keep), rest: unique.length - keep }
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
 * The page's whole graph state after one answer: the newest accepted response,
 * never a union with the previous one. The backend already applied its node and
 * byte budgets, so adding an older answer back would exceed them and make the
 * reported counts lie. A ticket that is no longer current is ignored, so a slow
 * answer for a query the user already left cannot replace the newer canvas.
 */
export function acceptGraph(gate: RequestGate, ticket: number, next: KnowledgeGraph, current: KnowledgeGraph | null): KnowledgeGraph | null {
  return gate.isCurrent(ticket) ? next : current
}

export interface GraphNotice {
  /** Which budget stopped the expansion. */
  limitedBy: 'nodes' | 'bytes'
  /** Filter matches the canvas keeps; the neighbours the focus added are not part of it. */
  matched: number
  /** Cards matching the filter before any budget cut them. */
  total: number
}

/**
 * Filter matches inside one answer. `shown` counts every node the helper drew,
 * including the focus's out-of-filter neighbours, so subtracting `expanded` is
 * what keeps the denominator comparable with `total`.
 */
export function graphMatched(graph: Pick<KnowledgeGraph, 'shown' | 'expanded'>): number {
  return Math.max(0, graph.shown - graph.expanded)
}

/** The wording the canvas owes the user when the backend trimmed the graph. */
export function graphNotice(graph: KnowledgeGraph): GraphNotice | null {
  if (!graph.truncated || !graph.limitedBy) return null
  return { limitedBy: graph.limitedBy, matched: graphMatched(graph), total: graph.total }
}

export interface GraphCounts {
  /** Nodes of this answer that matched the filter: `shown - expanded`. */
  matched: number
  /** Cards matching the filter before any budget cut them. */
  total: number
  /** Of the drawn nodes, the ones the focus brought in that the filter did not match. */
  expanded: number
}

/** The three numbers the info bar owes, all from the one accepted answer. */
export function graphCounts(graph: KnowledgeGraph | null): GraphCounts {
  if (!graph) return { matched: 0, total: 0, expanded: 0 }
  return { matched: graphMatched(graph), total: graph.total, expanded: graph.expanded }
}

export interface GraphView extends ForceData {
  counts: GraphCounts
  notice: GraphNotice | null
}

const EMPTY_GRAPH: KnowledgeGraph = { nodes: [], edges: [], total: 0, shown: 0, truncated: false, limitedBy: null, focused: false, expanded: 0 }

/**
 * Everything the canvas, the node list and the info bar draw, taken from one
 * answer. The rendered nodes and links are that answer's own `nodes` and `edges`
 * (with edges whose endpoint was trimmed dropped), so the picture and the counts
 * can never disagree.
 */
export function graphView(graph: KnowledgeGraph | null): GraphView {
  const source = graph ?? EMPTY_GRAPH
  const data = toForceData(source)
  return { nodes: data.nodes, links: data.links, counts: graphCounts(graph), notice: graphNotice(source) }
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

/** The checkbox the delete dialog adds when cards still depend on the record. */
export const IMPACT_LABEL_KEY = 'knowledge.deleteImpact.cardsLabel'

/** The one line under that checkbox; both variants are fixed keys, not prose. */
export const IMPACT_DETAIL_KEY = 'knowledge.deleteImpact.cardsKeepOther'
export const IMPACT_DETAIL_ALONE_KEY = 'knowledge.deleteImpact.cardsOnlyHere'

export interface ImpactNotice {
  /** Checkbox text key; `count` is `cards`. */
  labelKey: string
  /** Cards that quote the record at all — the number in the checkbox. */
  count: number
  /** Explanation key: whether any card survives on another source. */
  detailKey: string
  /** Cards that leave with the record (their only valid source). */
  single: number
  /** Cards that stay and only lose this link. */
  multi: number
}

/**
 * The destructive option a delete dialog may offer, or `null` when nothing is
 * derived from the record. The checkbox is never pre-ticked: deleting knowledge
 * is a second decision, and `multi` is what the explanation has to name so the
 * user knows a card with another source survives instead of vanishing.
 */
export function impactNotice(impact: Pick<CardImpact, 'cards' | 'single' | 'multi'>): ImpactNotice | null {
  const count = Math.max(0, Math.trunc(impact.cards))
  if (count === 0) return null
  const single = Math.min(count, Math.max(0, Math.trunc(impact.single)))
  const multi = count - single
  return {
    labelKey: IMPACT_LABEL_KEY,
    count,
    detailKey: multi > 0 ? IMPACT_DETAIL_KEY : IMPACT_DETAIL_ALONE_KEY,
    single,
    multi
  }
}

/** Rows the note-detail section asks for first. */
export const CARDS_SECTION_LIMIT = 5

/**
 * Requests the section may spend, the first page included. The section is a
 * footnote of the note, not a second card browser: three pages of five cover
 * what a single record generates, and the rest belongs to the knowledge page.
 */
export const CARDS_SECTION_REQUESTS = 3

export const CARDS_SECTION_TITLE_KEY = 'knowledge.noteCards.title'

export interface CardsSectionInput {
  /** Rows already in hand for the open note. */
  shown: number
  /** `total` from the last page: every card the backend counted for this record. */
  total: number
  /** `hasMore` from the last page. */
  hasMore: boolean
  /** Requests already spent on this note, the first page counted as 1. */
  requests: number
}

export interface CardsSection {
  titleKey: string
  /** No card at all: the section shows one line and nothing else. */
  empty: boolean
  /** The real total, never `shown`. */
  total: number
  shown: number
  /** 「查看全部」 is offered while another page is allowed. */
  moreRows: boolean
  /** Cards exist beyond the budget: the section says so instead of pretending it ended. */
  capped: boolean
}

/**
 * What the note-detail section may render. Paging follows the backend's
 * `hasMore`, and the request budget is a cap on the UI, so a record with forty
 * cards cannot turn the note into an endless list — it says it is capped.
 */
export function cardsSection(input: CardsSectionInput): CardsSection {
  const total = Math.max(0, Math.trunc(input.total))
  const shown = Math.min(total, Math.max(0, Math.trunc(input.shown)))
  const spent = Math.max(0, Math.trunc(input.requests))
  const moreRows = input.hasMore && spent < CARDS_SECTION_REQUESTS && shown < total
  return {
    titleKey: CARDS_SECTION_TITLE_KEY,
    empty: shown === 0 && total === 0,
    total,
    shown,
    moreRows,
    capped: input.hasMore && !moreRows
  }
}

/** A page of cards, as the backend answers one request for a record. */
export interface CardPage<T extends { id: string } = { id: string }> {
  items: T[]
  total: number
  hasMore: boolean
  nextOffset?: number | null
}

/** Which part of the section one answer is allowed to touch. */
export type CardPageMode = 'replace' | 'append' | 'refresh'

export interface CardSectionState<T extends { id: string } = { id: string }> {
  rows: T[]
  total: number
  more: boolean
  offset: number | null
  pages: number
}

/**
 * How many rows a refresh asks for: everything already on screen. A change
 * notice updates the range the reader is looking at; it must not pull the
 * section back to its first page.
 */
export function cardRefreshLimit(shown: number): number {
  return Math.max(CARDS_SECTION_LIMIT, Math.max(0, Math.trunc(shown)))
}

/**
 * The section after one answer. `replace` and `append` are the reader's own
 * pages and spend the request budget; `refresh` follows a change notice, so it
 * updates the loaded rows in place and spends nothing. Rows are deduplicated by
 * id and keep the backend's order, so an overlap cannot show a card twice.
 */
export function mergeCards<T extends { id: string }>(
  current: Pick<CardSectionState<T>, 'rows' | 'pages'>,
  page: CardPage<T>,
  mode: CardPageMode
): CardSectionState<T> {
  const known = new Set<string>()
  const rows = (mode === 'append' ? [...current.rows, ...page.items] : page.items).filter((row) => {
    if (known.has(row.id)) return false
    known.add(row.id)
    return true
  })
  return {
    rows,
    total: Math.max(0, Math.trunc(page.total)),
    more: page.hasMore,
    offset: page.nextOffset ?? null,
    pages: mode === 'refresh' ? current.pages : current.pages + 1
  }
}

/**
 * One note's card section, driven by the reader's paging and by background change
 * notices. The two must not cancel each other: a notice that arrives while a manual
 * page is loading is remembered as "refresh when that page lands", and a manual page
 * started while a refresh is in flight makes that refresh's answer stale instead of
 * letting it replace what the reader just asked for.
 */
export interface CardPagerDeps<T extends { id: string }> {
  page(noteId: string, offset: number, limit: number): Promise<CardPage<T>>
  render(state: CardSectionState<T>): void
  loading(on: boolean): void
  error(message: string): void
  message(error: unknown): string
}

export function emptySection<T extends { id: string }>(): CardSectionState<T> {
  return { rows: [], total: 0, more: false, offset: null, pages: 0 }
}

export class CardPager<T extends { id: string } = { id: string }> {
  private noteId: string | null = null
  private current: CardSectionState<T> = { rows: [], total: 0, more: false, offset: null, pages: 0 }
  /** Ticket of the newest manual request; an older answer cannot touch the section. */
  private manual = 0
  /** How many manual requests are in flight, so a refresh waits for all of them. */
  private running = 0
  private refreshTicket = 0
  private refreshing = false
  /** A notice arrived while something else was in flight: refresh once afterwards. */
  private queued = false

  constructor(private readonly deps: () => CardPagerDeps<T>) {}

  get state(): CardSectionState<T> {
    return this.current
  }

  get openNote(): string | null {
    return this.noteId
  }

  /** Opening a note (or a retry of its first page) replaces the section. */
  open(noteId: string | null): void {
    this.noteId = noteId
    this.manual += 1
    this.refreshTicket += 1
    this.refreshing = false
    this.queued = false
    this.current = { rows: [], total: 0, more: false, offset: null, pages: 0 }
    this.deps().render(this.current)
    if (!noteId) {
      this.deps().loading(false)
      this.deps().error('')
      return
    }
    void this.load(noteId, 0, 'replace')
  }

  /** The reader's next page: offset comes from the page the backend last handed out. */
  append(): void {
    const noteId = this.noteId
    if (!noteId || this.current.offset === null) return
    void this.load(noteId, this.current.offset, 'append')
  }

  /** A change notice: update what is shown, and never spend the reader's budget. */
  refresh(): void {
    void this.follow()
  }

  private async follow(): Promise<void> {
    const noteId = this.noteId
    if (!noteId) return
    if (this.running > 0) {
      // The reader is already waiting on a page; follow it with one refresh instead
      // of racing it (a second request would answer a range that is about to change).
      this.queued = true
      return
    }
    if (this.refreshing) {
      this.queued = true
      return
    }
    const ticket = ++this.refreshTicket
    const manualAt = this.manual
    this.refreshing = true
    try {
      const page = await this.deps().page(noteId, 0, cardRefreshLimit(this.current.rows.length))
      if (!this.mine(noteId) || ticket !== this.refreshTicket || manualAt !== this.manual) return
      this.apply(mergeCards(this.current, page, 'refresh'))
    } catch (error) {
      if (!this.mine(noteId) || ticket !== this.refreshTicket) return
      // A failed refresh keeps the rows on screen; it only speaks when there is
      // nothing to keep, so the section never claims to be empty on its own.
      if (this.current.rows.length === 0) this.deps().error(this.deps().message(error))
    } finally {
      if (ticket === this.refreshTicket) this.refreshing = false
      if (this.queued && this.running === 0 && this.mine(noteId)) {
        this.queued = false
        void this.follow()
      }
    }
  }

  private async load(noteId: string, offset: number, mode: 'replace' | 'append'): Promise<void> {
    const ticket = ++this.manual
    this.running += 1
    const deps = this.deps()
    deps.loading(true)
    deps.error('')
    if (this.refreshing) this.queued = true
    try {
      const page = await deps.page(noteId, offset, CARDS_SECTION_LIMIT)
      if (!this.mine(noteId) || ticket !== this.manual) return
      this.apply(mergeCards(this.current, page, mode))
    } catch (error) {
      if (this.mine(noteId) && ticket === this.manual) deps.error(deps.message(error))
    } finally {
      this.running -= 1
      // Only the newest manual request closes the spinner: an older answer landing
      // later must not say the reader's current page finished loading.
      if (ticket === this.manual) deps.loading(false)
      if (this.queued && this.running === 0 && this.mine(noteId)) {
        this.queued = false
        void this.follow()
      }
    }
  }

  private mine(noteId: string): boolean {
    return this.noteId === noteId
  }

  private apply(next: CardSectionState<T>): void {
    this.current = next
    this.deps().render(next)
  }
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
