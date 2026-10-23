/**
 * A deliberately small Markdown reader for the answer card.
 *
 * The card used to print the model's text verbatim, so a normal answer arrived
 * on screen as `## 平陆运河简介` and `**位置与走向**: …` — the prompt asks for
 * Markdown (`shared/prompts.ts`), the card had no reader. A full Markdown engine
 * (remark + rehype) would pull ~60 kB into a 4 kB window for features the card
 * will never show, so this handles exactly the subset the answers use: ATX
 * headings, paragraphs, bullet and numbered lists, blockquotes, fenced code,
 * rules, and inline strong / emphasis / code / links / `[3]`-style citations.
 *
 * Two behaviours matter more than completeness:
 *
 * 1. **It never throws.** The answer streams in a few characters at a time, so
 *    every prefix of a real answer is valid input: an unterminated `**` stays
 *    literal text, and an unterminated fence keeps the rest as a code block.
 * 2. **It is pure.** Blocks are plain data, which is what `markdown.test.ts`
 *    asserts; the React side only decides what the blocks look like.
 */

/** One run of text inside a block. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  /** `[3]` — a citation marker that points at the card's 来源 list. */
  | { kind: 'cite'; label: string }

export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; headers: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'center' | 'right'> }
  | { kind: 'rule' }

import { isSafeLink } from '@shared/links'

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const BULLET = /^\s{0,3}[-*•]\s+(.*)$/
const ORDERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

/** Pipes in inline code or escaped with a backslash belong to the cell. */
function tableCells(line: string): string[] {
  const cells: string[] = []
  let text = '', code = false
  const row = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') { text += '|'; i++; continue }
    if (row[i] === '`') code = !code
    if (row[i] === '|' && !code) { cells.push(text.trim()); text = '' }
    else text += row[i]
  }
  cells.push(text.trim())
  return cells
}

/** Anything the reader should treat as "the paragraph ended here". */
function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** Finds `marker` in `text` at or after `from`; -1 when it is not (yet) there. */
function findClose(text: string, marker: string, from: number): number {
  let at = text.indexOf(marker, from)
  while (at >= 0 && marker[0] === '_' && /[a-z0-9]/i.test(text[at - 1] ?? '') && /[a-z0-9]/i.test(text[at + marker.length] ?? '')) at = text.indexOf(marker, at + marker.length)
  if (at <= from) return -1
  // `**` must not close on the first half of a `***` run, and a marker that is
  // immediately followed by the same character is part of a longer run; letting
  // it close there rendered `**a**b**` as bold("a") + bold("b") instead of
  // bold("a") + "b**".
  if (at + marker.length < text.length && text[at + marker.length] === marker[0]) return -1
  return at
}

/**
 * Splits one line of text into styled runs.
 *
 * Order matters: code first (its content is literal), then links, then the
 * emphasis pair, then citations. A delimiter with no closing partner is emitted
 * as plain text, which is what keeps a half-streamed answer readable.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  let i = 0

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }

  while (i < text.length) {
    const char = text[i]!

    if (char === '\\' && /[\\`*_{}[\]()#+.!|>~-]/.test(text[i + 1] ?? '')) {
      buffer += text[i + 1]; i += 2; continue
    }

    if (char === '`') {
      const close = findClose(text, '`', i + 1)
      if (close !== -1) {
        flush()
        out.push({ kind: 'code', text: text.slice(i + 1, close) })
        i = close + 1
        continue
      }
    }

    if (char === '[') {
      // `[label](url)` first: a citation never has a paren right after it.
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          flush()
          const label = text.slice(i + 1, closeBracket)
          const href = text.slice(closeBracket + 2, closeParen).trim()
          // The card renders Markdown that came from a page the model read, so
          // the href is attacker-controlled. An unsafe scheme is shown as plain
          // label text: never drawn as something the user can click.
          if (isSafeLink(href)) out.push({ kind: 'link', text: label, href })
          else out.push({ kind: 'text', text: label })
          i = closeParen + 1
          continue
        }
      }
      if (closeBracket !== -1) {
        const label = text.slice(i + 1, closeBracket)
        // `[1]`, `[1][2]`, `[来源]`: short and paren-free, so it is a citation.
        if (/^[0-9]{1,2}$|^[^\s{}()[\]|]{1,8}$/.test(label)) {
          flush()
          out.push({ kind: 'cite', label })
          i = closeBracket + 1
          continue
        }
      }
    }

    if (char === '*' || char === '_') {
      if (char === '_' && /[a-z0-9]/i.test(text[i - 1] ?? '')) { buffer += char; i++; continue }
      const marker = char.repeat(2)
      if (text.startsWith(marker, i)) {
        const close = findClose(text, marker, i + 2)
        if (close !== -1) {
          flush()
          out.push({ kind: 'strong', text: text.slice(i + 2, close) })
          i = close + 2
          continue
        }
      } else {
        const close = findClose(text, char, i + 1)
        const inner = close === -1 ? '' : text.slice(i + 1, close)
        // `snake_case` and `2 * 3` are not emphasis: require the run to hug its
        // content on both sides, the same test the Markdown spec applies.
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          flush()
          out.push({ kind: 'em', text: inner })
          i = close + 1
          continue
        }
      }
    }

    buffer += char
    i += 1
  }

  flush()
  return out
}

/**
 * Reads `source` into blocks.
 *
 * Wrapped bullets are re-joined rather than turned into paragraphs: models wrap
 * long lines at ~80 columns, and a soft continuation of a `-` item that became
 * its own paragraph read as a layout bug.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    blocks.push({
      kind: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item))
    })
    list = null
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    blocks.push({ kind: 'quote', inlines: parseInline(quote.join('\n')) })
    quote = []
  }
  const flushAll = (): void => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = FENCE.exec(line)
    if (fence) {
      flushAll()
      const marker = fence[1]!
      const lang = fence[2] ?? ''
      const body: string[] = []
      let closed = false
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index]!
        const closing = next.trim()
        if (closing[0] === marker[0] && closing.length >= marker.length && /^(?:`+|~+)$/.test(closing)) {
          closed = true
          break
        }
        body.push(next)
      }
      // A fence that has not closed yet is still an open code block while the
      // answer streams; rendering it as code is what the finished text will be.
      // Trailing blank lines are dropped: they are the gap before the closing
      // fence (or the end of a still-streaming answer), not part of the snippet.
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      if (!closed) break
      continue
    }

    if (isBlank(line)) {
      flushAll()
      continue
    }

    const divider = tableCells(lines[index + 1] ?? '')
    const headers = tableCells(line)
    if (line.includes('|') && headers.length > 1 && divider.length === headers.length && divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flushAll()
      const rows: Inline[][][] = []
      index++
      while (index + 1 < lines.length && lines[index + 1]!.includes('|') && !FENCE.test(lines[index + 1]!) && !HEADING.test(lines[index + 1]!)) {
        const cells = tableCells(lines[++index]!)
        rows.push(headers.map((_, cell) => parseInline(cells[cell] ?? '')))
      }
      blocks.push({ kind: 'table', headers: headers.map(parseInline), rows,
        align: divider.map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left') })
      continue
    }

    if (RULE.test(line)) {
      flushAll()
      blocks.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushAll()
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        inlines: parseInline(heading[2]!.trim())
      })
      continue
    }

    const quoteLine = QUOTE.exec(line)
    if (quoteLine) {
      flushParagraph()
      flushList()
      quote.push(quoteLine[1] ?? '')
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      flushParagraph()
      flushQuote()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1]!.trim())
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered) {
      flushParagraph()
      flushQuote()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[2]!.trim())
      continue
    }

    // A plain line directly under a list item continues that item.
    if (list && list.items.length > 0 && /^\s{1,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }

  flushAll()
  return blocks
}
