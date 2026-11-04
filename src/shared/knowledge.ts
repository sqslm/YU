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
