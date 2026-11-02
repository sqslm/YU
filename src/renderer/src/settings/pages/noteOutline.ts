/**
 * The heading outline of a note, for the 大纲 pane of the sidebar.
 *
 * The markdown body is the only source of truth here: the rich editor and the
 * source view both load it, so one parse serves both. `offset` is the heading
 * line's character position in the document, which is what the source view needs
 * to put its caret on the line. The rich view has to be matched by text instead —
 * its heading list is not this list (see `matchHeadingIndex`).
 */
export interface NoteHeading {
  /** 1–6, matching the `#` count. */
  level: number
  /** Heading text with inline markers (`**`, backticks, link targets) removed. */
  text: string
  /** Character offset of the heading line's start. */
  offset: number
}

/** Apply a source-editor heading command to either a paragraph or an existing heading. */
export function markdownHeading(line: string, level: number): string {
  return (level === 0 ? '' : `${'#'.repeat(level)} `) + line.replace(/^\s*#{1,6}\s+/, '')
}

/** ``` or ~~~ at the start of a line, with or without an info string. */
const FENCE = /^\s{0,3}(?:```|~~~)/

/** `### 标题 ###` — the closing hashes are decoration. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/

/** Inline markers a menu row should not repeat verbatim. */
const plain = (text: string): string =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim()

/** Every heading of `markdown`, in document order, skipping fenced code. */
export function noteHeadings(markdown: string): NoteHeading[] {
  const headings: NoteHeading[] = []
  let offset = 0
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced) {
      const match = HEADING.exec(line)
      if (match) {
        const text = plain(match[2])
        // `#` alone is an empty heading; the editor renders nothing to scroll to.
        if (text) headings.push({ level: match[1].length, text, offset })
      }
    }
    offset += line.length + 1
  }
  return headings
}

/** Collapses whitespace so editor text and parsed text compare equal. */
const same = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * Which rich-editor heading belongs to outline row `index`.
 *
 * The two lists are not the same list. This parser only sees top-level `#` lines,
 * while ProseMirror also renders headings inside quotes and keeps the ones whose
 * text is empty — so as soon as a note contains such a heading the two orders
 * drift apart and index-by-index jumps one heading off (the reported "点的大纲
 * 节点和高亮的节点不一致").
 *
 * Rows are matched by text instead, walking forward through the editor's headings:
 * repeated section names still land on their own occurrence, and an extra heading
 * the outline never listed is simply stepped over. If a row's text has no match at
 * all (the heading was edited a moment ago), the raw index is the fallback.
 */
export function matchHeadingIndex(domTexts: readonly string[], outline: readonly NoteHeading[], index: number): number {
  const wanted = outline[index]
  if (!wanted) return index
  let cursor = 0
  for (let row = 0; row <= index; row += 1) {
    const target = same(outline[row].text)
    let found = -1
    for (let at = cursor; at < domTexts.length; at += 1) {
      if (same(domTexts[at]) === target) { found = at; break }
    }
    if (found < 0) return index
    if (row === index) return found
    cursor = found + 1
  }
  return index
}
