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
}

export interface CardQuery {
  offset?: number
  limit?: number
}

export interface CardSearchQuery extends CardQuery {
  query: string
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
  | 'profile.save'
  | 'profile.get'
  | 'profile.list'
  | 'profile.update'
  | 'profile.delete'
  | 'collect.configure'
  | 'source.publish'
  | 'queue.list'
  | 'queue.status'
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
