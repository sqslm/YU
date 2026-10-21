import type { Suggestion } from './types'
import { isStopword } from './dictionary'
import { MAX_DICTIONARY_TERM, MAX_SUGGESTIONS, SUGGESTION_THRESHOLD } from './defaults'

/**
 * The suggestion pool: dictionary ideas learned from the user's edits, before
 * they are allowed to touch anything.
 *
 * Edits are a noisy signal (a typo fix, a one-off rewording, a slip of the
 * hand), so nothing here reaches a prompt or rewrites text. A capture only ever
 * adds to this pool; the dictionary page offers rows once the same `from` has
 * been seen `SUGGESTION_THRESHOLD` times, and the user accepts or ignores them.
 *
 * Every function is pure: the input array is never mutated, and a call that
 * changes nothing returns the array it was given so callers can skip a write.
 */

/** One capture's idea, in the shape `captureEdit` produces. */
export interface SuggestionCandidate {
  from: string
  to: string
  mode: 'replace' | 'hint'
  /** Epoch ms the edit was observed; the pool's clock, never read from the system. */
  at: number
}

/** Match key shared with the dictionary: spelling is case-insensitive. */
function key(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * A candidate the pool should ignore, or `null` when it is worth counting.
 *
 * These four rejections are what keeps the pool honest: a pair that maps a word
 * to itself teaches nothing, a blank `from` cannot be matched, a common word is
 * not a term, and an over-long string is a copy-paste accident rather than a
 * spelling the user cares about.
 */
function unusable(from: string, to: string): boolean {
  if (!from) return true
  if (from.length > MAX_DICTIONARY_TERM || to.length > MAX_DICTIONARY_TERM) return true
  if (to && key(from) === key(to)) return true
  return isStopword(from)
}

function withLastSeen(row: Suggestion, at: number): Suggestion {
  // `max` rather than assignment: a settings file edited by hand, or a clock
  // that steps backwards, must not make a row look older than a sighting it
  // already has (that would reorder the pool under the user).
  return { ...row, lastSeen: Math.max(row.lastSeen, at) }
}

/**
 * Records one sighting and returns the resulting pool.
 *
 * A row that already exists under the same spelling is only ever counted: its
 * `to`/`mode` stay as first seen, because the user is being asked about that
 * exact pair and a later capture must not silently rewrite it. Rows that were
 * already accepted or ignored ignore the sighting entirely — that is the whole
 * point of remembering the decision.
 */
export function mergeSuggestion(pool: Suggestion[], incoming: SuggestionCandidate): Suggestion[] {
  if (!Array.isArray(pool)) return []
  const from = typeof incoming?.from === 'string' ? incoming.from.trim() : ''
  const to = typeof incoming?.to === 'string' ? incoming.to.trim() : ''
  if (unusable(from, to)) return pool

  const at = Number.isFinite(incoming.at) ? incoming.at : Date.now()
  const spelling = key(from)
  const index = pool.findIndex((row) => key(row.from) === spelling)

  if (index < 0) {
    const row: Suggestion = {
      from,
      to,
      mode: incoming.mode === 'replace' ? 'replace' : 'hint',
      count: 1,
      firstSeen: at,
      lastSeen: at,
      status: 'pending'
    }
    return pruneSuggestions([...pool, row], MAX_SUGGESTIONS)
  }

  const existing = pool[index]!
  if (existing.status !== 'pending') return pool
  const next = [...pool]
  next[index] = { ...withLastSeen(existing, at), count: existing.count + 1 }
  return next
}

/**
 * Rows the dictionary page should offer: pending ideas seen at least
 * `threshold` times, most repeated first so the obvious ones sit on top.
 */
export function pickSuggestions(
  pool: Suggestion[],
  threshold: number = SUGGESTION_THRESHOLD
): Suggestion[] {
  if (!Array.isArray(pool)) return []
  return pool
    .filter((row) => row.status === 'pending' && row.count >= threshold)
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.from.localeCompare(b.from))
}

/**
 * Marks one idea as accepted (the caller has added it to the dictionary).
 *
 * The row is kept rather than deleted: deleting it would let the next identical
 * capture start counting from zero and ask the same question again. `now`
 * becomes `lastSeen` so a decision counts as the most recent activity.
 */
export function acceptSuggestion(pool: Suggestion[], from: string, now: number): Suggestion[] {
  return decide(pool, from, 'accepted', now)
}

/**
 * Marks one idea as ignored. Future sightings of the same `from` no longer
 * accumulate, and the page stops offering it.
 */
export function ignoreSuggestion(pool: Suggestion[], from: string, now: number): Suggestion[] {
  return decide(pool, from, 'ignored', now)
}

function decide(
  pool: Suggestion[],
  from: string,
  status: 'accepted' | 'ignored',
  now: number
): Suggestion[] {
  if (!Array.isArray(pool)) return []
  const spelling = key(typeof from === 'string' ? from : '')
  const at = Number.isFinite(now) ? now : Date.now()
  const index = pool.findIndex((row) => key(row.from) === spelling)
  if (index < 0) return pool
  const next = [...pool]
  next[index] = { ...withLastSeen(pool[index]!, at), status }
  return next
}

/**
 * Caps the pool at `limit`, evicting the rows with the earliest `lastSeen` (the
 * least recently confirmed ideas). Survivors keep their original order so the
 * stored list stays append-ordered for readers that rely on it.
 */
export function pruneSuggestions(
  pool: Suggestion[],
  limit: number = MAX_SUGGESTIONS
): Suggestion[] {
  if (!Array.isArray(pool)) return []
  const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_SUGGESTIONS
  if (pool.length <= cap) return pool
  const ranked = [...pool].sort(
    (a, b) => a.lastSeen - b.lastSeen || a.from.localeCompare(b.from)
  )
  const doomed = new Set(ranked.slice(0, pool.length - cap))
  return pool.filter((row) => !doomed.has(row))
}
