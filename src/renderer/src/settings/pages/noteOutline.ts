/**
 * The heading outline of a note, for the 目录 drawer next to the editor.
 *
 * The markdown body is the only source of truth here: the rich editor and the
 * source view both load it, so one parse serves both. `offset` is the heading
 * line's character position in the document, which is what the source view needs
 * to put its caret on the line, and what the rich view's heading order lines up
 * with.
 */
export interface NoteHeading {
  /** 1–6, matching the `#` count. */
  level: number
  /** Heading text with inline markers (`**`, backticks, link targets) removed. */
  text: string
  /** Character offset of the heading line's start. */
  offset: number
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
