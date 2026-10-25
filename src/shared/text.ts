import type { Replacement } from './types'

/**
 * Applies the user's glossary pairs to a finished transcript.
 *
 * Replacements are plain literals (no regex) so users can paste whatever they
 * like, including parentheses and CJK characters. Empty `from` values are
 * skipped: a global replace of "" would insert text between every character.
 * Longest source wins so "GPT4" can be fixed before "GPT".
 */
export function applyReplacements(text: string, pairs: Replacement[] | undefined): string {
  if (!text || !pairs || pairs.length === 0) return text
  const ordered = pairs
    .filter(
      (pair) =>
        pair &&
        typeof pair.from === 'string' &&
        pair.from.length > 0 &&
        // A hint entry is glossary-only: it teaches the model a term without
        // rewriting text, so it must never reach the literal replacement below.
        pair.mode !== 'hint'
    )
    .sort((a, b) => b.from.length - a.from.length)

  if (ordered.length === 0) return text
  let output = ''
  let position = 0
  while (position < text.length) {
    const match = ordered.find((pair) => text.startsWith(pair.from, position))
    if (!match) {
      output += text[position]
      position += 1
      continue
    }
    output += typeof match.to === 'string' ? match.to : ''
    position += match.from.length
  }
  return output
}

/** How many times one literal needle occurs in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0
  let total = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    total += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return total
}

/**
 * Counts how often each glossary rule appears in one take's transcript.
 *
 * Measured on the **transcript**, never on the polished text. A rule is handed to
 * the model as glossary (`glossary: settings.replacements`), so by the time a
 * result comes back the model has usually already written the corrected spelling
 * — counting there reported zero for rules that plainly appeared in what the user
 * said ("今天晚上打CSR吗？" came back as "打 CS2 吗？" and the badge stayed at 0).
 * A `hint` rule never rewrites anything either, so the transcript is its only
 * evidence as well; hint matching ignores case because the whole point of a hint
 * is to fix a spelling the recogniser got wrong.
 *
 * Returns only the rules that hit, keyed by their `from`, so the caller can bump
 * counters without walking the whole glossary.
 */
export function countRuleHits(
  source: string,
  pairs: Replacement[] | undefined
): Record<string, number> {
  const hits: Record<string, number> = {}
  if (!source || !pairs || pairs.length === 0) return hits
  const lowered = source.toLowerCase()
  for (const pair of pairs) {
    if (!pair || typeof pair.from !== 'string' || pair.from.length === 0) continue
    const count =
      pair.mode === 'hint'
        ? countOccurrences(lowered, pair.from.toLowerCase())
        : countOccurrences(source, pair.from)
    if (count > 0) hits[pair.from] = (hits[pair.from] ?? 0) + count
  }
  return hits
}
