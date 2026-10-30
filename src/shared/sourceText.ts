/**
 * Removing the source list an answer writes into its own prose.
 *
 * Two producers put sources in an answer: the model (the ask prompt tells it to
 * cite, and some models still append their own `## 来源` list) and `appendSources`
 * in `agent.ts`. Every surface that renders sources as its own clickable section —
 * the answer card, the chat page — would then show the same list twice: once as
 * body text, once as cards. The user sees a duplicate, so the body copy goes.
 *
 * Deleting "everything after a heading called 来源" would eat real prose when a
 * model happens to write a section with that name, so a candidate is only accepted
 * when the lines under it actually look like citations (links, or a bullet list
 * with no prose). Pure string in / string out so the card, the chat store and the
 * tests all agree.
 */

/** `## 来源`, `### 参考资料：`, `来源：`, `Sources`, `References` … */
const HEADING = /^#{1,6}\s*(参考来源|参考资料|参考链接|信息来源|资料来源|引用来源|来源|相关链接|延伸阅读|sources?|references?|further reading)\s*[：:]?\s*(?:[（(][^)）]{0,40}[)）])?\s*$/i

/** `**来源：**` on its own line. */
const BOLD = /^\*\*\s*(参考来源|参考资料|参考链接|信息来源|资料来源|引用来源|来源|sources?|references?)\s*[：:]?\s*\*\*\s*$/i

/** A bare `来源：` line with no markdown at all. */
const PLAIN = /^(参考来源|参考资料|参考链接|信息来源|资料来源|引用来源|来源|sources?|references?)\s*[：:]\s*$/i

/** A list marker the model uses for citations. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/

/** Anything that points somewhere. */
const HAS_URL = /https?:\/\/|www\./i

/**
 * True when `lines` read like a citation block rather than prose.
 *
 * Deliberately strict: one line of prose under `## 来源` is a section the model
 * meant to write, and cutting it would lose the answer's own wording.
 */
function looksLikeSources(lines: readonly string[]): boolean {
  const rows = lines.map((line) => line.trim()).filter(Boolean)
  if (!rows.length || rows.length > 40) return false
  let links = 0
  for (const row of rows) {
    const item = LIST_ITEM.test(row)
    if (item && HAS_URL.test(row)) { links += 1; continue }
    if (item) continue
    // Continuation lines under a citation item ("  - 副标题") are fine, but a full
    // sentence of prose means this heading was not a source list.
    if (HAS_URL.test(row) && row.length < 400) { links += 1; continue }
    if (/^\s{2,}\S/.test(row)) continue
    return false
  }
  return links >= 1
}

/** First index of a trailing run of citation bullets, or -1. */
function trailingLinks(lines: readonly string[]): number {
  let index = lines.length - 1
  while (index >= 0 && !lines[index].trim()) index -= 1
  let start = -1
  let links = 0
  while (index >= 0) {
    const row = lines[index].trim()
    if (!row) break
    if (!LIST_ITEM.test(row)) break
    if (!HAS_URL.test(row)) break
    links += 1
    start = index
    index -= 1
  }
  return links >= 2 ? start : -1
}

/**
 * Drops a trailing source section from `text`.
 *
 * Returns the input unchanged when there is nothing that reads like a citation
 * list, so it is safe to run on every answer.
 */
export function stripSourceTail(text: string): string {
  if (typeof text !== 'string' || !text.trim()) return text
  const lines = text.split('\n')
  let cut = -1
  for (let index = 0; index < lines.length; index += 1) {
    const row = lines[index].trim()
    if (!HEADING.test(row) && !BOLD.test(row) && !PLAIN.test(row)) continue
    if (!looksLikeSources(lines.slice(index + 1))) continue
    cut = index
    break
  }
  if (cut < 0) cut = trailingLinks(lines)
  if (cut < 0) return text
  return lines.slice(0, cut).join('\n').replace(/\s+$/, '')
}
