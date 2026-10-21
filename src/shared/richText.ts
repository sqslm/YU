/**
 * Markdown → HTML for rich insertion.
 *
 * Scope is deliberately tiny: the constructs a dictated-then-polished paragraph
 * actually contains — bold, italic, inline code, and bullet or numbered lists.
 * Everything else stays literal text, because this HTML is pasted straight into
 * whatever application has focus, and a converter that guesses (tables, images,
 * links) would be rewriting content the user never asked to have rewritten.
 *
 * A string with no Markdown in it returns `null`, so the caller keeps the plain
 * paste path instead of sending an HTML flavour nobody needs.
 */

const INLINE: Array<{ pattern: RegExp; wrap: string }> = [
  // Order matters: `**bold**` has to be consumed before a single `*` can match.
  { pattern: /\*\*([^*\n]+)\*\*/g, wrap: 'b' },
  { pattern: /__([^_\n]+)__/g, wrap: 'b' },
  { pattern: /`([^`\n]+)`/g, wrap: 'code' },
  { pattern: /\*([^*\n]+)\*/g, wrap: 'i' },
  { pattern: /_([^_\n]+)_/g, wrap: 'i' }
]

/** Anything that makes the plain-text paste visibly wrong. */
const MARKUP = /(\*\*|__|`)|(^|\n)\s*(?:[-+*]\s|\d+[.)]\s|#{1,6}\s)/

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(value: string): string {
  let out = escapeHtml(value)
  for (const rule of INLINE) out = out.replace(rule.pattern, `<${rule.wrap}>$1</${rule.wrap}>`)
  return out
}

/**
 * Returns the HTML flavour, or `null` when the text carries no Markdown.
 *
 * Headings become bold paragraphs rather than `<h1>`–`<h6>`: a pasted heading
 * brings its own font size and margins into a mail body or a document, which
 * fights the target's own styles far more than the emphasis is worth.
 */
export function markdownToHtml(markdown: string): string | null {
  const source = (markdown ?? '').trim()
  if (!source || !MARKUP.test(source)) return null

  const blocks: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  const flush = (): void => {
    if (!list) return
    const items = list.items.map((item) => `<li>${item}</li>`).join('')
    blocks.push(`<${list.tag}>${items}</${list.tag}>`)
    list = null
  }

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const bullet = /^[-+*]\s+(.*)$/.exec(line)
    if (bullet) {
      if (!list || list.tag !== 'ul') {
        flush()
        list = { tag: 'ul', items: [] }
      }
      list.items.push(inline(bullet[1]))
      continue
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      if (!list || list.tag !== 'ol') {
        flush()
        list = { tag: 'ol', items: [] }
      }
      list.items.push(inline(numbered[1]))
      continue
    }
    flush()
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(`<p><b>${inline(heading[1])}</b></p>`)
      continue
    }
    blocks.push(`<p>${inline(line)}</p>`)
  }
  flush()

  if (blocks.length === 0) return null
  // No font, size or colour: the target's own styling has to win, otherwise
  // inserting into a document changes how the surrounding text looks.
  return `<div>${blocks.join('')}</div>`
}
