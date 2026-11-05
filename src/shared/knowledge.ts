/**
 * The knowledge/profile contract shared by the main process, the preload bridge
 * and the renderer.
 *
 * This file is type-checked by both tsconfigs, so it must stay free of Node and
 * Electron imports. It carries the wire shapes only: the SQL, the fingerprints,
 * the migrations and every ordering decision live in the Rust helper.
 */

/** Protocol version of the helper's stdin/stdout pipe. */
export const KNOWLEDGE_PROTOCOL_VERSION = 1

/**
 * Limits enforced by the helper. They are repeated here so the bridge can fail
 * fast with the same numbers instead of round-tripping an invalid request.
 */
export const KNOWLEDGE_LIMITS = {
  /** Largest single UTF-8 frame. */
  frame: 2 * 1024 * 1024,
  id: 128,
  title: 200,
  summary: 2000,
  body: 200000,
  query: 200,
  topic: 100,
  topics: 32,
  page: 30,
  maxPage: 100,
  /** Revisions one card may return; the oldest are dropped. */
  revisions: 20,
  /** Nodes a graph query returns before it truncates the view. */
  nodes: 200,
  /** Total deadline of one data request. */
  requestMs: 15_000,
  /** Total deadline of a request that waits for a model callback. */
  modelRequestMs: 120_000,
  /** The helper exits after this long without work. */
  idleMs: 120_000
} as const

export type SourceKind = 'note' | 'chat' | 'web' | 'document'
export type SourceState = 'active' | 'invalid'

/** The seven card kinds of the knowledge base. */
export type CardKind =
  | 'concept'
  | 'method'
  | 'question'
  | 'decision'
  | 'comparison'
  | 'reading'
  | 'review'

export type ProfileCategory = 'explicit' | 'observed' | 'inferred'
export type ProfileOrigin = 'manual' | 'auto'

export interface KnowledgeSource {
  id: string
  kind: SourceKind
  originRef: string
  locator: string
  title: string
  version: string
  scope: string
  readAt: number | null
  fingerprint: string
  size: number
  state: SourceState
  invalidReason: string | null
  createdAt: number
  updatedAt: number
}

export interface KnowledgeCard {
  id: string
  kind: CardKind
  title: string
  summary: string
  body: string
  topics: string[]
  aliases: string[]
  sourceIds: string[]
  /** Persisted favourite mark; filtering happens in the helper, not here. */
  favorite: boolean
  edited: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

/**
 * One row of a card listing. A listing never carries the body: a page of legal
 * cards would otherwise exceed one frame. `bodyChars` tells a caller whether
 * `card.get` is worth a round trip.
 */
export interface KnowledgeCardSummary {
  id: string
  kind: CardKind
  title: string
  summary: string
  topics: string[]
  aliases: string[]
  sourceIds: string[]
  bodyChars: number
  favorite: boolean
  edited: boolean
  revision: number
  createdAt: number
  updatedAt: number
}

/**
 * `hasMore` and `nextOffset` describe what the helper actually returned. A page
 * may carry fewer items than `limit` when the byte budget filled up, so the next
 * request must start at `nextOffset` — never at `offset + limit`.
 */
export interface KnowledgeCardPage {
  items: KnowledgeCardSummary[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
}

export interface ProfileEvidence {
  sourceKind: SourceKind
  sourceId: string
  originRef: string
  locator: string
  createdAt: number
  /** The source behind this evidence was withdrawn; the item keeps the trace. */
  withdrawn?: boolean
}

export interface ProfileItem {
  id: string
  dimension: string
  value: string
  category: ProfileCategory
  origin: ProfileOrigin
  pinned: boolean
  corrected: boolean
  evidence: ProfileEvidence[]
  createdAt: number
  updatedAt: number
}

export interface ProfilePage {
  items: ProfileItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
}

/**
 * Capability report. Asking for it never starts the helper: an idle host answers
 * `running: false` with unknown capabilities instead of pretending a probe ran.
 */
export interface KnowledgeStatus {
  version: number
  running: boolean
  schema: { knowledge: number; profile: number } | null
  opened: boolean
  fts5: boolean | null
  trigram: boolean | null
}

export interface SaveSourceInput {
  kind: SourceKind
  /** Stable reference to the original record: note id, chat message id, URL or file path. */
  originRef: string
  locator: string
  title: string
  version: string
  scope: string
  readAt?: number
  /** The text the fingerprint is computed over; never stored as a snapshot. */
  text: string
}

export interface SaveCardInput {
  kind: CardKind
  title: string
  summary?: string
  body: string
  topics?: string[]
  aliases?: string[]
  sourceIds?: string[]
}

export interface UpdateCardInput {
  id: string
  kind?: CardKind
  title?: string
  summary?: string
  body?: string
  topics?: string[]
  aliases?: string[]
  sourceIds?: string[]
  favorite?: boolean
}

export interface CardQuery {
  offset?: number
  limit?: number
  /** Only cards carrying this exact topic. Applied before paging. */
  topic?: string
  /** `true` — favourites only; `false` — the rest; omitted — both. */
  favorite?: boolean
  kind?: CardKind
}

export interface CardSearchQuery extends CardQuery {
  query: string
}

/** Cards generated from one original record (a note, a turn, a reading). */
export interface SourceCardsQuery extends CardQuery, SourceRef {}

/**
 * The sources one record already published.
 *
 * A note page only knows the note id and a thread page only knows the thread id,
 * and publishing again just to learn the source id would be a write, so this is
 * the read-only lookup. The group form matches every source of one chat thread.
 */
export type FindSourceInput =
  | { channel: 'note' | 'chat' | 'reading'; originRef: string }
  | { channel: 'chat'; groupKey: string }

export interface FoundSource {
  sources: KnowledgeSource[]
}

/** Which record a detail page or a delete dialog is talking about. */
export interface SourceRef {
  /** The helper's own source id, when the caller already has one. */
  sourceId?: string
  /** A note id; the source is looked up read-only. */
  noteId?: string
  /** A chat thread id; every source of the thread matches. */
  threadId?: string
}

/** One card that quotes an original record, as the delete dialog lists it. */
export interface CardImpactItem {
  id: string
  title: string
  kind: CardKind
  /** How many valid sources the card still has, this record included. */
  sources: number
  /** True when this record is the card's only valid source. */
  single: boolean
}

/** Which original record (or single source) a preview or a purge speaks about. */
export type SourceIdentity =
  | { sourceId: string }
  | { channel: 'note'; originRef: string }
  | { channel: 'chat'; groupKey: string }
  | { channel: 'reading'; originRef: string }

/**
 * The record a preview or a delete is about.
 *
 * A bare id cannot say which kind of record it names, so the caller always says:
 * reading one id as a single source answers for less than the user is about to
 * delete, and the confirm dialog would under-count what it promises.
 */
export function sourceIdentityOf(target: SourceRef): SourceIdentity | null {
  if (target?.sourceId) return { sourceId: target.sourceId }
  if (target?.noteId) return { channel: 'note', originRef: target.noteId }
  if (target?.threadId) return { channel: 'chat', groupKey: target.threadId }
  return null
}

/** One source the preview saw, at the version it saw. */
export interface CardImpactSource {
  id: string
  version: string
}

/**
 * What deleting one original record would do to the knowledge derived from it.
 *
 * Counting happens in Rust against the current rows, so a preview and the delete
 * that follows it agree on the same numbers.
 */
export interface CardImpact {
  sourceId: string
  version: string
  /** Cards that quote this record at all. */
  cards: number
  /** Cards whose only valid source is this record: they go when the user opts in. */
  single: number
  /** Cards that keep another valid source: they stay, minus this link. */
  multi: number
  items: CardImpactItem[]
  /** True when `items` is a bounded preview rather than every card. */
  more: boolean
  /** Every source of the record the preview saw: the snapshot the user confirms. */
  sources: CardImpactSource[]
  /**
   * A digest of that snapshot. The purge quotes it back, so a record that gained a
   * source after the confirmation is refused instead of swept away.
   */
  ticket: string
  /** True when the record's source set was too large to preview exactly. */
  incomplete: boolean
  /**
   * Sources this record holds only because another record owns them too. A delete
   * gives up the claim and leaves the row, its cards and the other record's
   * evidence in place, so no card here is counted as going away.
   */
  shared: string[]
}

/** The original record a purge was asked for, at the version the preview saw. */
export interface PurgeSource {
  id: string
  version: string
}

export interface PurgeCardsInput {
  /** The record being acted on, resolved exactly like the preview was. */
  record: SourceIdentity
  /** The preview the user actually confirmed: its sources and its ticket. */
  confirm: { sources: CardImpactSource[]; ticket: string }
  /** Remove the cards that this record alone supports; otherwise only unlink. */
  cards: boolean
}

export interface PurgeCardsResult {
  removed: string[]
  /** Sources kept alive for another record; the purge dropped only this claim. */
  detached?: string[]
  kept: string[]
  /** Ids the purge refused because the record moved since the preview. */
  skipped: string[]
  /** The snapshot the helper actually committed against. */
  ticket?: string
}

/**
 * The two ways a failed post-delete cleanup can be finished.
 *
 * `purge` finishes the ticked version: the cards the confirmed preview named go.
 * `release` is the user's explicit downgrade after the range moved: the record's
 * sources and queued work are withdrawn, every card stays with its now-dead link.
 */
export type CleanupAction = 'purge' | 'release'

/**
 * One cleanup that failed after the record it belonged to was already deleted.
 *
 * The page gets this instead of an error it cannot act on, and it only ever holds
 * the opaque `id`: the record identity and the confirmed ticket stay in the main
 * process, so a renderer cannot widen a range by echoing something back.
 */
export interface CleanupPending {
  /** Opaque handle for one retry; valid only while this app session lives. */
  id: string
  /** Why the cleanup failed, in the words the user is shown. */
  reason: string
  /** True when the failed attempt was the version that also deletes cards. */
  cards: boolean
}

/** What one retry of a failed cleanup did. */
export interface CleanupRetryResult {
  /**
   * `done` finished it; `stale` means the confirmed range moved, so nothing was
   * deleted and the user may keep the cards instead; `failed` means the library
   * still cannot be reached and the same retry is offered again.
   */
  status: 'done' | 'stale' | 'failed'
  /** Why it is not done, when it is not. */
  reason?: string
  /** Cards removed by this retry. */
  removed: number
  /** Cards kept because another source still backs them. */
  kept: number
  /** Sources the record gave back (the release downgrade). */
  released: number
}

/** Relation kinds, in the order the UI offers them. */
export type RelationKind = 'contains' | 'prerequisite' | 'applies' | 'contrast' | 'derives'

/** Manual relations are drawn by a user; model relations carry a citation. */
export type RelationOrigin = 'manual' | 'model'

export interface KnowledgeRelation {
  id: string
  fromId: string
  toId: string
  kind: RelationKind
  origin: RelationOrigin
  /** Quoted basis for a model relation; empty for a hand-drawn one. */
  evidence: string
  /** Source and segment the quoted basis came from; null when there is none. */
  sourceId: string | null
  segment: number | null
  createdAt: number
}

/** One relation as seen from a card, with the card at the other end. */
export interface RelationNeighbour extends KnowledgeRelation {
  card: { id: string; title: string; kind: CardKind }
  /** `out` when the listed card is the source of the relation. */
  direction: 'out' | 'in'
}

export interface RelationList {
  items: RelationNeighbour[]
  total: number
}

export interface AddRelationInput {
  fromId: string
  toId: string
  kind: RelationKind
  evidence?: string
}

export interface GraphNode {
  id: string
  title: string
  kind: CardKind
  topics: string[]
  favorite: boolean
}

export interface GraphEdge {
  id: string
  fromId: string
  toId: string
  kind: RelationKind
  origin: RelationOrigin
}

/** A trimmed graph: both endpoints of every edge are inside `nodes`. */
export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Cards matching the filter before the budget cut the view. */
  total: number
  shown: number
  truncated: boolean
  /** Which budget stopped the expansion; `null` when nothing was dropped. */
  limitedBy: 'nodes' | 'bytes' | null
  /** The requested focus survived the budget and is in `nodes`. */
  focused: boolean
  /** Nodes brought in by the focus that the filter did not match. */
  expanded: number
}

export interface TopicCount {
  topic: string
  count: number
}

export interface TopicList {
  topics: TopicCount[]
  total: number
}

export interface CardRevision {
  revision: number
  title: string
  summary: string
  body: string
  topics: string[]
  edited: boolean
  createdAt: number
}

export interface CardRevisions {
  id: string
  revisions: CardRevision[]
}

/** Two cards the user chose to join. Both revisions pin the preview. */
export interface MergeCardsInput {
  keepId: string
  mergeId: string
  keepRevision: number
  mergeRevision: number
  title?: string
  summary?: string
  body?: string
}

export interface MergedCards {
  card: KnowledgeCard
  removedId: string
  /** Sources repointed onto the kept card. */
  sources: number
  /** Relations repointed onto the kept card. */
  relations: number
  /** Whose body the merged card keeps: the request's or the kept card's. */
  bodySource: 'request' | 'keep'
  /** The kept body's opening characters, so the dialog can show what won. */
  preview: string
}

export interface CardExport {
  id: string
  filename: string
  markdown: string
}

export interface GraphQuery {
  topic?: string
  query?: string
  focusId?: string
  /** Hops around `focusId`; 1 when omitted. */
  depth?: number
  limit?: number
}

export interface SaveProfileInput {
  dimension: string
  value: string
  /**
   * Stable identity of one preference. Two sentences worded differently share a
   * slot, so a manual correction cannot be bypassed by a new value or a new id.
   * Omitted: the slot is the dimension.
   */
  slot?: string
  category: ProfileCategory
  origin?: ProfileOrigin
  pinned?: boolean
  corrected?: boolean
  evidence?: Array<Pick<ProfileEvidence, 'sourceKind' | 'sourceId' | 'originRef' | 'locator'>>
}

export interface UpdateProfileInput {
  id: string
  value?: string
  category?: ProfileCategory
  pinned?: boolean
  corrected?: boolean
  evidence?: Array<Pick<ProfileEvidence, 'sourceKind' | 'sourceId' | 'originRef' | 'locator'>>
}

/** Methods the helper accepts. Anything else is answered with `unknown_method`. */
export type KnowledgeMethod =
  | 'status'
  | 'shutdown'
  | 'source.save'
  | 'source.get'
  | 'source.invalidate'
  | 'card.save'
  | 'card.get'
  | 'card.list'
  | 'card.update'
  | 'card.delete'
  | 'card.search'
  | 'card.by_source'
  | 'card.impact'
  | 'card.purge'
  | 'source.find'
  | 'source.release_record'
  | 'profile.save'
  | 'profile.get'
  | 'profile.list'
  | 'profile.update'
  | 'profile.delete'
  | 'collect.configure'
  | 'source.publish'
  | 'queue.list'
  | 'queue.status'
  | 'queue.extract'
  | 'queue.pause'
  | 'queue.cancel'
  | 'queue.retry'
  | 'queue.invalidate'
  | 'queue.invalidate_thread'
  | 'queue.items'
  | 'source.read'
  | 'queue.needs_reread'
  | 'exclude.add'
  | 'exclude.remove'
  | 'exclude.list'
  | 'history.begin'
  | 'history.step'
  | 'history.pause'
  | 'history.resume'
  | 'history.cancel'
  | 'history.status'
  | 'history.latest'
  | 'extract.next'
  | 'extract.run'
  | 'extract.fail'
  | 'suggestion.list'
  | 'suggestion.get'
  | 'suggestion.accept'
  | 'suggestion.reject'
  | 'profile.configure'
  | 'profile.pause'
  | 'profile.status'
  | 'profile.event'
  | 'profile.evidence'
  | 'profile.learn.next'
  | 'profile.learn.run'
  | 'profile.learn.fail'
  | 'profile.context'
  | 'profile.retract'
  | 'profile.clear'
  | 'profile.retry'
  | 'topic.list'
  | 'card.revisions'
  | 'card.merge'
  | 'card.export'
  | 'relation.add'
  | 'relation.remove'
  | 'relation.list'
  | 'graph.query'

export type KnowledgeErrorCode =
  | 'invalid_request'
  | 'unsupported_version'
  | 'unknown_method'
  | 'invalid_params'
  | 'too_large'
  | 'not_found'
  | 'protected_item'
  | 'storage_error'
  | 'storage_schema_newer'
  | 'cancelled'
  | 'timeout'
  | 'model_unavailable'
  | 'channel_disabled'
  | 'excluded'
  | 'source_changed'
  | 'invalid_output'
  | 'internal'

/** Ids are opaque, but they are always short, ASCII and minted by the helper. */
const KNOWLEDGE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function knowledgeId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !KNOWLEDGE_ID.test(value)) {
    throw new KnowledgeError('invalid_params', `${field} 无效`)
  }
  return value
}

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'KnowledgeError'
  }
}


/** The three collection channels. A reading summary never also counts as chat. */
export type CollectChannel = 'note' | 'chat' | 'reading'

/**
 * A task waits in `stabilizing` until its window elapses, then reads as
 * `ready`. Phase 2 never marks a task extracted, so `ready` is the end state
 * this stage can reach.
 */
/**
 * `working` is a task an extraction batch holds right now; `completed` means the
 * material was turned into cards (or the model saw nothing worth keeping).
 */
export type QueueState =
  | 'stabilizing'
  | 'ready'
  | 'working'
  | 'completed'
  | 'needs_reread'
  | 'failed'
  | 'cancelled'

export interface QueueItem {
  sourceId: string
  ordinal: number
  kind: SourceKind
  originRef: string
  title: string
  locator: string
  scope: string
  size: number
  readAt: number
  /** `invalid` once the source behind this item was retracted. */
  state: 'active' | 'invalid'
}

/** One pending-extraction unit: a note version, a thread, or a reading. */
export interface QueueTask {
  id: string
  channel: CollectChannel
  groupKey: string
  title: string
  scope: string
  state: QueueState
  stableAt: number
  reason?: string
  error?: string
  attempts: number
  items: QueueItem[]
  /** Every item of the task, plus the continuation for the rest of them. */
  itemsTotal: number
  itemsOffset: number
  itemsHasMore: boolean
  itemsNextOffset: number | null
  updatedAt: number
}

export interface CollectChannels {
  /** Master switch, as the helper currently understands it. */
  enabled: boolean
  note: boolean
  chat: boolean
  reading: boolean
  pausedManual: boolean
  pausedGame: boolean
}

export interface QueuePage {
  items: QueueTask[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
  paused: boolean
  channels: CollectChannels
}

/** One page of a group's items, plus the channel the group belongs to. */
/** One group's items: what `queue.items` answers, and what recovery reads back. */
export interface QueueItemPage {
  channel: CollectChannel | null
  items: QueueItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
}

export interface QueueStatus {
  counts: Record<QueueState, number>
  total: number
  paused: boolean
  pausedReasons: { manual: boolean; game: boolean }
  channels: CollectChannels
  windowMs: number
  /**
   * The newest groups, so a failing one can be retried by its real id instead of
   * by a channel name that would reset a group the caller never saw.
   */
  groups: QueueGroup[]
}

export interface QueueGroup {
  id: string
  channel: CollectChannel
  state: QueueState
  threadKey: string | null
  title: string
  items: number
  updatedAt: number
}

/**
 * Result of asking the helper to re-queue an existing source for extraction.
 * A refusal carries a reason instead of a group, so both are optional here and
 * the panel shows whichever one the helper really sent.
 */
export interface ExtractSourceResult {
  queued: number
  reason?: string
  groupId?: string | null
  state?: string
}

/**
 * What the caller knows about the body before it asks.
 *
 * `expectVersion`/`expectFingerprint` are the text the caller actually read: the
 * helper refuses a source that moved on before it resets this version's progress.
 * `missing` states that the body is gone, so the task is parked instead of queued.
 */
export interface ExtractSourceQuery {
  sourceId: string
  expectVersion?: string
  expectFingerprint?: string
  missing?: string
}

/**
 * What the main process will do with a source, resolved from the stored source
 * itself. The renderer never builds a path or a chat id on its own.
 */
export type SourceTarget =
  | { kind: 'record'; record: import('./workspace').LocalRecord }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'none'; reason: string }

/** One enabled model profile plus the one the helper would actually use. */
export interface KnowledgeModelInfo {
  profiles: { id: string; label: string; enabled: boolean }[]
  selectedId: string | null
  effectiveId: string | null
  effectiveLabel: string
  /** True when the stored choice is disabled or gone, so the effective one differs. */
  fallback: boolean
}

export interface ExclusionEntry {
  kind: CollectChannel
  key: string
  reason: string
  createdAt: number
}

export type HistoryState = 'running' | 'paused' | 'completed' | 'cancelled'

/** Progress of one one-off history collection. */
/** One source the main process must read back before a batch can run. */
export interface ExtractSourceRef {
  sourceId: string
  version: string
  fingerprint: string
  kind: string
  originRef: string
  scope: string
  title: string
  size: number
  /** How many segments this source is split into. */
  segments: number
}

/** One character range the helper wants read back for this batch. */
export interface ExtractItem {
  sourceId: string
  version: string
  segment: number
  start: number
  end: number
}

/** The task `extract.next` claimed, or null when nothing is runnable. */
export interface ExtractGroup {
  groupId: string
  channel: CollectChannel
  title: string
  scope: string
  claim: string
  sources: ExtractSourceRef[]
  /**
   * The bounded batch: the exact character ranges this run needs. Read only these,
   * so a group of long sources never has to fit in one frame.
   */
  items: ExtractItem[]
}

export interface ExtractNext {
  enabled: boolean
  paused: boolean
  group: ExtractGroup | null
  nextDueAt: number | null
}

/**
 * Material the main process read out of its own stores, never the renderer. The
 * fingerprint identifies the whole body the slice came from; the helper compares
 * it with the version it stored before it uses the slice.
 */
export interface ExtractSourceInput {
  sourceId: string
  version: string
  fingerprint: string
  segment: number
  start: number
  end: number
  text: string
}

export interface ExtractRunInput {
  groupId: string
  claim: string
  items: ExtractSourceInput[]
  profileId?: string | null
  effort?: string
}

export interface ExtractFailInput {
  groupId: string
  claim: string
  code: string
  reason?: string | null
}

export interface ExtractOutcome {
  groupId: string
  state: 'completed' | 'ready' | 'failed' | 'needs_reread'
  cards: { cardId: string; action: 'new' | 'merge' | 'reference' }[]
  proposals: { targetCardId: string; action: string }[]
  noKnowledge: boolean
  skipped?: number
  reason: string
  remaining: boolean
  segments?: number
}

export type SuggestionState = 'open' | 'accepted' | 'rejected'
export type SuggestionAction = 'reference' | 'merge' | 'propose'

/** What a proposal would write, kept next to the card it targets. */
export interface SuggestionDraft {
  kind: CardKind
  title: string
  summary: string
  body: string
  topics: string[]
  aliases: string[]
  sources?: unknown
  reason?: string
}

/**
 * A change extraction did not dare to write on its own: the target card was
 * edited by hand, two sources disagree, or a merge is merely plausible.
 */
export interface KnowledgeSuggestion {
  id: string
  kind: CardKind
  targetCardId: string
  targetRevision: number
  action: SuggestionAction
  draft: SuggestionDraft
  reason: string
  sourceIds: string[]
  state: SuggestionState
  createdAt: number
  updatedAt: number
}

export interface SuggestionPage {
  items: KnowledgeSuggestion[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
}

export interface AcceptedSuggestion {
  id: string
  targetCardId: string
  revision: number
  state: 'accepted'
}

export interface RejectedSuggestion {
  id: string
  state: 'rejected'
}

export interface HistoryJob {
  id: string
  scopes: { notes: boolean; chat: boolean }
  state: HistoryState
  noteCursor: string | null
  chatCursor: string | null
  /** Scan bounds fixed when the job started; newer content takes the live path. */
  noteBound: string | null
  chatBound: number | null
  noteDone: boolean
  chatDone: boolean
  scanned: number
  skipped: number
  deduped: number
  ready: number
  needsReread: number
  failed: number
  createdAt: number
  updatedAt: number
}

/** What a channel projects into a source: the body plus its honest range. */
/**
 * A queue task is addressed by its minted id, or by the channel and key that
 * produced it — a caller that knows the note id never has to track the group id.
 */
export type TaskTarget =
  | { groupId: string }
  | { channel: CollectChannel; groupKey: string }

export interface TaskRefusal {
  groupId: string
  state: string
}

export interface PublishInput {
  channel: CollectChannel
  kind: SourceKind
  originRef: string
  groupKey: string
  title?: string
  scope?: string
  locator?: string
  readAt?: number
  text: string
  /** When the user produced the content, in milliseconds since the epoch. */
  at: number
  /** The conversation or note it belongs to, so deleting it retracts the task. */
  threadKey?: string
  /** Position inside the group; several reading materials share one thread. */
  ordinal?: number
  /**
   * Cards the answer really cited. They travel with the projection so a later
   * extraction can reuse their source chain instead of minting a duplicate card
   * from the same text.
   */
  citedCardIds?: string[]
}

export interface PublishResult {
  sourceId: string
  version: string
  fingerprint: string
  groupId: string
  state: QueueState
  duplicate: boolean
}

/** One model message the helper may send for a callback. */
export interface HelperChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Frames the helper writes on stdout. */
export type HelperFrame =
  | { v: number; type: 'ready'; schema: { knowledge: number; profile: number }; fts5: boolean; trigram: boolean }
  | { v: number; type: 'result'; id: string; ok: true; result: unknown }
  | { v: number; type: 'result'; id: string; ok: false; error: { code: KnowledgeErrorCode; message: string } }
  | { v: number; type: 'changed'; scope: string }
  | {
      v: number
      type: 'model.request'
      id: string
      parentId: string
      profileId: string
      effort: string
      messages: HelperChatMessage[]
      maxTokens: number | null
    }

/** Frames the host writes on the helper's stdin. */
export type HostFrame =
  | { v: number; type: 'request'; id: string; method: KnowledgeMethod; params: unknown }
  | { v: number; type: 'cancel'; id: string }
  | { v: number; type: 'model.result'; id: string; ok: true; text: string }
  | { v: number; type: 'model.result'; id: string; ok: false; error: { code: KnowledgeErrorCode; message: string } }

/** A fixed fixture both sides parse in tests: request, success, failure, cancel. */
export const KNOWLEDGE_FIXTURES = {
  request: { v: 1, type: 'request', id: 'r1', method: 'status', params: {} },
  result: { v: 1, type: 'result', id: 'r1', ok: true, result: { version: 1 } },
  failure: { v: 1, type: 'result', id: 'r1', ok: false, error: { code: 'not_found', message: 'unknown card: c1' } },
  cancel: { v: 1, type: 'cancel', id: 'r1' },
  modelRequest: {
    v: 1,
    type: 'model.request',
    id: 'm1',
    parentId: 'r1',
    profileId: 'p1',
    effort: 'high',
    messages: [{ role: 'user', content: '合成内容' }],
    maxTokens: 128
  },
  modelResult: { v: 1, type: 'model.result', id: 'm1', ok: true, text: '答' }
} as const

// ---------------------------------------------------------------- user profile

/** The four feature categories the app may report. */
export type ProfileFeature = 'chat' | 'ask' | 'note' | 'card-edit'

/** Where the user's own sentence came from. */
export type ProfileSourceKind = 'chat' | 'ask'

export interface ProfileState {
  enabled: boolean
  usage: boolean
  chat: boolean
  pausedManual: boolean
  pausedGame: boolean
  /** Bumped by a clear; an answer started under an older value is refused. */
  epoch: number
}

export interface ProfileStatus extends ProfileState {
  pending: number
  items: number
  usageTotal: number
  /** Rows a real failure left behind; only the explicit retry moves them again. */
  failed: number
  failedItems: { id: string; reason: string; chars: number; at: number }[]
  nextDueAt: number | null
}

export interface ProfileConfigureInput {
  enabled?: boolean
  usage?: boolean
  chat?: boolean
  pausedManual?: boolean
  pausedGame?: boolean
}

/** One pending piece of the user's own text, as the helper queued it. */
export interface ProfilePendingItem {
  id: string
  sourceKind: string
  sourceId: string
  version: string
  segment: number
  originRef: string
  locator: string
  text: string
  at: number
}

export interface ProfileBatch {
  claim: string
  epoch: number
  items: ProfilePendingItem[]
}

export interface ProfileNext extends ProfileState {
  batch: ProfileBatch | null
  nextDueAt: number | null
}

export interface ProfileEvidenceInput {
  sourceKind: ProfileSourceKind | string
  sourceId: string
  version: string
  originRef: string
  locator?: string
  at?: number
  text: string
}

export interface ProfileLearnRunInput {
  claim: string
  profileId?: string | null
  effort?: string
}

export interface ProfileLearnFailInput {
  claim: string
  code?: string
  reason?: string
}

export interface ProfileContextItem {
  id: string
  dimension: string
  value: string
  category: 'explicit' | 'observed' | 'inferred'
  pinned: boolean
  corrected: boolean
  /** True when the evidence behind it is inside the recent window. */
  recent: boolean
}

export interface ProfileContext {
  enabled: boolean
  text: string
  items: ProfileContextItem[]
  bytes: number
}

export interface ProfileWriteResult {
  written: { id: string; action: 'created' | 'updated' }[]
  skipped: number
  evidence: number
}
