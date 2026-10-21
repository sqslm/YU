import type { Replacement } from './types'
import { MAX_DICTIONARY_ENTRIES, MAX_DICTIONARY_TERM } from './defaults'

/**
 * The dictionary page's three views. `auto` entries were learned from the
 * user's post-insertion edits, `manual` ones were typed or imported. The tabs
 * are real filters — they used to be a single identity ternary (REQ-04).
 */
export type DictionaryTab = 'all' | 'auto' | 'manual'

/** One visible line: the stored entry plus where it lives in `replacements`. */
export interface DictionaryRow {
  index: number
  entry: Replacement
}

/**
 * One importable line. `from` is what the user says, `to` is what should be
 * written; an empty `to` means the row only teaches a spelling (a hint).
 */
export interface CsvRow {
  from: string
  to: string
}

/** Result of parsing a pasted or uploaded CSV file. */
export interface ParsedCsv {
  /**
   * Usable rows, in file order, already de-duplicated and length-capped. A row
   * keeps both cells because an exported `原文,替换` pair must stay a pair:
   * dropping the second column used to silently turn every mapping into a hint.
   */
  rows: CsvRow[]
  /** Rows thrown away: empty first cell or a term past `MAX_DICTIONARY_TERM`. */
  invalid: number
  /**
   * How many of `invalid` were rejected for length alone. The import preview
   * names that reason separately, because "too long" is fixable by the user
   * while a blank first cell usually just means a malformed file.
   */
  overlong: number
  /** Rows repeating a term that already appeared earlier in the same file. */
  duplicates: number
  /** Valid rows left out because the file held more than the dictionary cap. */
  truncated: number
}

/** Options shared by `addTerm` / `mergeTerms`. */
export interface TermOptions {
  /** Target spelling; omitted or blank makes the entry a glossary-only hint. */
  to?: string
  mode?: 'replace' | 'hint'
  origin?: 'auto' | 'manual'
  /** Epoch ms of the confirmation; injectable so tests stay deterministic. */
  now?: number
}

/** How many candidates one edit may teach. */
export const MAX_LEARNED_TERMS = 10

/**
 * Words that are common enough that learning them would only pollute the
 * dictionary. Chinese first, then English, all lowercase.
 */
const STOPWORDS = new Set<string>([
  // Chinese
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '因为', '所以', '但是',
  '然后', '现在', '已经', '一下', '一个', '没有', '还是', '应该', '需要', '自己',
  // English
  'the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'from',
  'have', 'will', 'your', 'but', 'not', 'can', 'all', 'how', 'what', 'they'
])

/**
 * True when `term` is too common to be worth remembering. Exported so the
 * suggestion pool applies the same list as `learnFromEdit` instead of keeping a
 * second copy that can drift.
 */
export function isStopword(term: string): boolean {
  return STOPWORDS.has(key(term))
}

/** Trailing particles that are never part of a learned term. */
const TAIL_PARTICLES = '的了呢吧吗啊呀哦嗯着你我他她它们'

/** First row headers accepted from an exported spreadsheet. */
const HEADER_FIRST = new Set(['from', 'term', 'terms', 'word', '词条', '术语', '原文'])
const HEADER_SECOND = new Set(['to', 'target', 'replacement', '替换', '译文'])

/** Matches the spelling key used by `defaults.normalizeReplacements`. */
function key(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function cleanTerm(value: string): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_DICTIONARY_TERM) : ''
}

/** `origin` is optional in persisted data; a missing value is a manual entry. */
export function entryOrigin(entry: Replacement): 'auto' | 'manual' {
  return entry.origin === 'auto' ? 'auto' : 'manual'
}

/**
 * Column separators we accept, most likely first. Spreadsheet exports in the
 * wild use commas, Japanese/Chinese Excel saves tabs, and European locales use
 * semicolons; picking one of them per file is cheaper than asking the user.
 */
const DELIMITERS = [',', '\t', ';'] as const

/**
 * Splits one CSV line into cells. Double quotes may wrap a cell and a doubled
 * quote inside quotes is a literal quote, so `"钉钉, 企业版"` stays one term.
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells
}

/**
 * Picks the separator for the whole file from its first non-blank line: the one
 * that yields the most cells there. Splitting (rather than counting characters)
 * means a comma inside quotes never wins the vote, and the strict `>` keeps the
 * comma as the tie-break, which is the common case.
 */
function detectDelimiter(line: string): string {
  let best: string = DELIMITERS[0]
  let bestCells = 1
  for (const candidate of DELIMITERS) {
    const cells = splitCsvLine(line, candidate).length
    if (cells > bestCells) {
      best = candidate
      bestCells = cells
    }
  }
  return best
}

function isHeaderRow(cells: string[]): boolean {
  const first = (cells[0] ?? '').trim().toLocaleLowerCase()
  if (!HEADER_FIRST.has(first)) return false
  if (cells.length === 1) return true
  const second = (cells[1] ?? '').trim().toLocaleLowerCase()
  return HEADER_SECOND.has(second)
}

/**
 * Parses a one- or two-column CSV. The first cell of every line is the term and
 * a second cell, when present, is its replacement; any further cells are
 * ignored so a richer export still imports. BOMs, CRLF, blank lines, quoted
 * cells, a leading header row and comma/tab/semicolon separators are handled.
 */
export function parseCsv(input: string): ParsedCsv {
  const result: ParsedCsv = {
    rows: [],
    invalid: 0,
    overlong: 0,
    duplicates: 0,
    truncated: 0
  }
  if (typeof input !== 'string' || input.length === 0) return result

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const lines = text.split(/\r\n|\n|\r/)
  // One separator per file, decided from the first non-blank line: deciding per
  // line would let a stray ';' inside one cell re-split later rows differently.
  const firstLine = lines.find((line) => line.trim().length > 0)
  const delimiter = firstLine === undefined ? ',' : detectDelimiter(firstLine)
  const seen = new Set<string>()
  let firstRow = true

  for (const line of lines) {
    const raw = line.trim()
    if (!raw) continue
    const cells = splitCsvLine(raw, delimiter)
    if (firstRow) {
      firstRow = false
      if (isHeaderRow(cells)) continue
    }
    const from = (cells[0] ?? '').trim()
    if (!from) {
      result.invalid += 1
      continue
    }
    // Rejected rather than truncated: a silently cut word would teach the model
    // a spelling the user never wrote.
    if (from.length > MAX_DICTIONARY_TERM) {
      result.invalid += 1
      result.overlong += 1
      continue
    }
    const spelling = key(from)
    if (seen.has(spelling)) {
      // The first occurrence wins, so a stray later line cannot rewrite an
      // earlier mapping of the same word.
      result.duplicates += 1
      continue
    }
    if (result.rows.length >= MAX_DICTIONARY_ENTRIES) {
      // The caller shows this count so a cut-off import never looks complete.
      result.truncated += 1
      continue
    }
    seen.add(spelling)
    result.rows.push({ from, to: (cells[1] ?? '').trim() })
  }

  return result
}

/** Common prefix + suffix of `before`/`after`, expressed as a span of `after`. */
function changedRegion(
  before: string,
  after: string
): { start: number; end: number; changed: string; removed: number } {
  const max = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const end = Math.max(prefix, after.length - suffix)
  return {
    start: prefix,
    end,
    changed: after.slice(prefix, end),
    removed: before.length - prefix - suffix
  }
}

function trimTail(term: string): string {
  let out = term
  while (out.length > 2 && TAIL_PARTICLES.includes(out[out.length - 1] ?? '')) {
    out = out.slice(0, -1)
  }
  return out
}

/**
 * Learns dictionary candidates from one post-insertion edit: the user saw the
 * AI text `before` and left `after`. Only text the user actually introduced is
 * considered, common words are dropped, and at most `MAX_LEARNED_TERMS` come
 * back so a single edit cannot flood the dictionary.
 */
export function learnFromEdit(before: string, after: string): string[] {
  const prior = typeof before === 'string' ? before : ''
  const next = typeof after === 'string' ? after : ''
  if (!next.trim() || next === prior || !prior.trim()) return []

  const priorLower = prior.toLocaleLowerCase()
  const seen = new Set<string>()
  const found: string[] = []

  const consider = (raw: string): void => {
    const term = trimTail(raw.trim())
    if (term.length < 2 || term.length > MAX_DICTIONARY_TERM) return
    const spelling = key(term)
    if (seen.has(spelling) || priorLower.includes(spelling)) return
    if (STOPWORDS.has(spelling)) return
    seen.add(spelling)
    found.push(term)
  }

  const scan = (text: string): void => {
    for (const match of text.matchAll(/[\u4e00-\u9fff]{2,8}/g)) consider(match[0])
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g)) consider(match[0])
  }

  const { start, end, changed, removed } = changedRegion(prior, next)
  // A wholesale rewrite says nothing about spelling, so it teaches nothing.
  if (changed.length > 20 && changed.length > next.length * 0.6) return []

  scan(changed)
  // A one-character CJK swap ("祝福" → "祝祷") is invisible to the 2+ char
  // matcher, so widen that single character by one neighbour on each side.
  if (/^[\u4e00-\u9fff]$/.test(changed)) {
    scan(next.slice(Math.max(0, start - 1), Math.min(next.length, end + 1)))
  }
  if (found.length === 0 && removed > 0) scan(next)
  return found.slice(0, MAX_LEARNED_TERMS)
}

/**
 * Adds or refreshes one term. Adding an existing spelling never duplicates a
 * row: an auto-learned entry keeps its provenance, counts one more hit, and
 * gets a fresh `updatedAt` so the list can show it as recently confirmed.
 */
export function addTerm(
  entries: Replacement[],
  term: string,
  opts: TermOptions = {}
): Replacement[] {
  const from = cleanTerm(term)
  if (!from) return entries
  const now = opts.now ?? Date.now()
  const to = typeof opts.to === 'string' ? opts.to.trim() : undefined
  const origin = opts.origin ?? 'manual'
  const spelling = key(from)
  const index = entries.findIndex((entry) => key(entry.from) === spelling)

  if (index < 0) {
    if (entries.length >= MAX_DICTIONARY_ENTRIES) return entries
    const entry: Replacement = {
      from,
      to: to ?? '',
      mode: opts.mode ?? (to ? 'replace' : 'hint'),
      origin,
      updatedAt: now
    }
    if (origin === 'auto') entry.hits = 1
    return [...entries, entry]
  }

  const existing = entries[index]
  const nextTo = to ?? existing.to
  const keepOrigin = existing.origin ?? origin
  const next: Replacement = {
    ...existing,
    to: nextTo,
    mode: opts.mode ?? existing.mode ?? (nextTo ? 'replace' : 'hint'),
    origin: keepOrigin,
    updatedAt: now
  }
  if (keepOrigin === 'auto') next.hits = (existing.hits ?? 0) + 1
  else if (existing.hits !== undefined) next.hits = existing.hits

  const out = [...entries]
  out[index] = next
  return out
}

/** Drops every entry whose spelling matches one of `terms` (case-insensitive). */
export function removeTerms(entries: Replacement[], terms: string[]): Replacement[] {
  if (!Array.isArray(terms) || terms.length === 0) return entries
  const doomed = new Set(terms.map(key))
  const out = entries.filter((entry) => !doomed.has(key(entry.from)))
  return out.length === entries.length ? entries : out
}

/**
 * Adds many terms at once (CSV import, learned suggestions). Same contract as
 * `addTerm`: no duplicates, existing provenance survives, hits increase.
 *
 * Rows may be bare strings (learned candidates, hints) or `{from,to}` pairs
 * (imported mappings). A pair with a target always becomes `mode: 'replace'`;
 * a target-less row leaves `to`/`mode` untouched on an existing entry, so
 * re-importing a single-column file never downgrades a working mapping.
 */
export function mergeTerms(
  entries: Replacement[],
  terms: Array<string | CsvRow>,
  opts: TermOptions = {}
): Replacement[] {
  if (!Array.isArray(terms) || terms.length === 0) return entries
  let out = entries
  for (const item of terms) {
    const row: CsvRow = typeof item === 'string' ? { from: item, to: '' } : item
    if (!row || typeof row.from !== 'string') continue
    const to = typeof row.to === 'string' ? row.to.trim() : ''
    out = addTerm(out, row.from, to ? { ...opts, to, mode: 'replace' } : opts)
  }
  return out
}

/** Entry counts for the three tabs, including entries with no explicit origin. */
export function countByTab(entries: Replacement[]): Record<DictionaryTab, number> {
  const counts: Record<DictionaryTab, number> = { all: entries.length, auto: 0, manual: 0 }
  for (const entry of entries) counts[entryOrigin(entry)] += 1
  return counts
}

/**
 * Rows for the current tab + search box, newest add first (entries are stored
 * in append order, so reversing the stored order is the definition of "newest").
 */
export function filterDictionary(
  entries: Replacement[],
  tab: DictionaryTab,
  query: string
): DictionaryRow[] {
  const needle = query.trim().toLocaleLowerCase()
  const rows: DictionaryRow[] = []
  entries.forEach((entry, index) => {
    if (tab !== 'all' && entryOrigin(entry) !== tab) return
    if (needle && !`${entry.from}\n${entry.to}`.toLocaleLowerCase().includes(needle)) return
    rows.push({ index, entry })
  })
  return rows.reverse()
}
