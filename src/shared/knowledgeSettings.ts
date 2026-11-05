/**
 * Collection switches for the knowledge base.
 *
 * The master switch is off by default: nothing is collected, no helper is
 * spawned and no store is opened until the user turns it on. The three channels
 * are allowed by default but only matter once the master switch is on, and the
 * Rust side re-checks them so a stale renderer cannot re-enable a channel on its
 * own.
 */
export interface KnowledgeSettings {
  enabled: boolean
  notes: boolean
  chat: boolean
  reading: boolean
  /** Profile used for extraction; `null` means the first enabled provider. */
  profileId?: string | null
  /** Reasoning effort for extraction. Knowledge synthesis thinks by default. */
  effort?: string
}
