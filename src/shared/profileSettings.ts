/**
 * The user-profile module's own switches.
 *
 * It is deliberately separate from the knowledge settings: the two modules share
 * one helper process but nothing else, and a user may well want their own words
 * turned into a profile while the knowledge base stays off (or the other way
 * round). `enabled` gates every automatic step; `usage` only gates the in-app
 * counters, `chat` the learning from conversations.
 */
export interface UserProfileSettings {
  /** Master switch. Off by default, like the knowledge base. */
  enabled: boolean
  /** Counts how often Yu's own features complete, for the observed context. */
  usage: boolean
  /** Lets the user's own sentences become profile evidence. */
  chat: boolean
  /** Model used only for profile synthesis; `null` means the first available one. */
  profileId: string | null
  /** Thinking effort for that model; profile synthesis thinks by default. */
  effort: string
}
