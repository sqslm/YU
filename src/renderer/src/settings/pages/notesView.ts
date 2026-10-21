/**
 * Pure view model for the 随记 page.
 *
 * Everything that can be decided without a DOM lives here — summary lines,
 * filtering, tag counts, time and duration strings, the tag editor rules and the
 * save indicator — so `notesView.test.ts` can pin the behaviour without mounting
 * React. The page component only wires this module to MUI and to `window.api`.
 */

import type { NoteCategory, NoteEntry } from '@shared/types'

/** Sentinel for "no category filter"; the store keeps `categoryId` optional. */
export const ALL_CATEGORIES = ''

/** What the player offers. `1` is the identity, so a stored rate is never a surprise. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const

export type NoteSort = 'newest' | 'oldest'

/** A note carries at most this many tags, and the filter row shows at most as many. */
export const MAX_TAGS = 12
export const TAG_FILTER_LIMIT = 12

export interface NotesFilter {
  query?: string
  /** `ALL_CATEGORIES` (or `''`) means every category. */
  categoryId?: string
  /** Every listed tag must be present; an empty list means no tag constraint. */
  tags?: readonly string[]
  sort?: NoteSort
}

export interface TagCount {
  tag: string
  count: number
}

/**
 * The save indicator is a small machine, not three booleans: `pending` means the
 * debounce has not fired yet, `saving` means a write is in flight. Keeping them
 * apart is what lets a late success from an older write be ignored instead of
 * claiming "已保存" while newer keystrokes are still unsaved.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export type SaveEvent = 'edited' | 'flushStarted' | 'flushSucceeded' | 'flushFailed' | 'reset'

export type NotesEmpty = 'none' | 'records' | 'filters'

/** Collapse runs of whitespace so a multi-line transcript still reads as one line. */
const SPACES = /\s+/g

function text(value: string | undefined): string {
  return (value ?? '').trim()
}

function lower(value: string | undefined): string {
  return text(value).toLowerCase()
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * One-line summary for a list row: the polished text when it exists, the raw
 * transcript otherwise. `maxChars` counts the ellipsis, so the result never
 * exceeds the caller's budget and the row height stays stable.
 */
export function summarize(note: NoteEntry, maxChars = 120): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''
  const source = text(note.polished) || text(note.transcript)
  const flat = source.replace(SPACES, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/**
 * Case-insensitive containment across the fields a user would search by. The
 * category name is passed in because a note only stores the category id.
 */
export function matchesQuery(note: NoteEntry, query: string, categoryName = ''): boolean {
  const needle = lower(query)
  if (!needle) return true
  const haystack = [note.transcript, note.polished, categoryName, ...(note.tags ?? [])]
  return haystack.some((value) => lower(value).includes(needle))
}

function sortNotes(notes: readonly NoteEntry[], sort: NoteSort): NoteEntry[] {
  const decorated = notes.map((note, index) => ({
    note,
    index,
    at: finite(note.createdAt)
  }))
  decorated.sort((a, b) => {
    const byTime = sort === 'oldest' ? a.at - b.at : b.at - a.at
    // Equal timestamps keep the caller's order; without the index tie-break the
    // list would shuffle whenever two notes share a millisecond.
    return byTime !== 0 ? byTime : a.index - b.index
  })
  return decorated.map((row) => row.note)
}

/**
 * Search, category, tags and sort in one pass. Selection never mutates the
 * input array: the page keeps the store in state and would otherwise re-render
 * with a reordered list behind its back.
 */
export function filterNotes(
  notes: readonly NoteEntry[],
  filter: NotesFilter = {},
  categories: readonly NoteCategory[] = []
): NoteEntry[] {
  const query = filter.query ?? ''
  const categoryId = filter.categoryId ?? ALL_CATEGORIES
  const tags = filter.tags ?? []
  const sort = filter.sort ?? 'newest'
  const rows = notes.filter((note) => {
    if (categoryId !== ALL_CATEGORIES && (note.categoryId ?? '') !== categoryId) return false
    if (tags.length > 0 && !tags.every((tag) => (note.tags ?? []).includes(tag))) return false
    return matchesQuery(note, query, categoryNameOf(categories, note.categoryId))
  })
  return sortNotes(rows, sort)
}

/**
 * Tag cloud for the filter row: most used first, ties broken by a Chinese-aware
 * compare so the order is stable across runs and machines.
 */
export function collectTags(notes: readonly NoteEntry[], limit = TAG_FILTER_LIMIT): TagCount[] {
  const counts = new Map<string, number>()
  for (const note of notes) {
    // One note contributes at most one count per tag, so a duplicated tag in a
    // single note cannot outvote two notes that really share it.
    const seen = new Set<string>()
    for (const raw of note.tags ?? []) {
      const tag = text(raw)
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  const rows: TagCount[] = [...counts].map(([tag, count]) => ({ tag, count }))
  rows.sort(
    (a, b) =>
      b.count - a.count ||
      a.tag.localeCompare(b.tag, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) ||
      a.tag.localeCompare(b.tag)
  )
  return limit > 0 ? rows.slice(0, limit) : rows
}

/** `4s` — list rows and the detail header both use plain seconds. */
export function formatDuration(ms: number): string {
  const safe = finite(ms)
  return `${Math.round((safe > 0 ? safe : 0) / 1000)}s`
}

/** `0:07` / `1:05` — the player clock and the recording timer. */
export function formatClock(ms: number): string {
  const safe = finite(ms)
  const total = Math.floor((safe > 0 ? safe : 0) / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export interface Stamp {
  /** `HH:mm`, local time. */
  time: string
  /** `MM-DD`, local time. */
  day: string
  /** Full local date and time, for the detail header and tooltips. */
  full: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * List rows show the local clock time and the calendar day separately: two notes
 * from the same afternoon still read apart, and no row needs a wide timestamp.
 */
export function formatStamp(ts: number): Stamp {
  const safe = finite(ts)
  const date = new Date(safe)
  if (safe <= 0 || Number.isNaN(date.getTime())) {
    return { time: '--:--', day: '--', full: '' }
  }
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const full = `${date.getFullYear()}-${day} ${time}`
  return { time, day, full }
}

export function nextSaveState(prev: SaveState, event: SaveEvent): SaveState {
  switch (event) {
    case 'edited':
      return 'pending'
    case 'flushStarted':
      return 'saving'
    case 'flushSucceeded':
      // A success that lands while newer keystrokes are pending describes an
      // older write, so it must not clear the indicator.
      return prev === 'saving' ? 'saved' : prev
    case 'flushFailed':
      return 'error'
    case 'reset':
      return 'idle'
    default:
      return prev
  }
}

/** i18n key for the save line, or `null` when nothing should be shown. */
export function saveStateKey(state: SaveState): string | null {
  switch (state) {
    case 'pending':
    case 'saving':
      return 'notes.saveSaving'
    case 'saved':
      return 'notes.saveSaved'
    case 'error':
      return 'notes.saveFailed'
    default:
      return null
  }
}

export interface EmptyInput {
  /** Notes in the store, before filtering. */
  total: number
  /** Notes left after filtering. */
  visible: number
}

/**
 * Two different empty panes: an empty library has to teach the 录音 button, an
 * over-filtered one has to teach the filters. Showing the wrong one is the usual
 * reason people think their notes vanished.
 */
export function emptyStateKind(input: EmptyInput): NotesEmpty {
  if (input.visible > 0) return 'none'
  return input.total > 0 ? 'filters' : 'records'
}

export interface EmptyCopy {
  titleKey: string
  hintKey: string
}

export function emptyStateCopy(kind: NotesEmpty): EmptyCopy {
  if (kind === 'filters') {
    return { titleKey: 'notes.emptyFilters', hintKey: 'notes.emptyFiltersHint' }
  }
  return { titleKey: 'notes.emptyRecords', hintKey: 'notes.emptyRecordsHint' }
}

export function categoryNameOf(categories: readonly NoteCategory[], id: string | undefined): string {
  if (!id) return ''
  return categories.find((entry) => entry.id === id)?.name ?? ''
}

/** Closest offered rate; a hand-edited settings file must not break playback. */
export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  let best: number = PLAYBACK_RATES[1]
  let bestGap = Number.POSITIVE_INFINITY
  for (const candidate of PLAYBACK_RATES) {
    const gap = Math.abs(candidate - rate)
    if (gap < bestGap) {
      bestGap = gap
      best = candidate
    }
  }
  return best
}

/** `#tag` and stray inner whitespace are typing habits, not data. */
export function normalizeTag(raw: string): string {
  // Trim first: `#` only counts as a marker when it leads the tag, not after the
  // spaces a keystroke leaves behind.
  return (raw ?? '')
    .trim()
    .replace(/^#+/, '')
    .replace(SPACES, ' ')
    .trim()
}

const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Append one typed tag. Returns the input unchanged (as a fresh array) for a
 * blank, duplicate or over-limit entry, so the caller can compare lengths to
 * know whether anything happened.
 */
export function addTag(tags: readonly string[], raw: string, max = MAX_TAGS): string[] {
  const current = [...(tags ?? [])]
  const tag = normalizeTag(raw)
  if (!tag) return current
  if (current.length >= max) return current
  if (current.some((existing) => sameTag(existing, tag))) return current
  current.push(tag)
  return current
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  return (tags ?? []).filter((existing) => !sameTag(existing, normalizeTag(tag)))
}

/** Filter-row chips toggle: present means "must have it". */
export function toggleTag(tags: readonly string[], tag: string, max = Number.POSITIVE_INFINITY): string[] {
  const current = [...(tags ?? [])]
  const next = normalizeTag(tag)
  if (!next) return current
  const index = current.findIndex((existing) => sameTag(existing, next))
  if (index >= 0) {
    current.splice(index, 1)
    return current
  }
  if (current.length >= max) return current
  current.push(next)
  return current
}
