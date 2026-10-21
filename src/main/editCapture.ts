import { learnFromEdit } from '@shared/dictionary'

/**
 * ACC-06 / REQ-06 edit capture.
 *
 * After the text has landed the user usually fixes a word or two. Comparing what
 * the model wrote with what the control holds a moment later is the only honest
 * source of "what did the user change" — and it is what makes auto-learned
 * dictionary entries real instead of seeded.
 *
 * What comes out of here is only a *candidate*, though. An edit is noisy
 * evidence, so `candidates` feeds the suggestion pool (`@shared/suggestions`)
 * and never the dictionary directly: nothing reaches a prompt until the user
 * confirms it on the dictionary page.
 *
 * Everything here is pure: the observed text arrives as an argument (the real
 * reads happen through UI Automation in a utility process), so the rules below
 * can be falsified by unit tests. No timers, no Electron, no IO.
 */

/**
 * One idea a capture is willing to propose, in the shape the suggestion pool
 * takes. Serializable on purpose: the pipeline hands it to the settings writer.
 */
export interface LearnedCandidate {
  /** The spelling the user introduced. */
  from: string
  /**
   * Empty: `learnFromEdit` knows what appeared, not what it replaced, so there
   * is no target spelling to propose yet.
   */
  to: string
  /**
   * `hint`, because an empty `to` under `replace` would delete the word instead
   * of leaving it alone. The user can turn it into a mapping later.
   */
  mode: 'replace' | 'hint'
  /** Epoch ms the edit was observed. */
  at: number
}

/** What the capture decided about one take. */
export interface EditCapture {
  /** The part of the final text the user changed or added; absent when untouched. */
  editedText?: string
  editedStatus: 'NOT_EXTRACTED' | 'UNCHANGED' | 'EXTRACTED'
  /** True when the user threw the AI text away and put the transcript back. */
  hasRevertedAI?: boolean
  /** Terms worth proposing to the user as dictionary suggestions. */
  candidates?: LearnedCandidate[]
  /** Same information as `hasRevertedAI`, always present for callers. */
  revertDetected: boolean
}

/** Inputs for one capture. */
export interface EditCaptureInput {
  /** Text the pipeline inserted at the caret. */
  inserted: string
  /** What the focused control holds now; `null` when UIA could not read it. */
  observed: string | null
  /** The raw ASR transcript, used only to recognise a revert. */
  transcript?: string
  /** Epoch ms stamped on the candidates; injectable so tests stay deterministic. */
  now?: number
}

/**
 * Below this similarity the observed text is treated as a *different* field, not
 * as an edited version of what was inserted. Every unrelated sentence scores far
 * below it, while a one-word edit in a short sentence scores well above it.
 */
const SAME_TAKE_FLOOR = 0.45

/** The transcript comparison needs a real match before it can win. */
const REVERT_FLOOR = 0.55

/** How much closer to the transcript the observed text must be to call it a revert. */
const REVERT_MARGIN = 0.08

/** Collapses whitespace runs so a re-wrapped line is not an "edit". */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Removes every space so `contains`/similarity ignore wrapping differences. */
function compact(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * Comparable tokens: one per CJK character, plus the bigrams they form, plus one
 * per latin/digit word. CJK has no spaces, so character overlap alone would make
 * two unrelated Chinese sentences look similar; bigrams keep that honest.
 */
function tokens(value: string): Set<string> {
  const set = new Set<string>()
  const text = typeof value === 'string' ? value.toLocaleLowerCase() : ''
  for (const match of text.matchAll(/[\u4e00-\u9fff]+|[a-z0-9]+/g)) {
    const run = match[0]
    if (/^[\u4e00-\u9fff]/.test(run)) {
      for (let i = 0; i < run.length; i += 1) {
        set.add(run[i]!)
        const pair = run.slice(i, i + 2)
        if (pair.length === 2) set.add(pair)
      }
      continue
    }
    set.add(run)
  }
  return set
}

/**
 * Jaccard similarity over the token sets above, in 0..1.
 *
 * Two empty texts are identical (1); one empty and one filled share nothing (0).
 * A one-word replacement inside a sentence stays high, an unrelated sentence
 * stays near zero, which is exactly the separation `captureEdit` needs.
 */
export function similarity(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let index = 0
  while (index < max && a[index] === b[index]) index += 1
  return index
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix
  let index = 0
  while (index < max && a[a.length - 1 - index] === b[b.length - 1 - index]) index += 1
  return index
}

/**
 * The stretch of the observed text that differs from what was inserted: the
 * appended tail when the user kept typing, the rewritten word when they fixed
 * one, and the surviving text when the only change was a deletion.
 */
export function editedSegment(inserted: string, observed: string): string {
  const before = normalize(inserted)
  const after = normalize(observed)
  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before, after, prefix)
  const changed = after.slice(prefix, after.length - suffix).trim()
  return changed || after.trim()
}

/**
 * Wraps the learned spellings as pool candidates.
 *
 * They are hints, not replacements: a replacement whose `to` is empty would
 * delete the word everywhere, and the pool's job is to ask the user what the
 * target spelling should be.
 */
function learnedCandidates(terms: string[], now: number): LearnedCandidate[] {
  return terms.map((term) => ({ from: term, to: '', mode: 'hint', at: now }))
}

/**
 * Classifies one post-insertion observation.
 *
 * - unreadable control (`null`/blank) -> `NOT_EXTRACTED`, nothing to say;
 * - same text, modulo whitespace -> `UNCHANGED`, no `editedText`;
 * - a different field entirely -> `NOT_EXTRACTED` (never a fake edit);
 * - the AI text was replaced by the transcript -> `EXTRACTED` + revert flag;
 * - the user kept or fixed part of it -> `EXTRACTED` with the changed stretch.
 */
export function captureEdit(input: EditCaptureInput): EditCapture {
  const inserted = typeof input.inserted === 'string' ? input.inserted.trim() : ''
  const observed = typeof input.observed === 'string' ? input.observed.trim() : ''
  // Nothing was typed, or the control cannot be read: no claim either way.
  if (!inserted || !observed) return { editedStatus: 'NOT_EXTRACTED', revertDetected: false }

  const insertedCompact = compact(inserted)
  const observedCompact = compact(observed)
  // Equal once whitespace runs are folded — and equal once every space is gone,
  // because a rich edit control may re-wrap a long line at a different column
  // and that is not an edit the user made.
  if (normalize(inserted) === normalize(observed) || insertedCompact === observedCompact) {
    return { editedStatus: 'UNCHANGED', revertDetected: false }
  }

  const contains = insertedCompact.length > 0 && observedCompact.includes(insertedCompact)
  const versusInserted = similarity(observed, inserted)

  const reference = typeof input.transcript === 'string' ? input.transcript.trim() : ''
  const versusTranscript = reference ? similarity(observed, reference) : 0
  // A revert deletes the AI text, so it can never "contain" it. It has to be
  // both close to what the user actually said and clearly unlike our output.
  const revertDetected =
    !contains &&
    reference.length > 0 &&
    versusTranscript >= REVERT_FLOOR &&
    versusTranscript >= versusInserted + REVERT_MARGIN

  if (revertDetected) {
    const candidates = learnedCandidates(learnFromEdit(inserted, observed), input.now ?? Date.now())
    return {
      editedStatus: 'EXTRACTED',
      editedText: observed,
      hasRevertedAI: true,
      ...(candidates.length > 0 ? { candidates } : {}),
      revertDetected: true
    }
  }

  // The control we read is not the one we typed into (the user switched apps,
  // or the read landed on a different field). Silence beats a bogus edit.
  if (!contains && versusInserted < SAME_TAKE_FLOOR) {
    return { editedStatus: 'NOT_EXTRACTED', revertDetected: false }
  }

  const candidates = learnedCandidates(learnFromEdit(inserted, observed), input.now ?? Date.now())
  return {
    editedStatus: 'EXTRACTED',
    editedText: editedSegment(inserted, observed),
    ...(candidates.length > 0 ? { candidates } : {}),
    revertDetected: false
  }
}
