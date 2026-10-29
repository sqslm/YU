/**
 * Markdown 按块编辑所需的纯函数。
 *
 * 编辑器一次只把「光标所在的那一块」变成 textarea，所以需要一个和 CommonMark
 * 判断一致的切块规则：空行分块，但代码围栏内部的空行不算；列表 / 表格 / 引用
 * 的「松列表」续行（中间夹空行）仍属于同一块，否则连续两次回车会把同一个列表
 * 拆成两块、编辑列表时缩进就断了。
 *
 * 这里不碰 DOM、不碰 React，全部是字符串进 / 字符串出，方便单测。
 */

export interface MarkdownBlock {
  /** 块内第一个字符在整篇文本里的偏移。 */
  start: number
  /** 块尾之后的位置（不含块后面的空行）。 */
  end: number
  text: string
}

export interface MarkdownEdit {
  text: string
  /** 应用后的光标偏移（整篇文本坐标）。 */
  caret: number
}

interface SourceLine {
  start: number
  end: number
  text: string
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/
const ORDERED_ITEM = /^(\s*)(\d{1,9})([.)])(\s+)/
const TASK_ITEM = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)/
const QUOTE_LINE = /^\s*>/
const TABLE_ROW = /^\s*\|/
const CONTINUATION = /^(\s{2,}|\t)/
/** 文末以空行结束时，编辑器要多给一个空块给光标落脚（连续空行只给一个）。 */
const TRAILING_BLANK = /\n[ \t]*\n[ \t]*$/

type BlockKind = 'text' | 'list' | 'quote' | 'table' | 'fence'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function linesOf(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    lines.push({ start, end, text: text.slice(start, end) })
    start = end + 1
  }
  return lines
}

/** 每行是否处于代码围栏内部（含围栏行本身）。 */
function fenceFlags(lines: readonly SourceLine[]): boolean[] {
  const flags: boolean[] = []
  let open: { char: string; size: number } | null = null
  for (const line of lines) {
    const match = FENCE.exec(line.text)
    if (open) {
      flags.push(true)
      // 收尾围栏：只有围栏字符（可带缩进/尾空格），长度不短于开启的那个
      if (match && match[1][0] === open.char && match[1].length >= open.size && line.text.trim() === match[1]) open = null
      continue
    }
    if (match) {
      open = { char: match[1][0], size: match[1].length }
      flags.push(true)
      continue
    }
    flags.push(false)
  }
  return flags
}

function kindOf(line: string, inFence: boolean): BlockKind {
  if (inFence) return 'fence'
  if (TABLE_ROW.test(line)) return 'table'
  if (QUOTE_LINE.test(line)) return 'quote'
  if (LIST_ITEM.test(line)) return 'list'
  return 'text'
}

/** 空行之后这一行是否仍算同一块：列表 / 引用 / 表格的松续行与缩进续行。 */
function keepsGoing(kind: BlockKind, line: string): boolean {
  if (kind === 'list') return LIST_ITEM.test(line) || CONTINUATION.test(line) || QUOTE_LINE.test(line)
  if (kind === 'quote') return QUOTE_LINE.test(line)
  if (kind === 'table') return TABLE_ROW.test(line)
  return false
}

/**
 * 把整篇 markdown 切成块。返回的 `start` / `end` 是整篇文本坐标，`text` 与
 * `text.slice(start, end)` 完全一致，块之间的空行不属于任何块。
 */
export function splitBlocks(text: string): MarkdownBlock[] {
  const lines = linesOf(text)
  const inFence = fenceFlags(lines)
  const blocks: MarkdownBlock[] = []
  let current: MarkdownBlock | null = null
  let kind: BlockKind = 'text'
  let blanks = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenced = inFence[i]
    if (!fenced && line.text.trim() === '') {
      if (current) blanks += 1
      continue
    }
    if (!current) {
      current = { start: line.start, end: line.end, text: line.text }
      kind = kindOf(line.text, fenced)
      blanks = 0
      continue
    }
    if (blanks > 0 && !keepsGoing(kind, line.text)) {
      blocks.push(current)
      current = { start: line.start, end: line.end, text: line.text }
      kind = kindOf(line.text, fenced)
      blanks = 0
      continue
    }
    blanks = 0
    current.end = line.end
    current.text = text.slice(current.start, line.end)
  }
  if (current) blocks.push(current)
  return blocks
}

/**
 * 编辑器实际渲染的块：文本为空、或文末以空行结束时，补一个空块，让用户在
 * 末尾继续回车有地方落光标。空文本只给一个空块。
 */
export function editorBlocks(text: string): MarkdownBlock[] {
  const blocks = splitBlocks(text)
  if (text === '' || TRAILING_BLANK.test(text)) blocks.push({ start: text.length, end: text.length, text: '' })
  return blocks
}

/** 用 `next` 换掉一块（整篇坐标不变，其余块不受影响）。 */
export function replaceBlock(text: string, block: MarkdownBlock, next: string): string {
  return text.slice(0, block.start) + next + text.slice(block.end)
}

/** 覆盖 `offset` 的块；越界取最近的块。 */
export function blockAt(text: string, offset: number): MarkdownBlock | null {
  const blocks = editorBlocks(text)
  const safe = clamp(offset, 0, text.length)
  for (const block of blocks) if (safe >= block.start && safe <= block.end) return block
  return blocks[blocks.length - 1] ?? null
}

/** 以 `start` 开头的块；找不到时按剩余文本兜底（块被别的逻辑改过时用）。 */
export function blockStartingAt(text: string, start: number): MarkdownBlock {
  const from = clamp(start, 0, text.length)
  return editorBlocks(text).find((block) => block.start === from) ?? { start: from, end: text.length, text: text.slice(from) }
}

/**
 * Enter 拆分时新行自动续上的前缀（Typora 的列表续行）：`- [ ] 甲` → `- [ ] `，
 * `3) 甲` → `4) `，`  - 甲` → `  - `，`> 甲` → `> `，普通段落 → 空串。
 */
export function continuePrefix(line: string): string {
  const quote = /^(\s*>+\s?)/.exec(line)
  const rest = quote ? line.slice(quote[1].length) : line
  const head = quote ? quote[1] : ''
  const ordered = ORDERED_ITEM.exec(rest)
  if (ordered) return `${head}${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}${ordered[4]}`
  const task = TASK_ITEM.exec(rest)
  if (task) return `${head}${task[1]}${task[2]}${task[3]}${task[4].replace(/\[[xX]\]/, '[ ]')}`
  const bullet = LIST_ITEM.exec(rest)
  if (bullet) return `${head}${bullet[1]}${bullet[2]}${bullet[3]}`
  return head
}

/**
 * 在 `offset` 处按 Enter。
 * - 普通段落：插入空行，于是拆成两块；
 * - 列表 / 引用 / 表格 / 围栏代码：只插入换行并续上前缀，让它们保持一块
 *   （否则一个列表每回车一次就散成一堆块，块级渲染也会打断列表编号）。
 */
export function splitBlockAt(text: string, block: MarkdownBlock, offset: number): MarkdownEdit {
  const at = clamp(offset, block.start, block.end)
  const local = at - block.start
  const lines = linesOf(block.text)
  const inFence = fenceFlags(lines)
  let index = lines.findIndex((line) => local >= line.start && local <= line.end)
  if (index < 0) index = Math.max(0, lines.length - 1)
  const line = lines[index]
  const fenced = inFence[index] ?? false
  const lineBefore = block.text.slice(line.start, local)
  const kind = kindOf(line.text, fenced)
  const structural = fenced || kind === 'list' || kind === 'quote' || kind === 'table'
  const prefix = fenced ? '' : continuePrefix(lineBefore)
  const inserted = structural ? `\n${prefix}` : `\n\n${prefix}`
  return { text: `${text.slice(0, at)}${inserted}${text.slice(at)}`, caret: at + inserted.length }
}

/**
 * 块首按 Backspace：吃掉块间空行、并入上一块，光标落在接缝上。
 * 两个普通段落直接相连（Typora 的做法）；涉及列表 / 引用 / 表格 / 代码时保留
 * 一个换行，否则标记会粘到上一段文字里失效。
 */
export function mergeWithPrevious(text: string, blocks: readonly MarkdownBlock[], index: number): MarkdownEdit | null {
  const block = blocks[index]
  const prev = blocks[index - 1]
  if (!block || !prev) return null
  const structural = kindOf(prev.text.split('\n')[0] ?? '', false) !== 'text' || kindOf(block.text.split('\n')[0] ?? '', false) !== 'text'
  const joined = `${prev.text}${structural && block.text !== '' ? '\n' : ''}${block.text}`
  return {
    text: `${text.slice(0, prev.start)}${joined}${text.slice(block.end)}`,
    caret: prev.start + prev.text.length
  }
}

/** 在光标处插入内容（Shift+Enter 的软换行、Tab 缩进都走这里）。 */
export function insertAt(text: string, caret: number, insert: string): MarkdownEdit {
  const at = clamp(caret, 0, text.length)
  return { text: `${text.slice(0, at)}${insert}${text.slice(at)}`, caret: at + insert.length }
}

/**
 * Ctrl+B / I / ` 这类成对标记：有选区就包住，没有就插入一对并把光标放到中间；
 * 选区外面已经是这对标记时取消包裹（同一个快捷键即开关）。
 */
export function wrapInline(text: string, start: number, end: number, before: string, after = before): MarkdownEdit {
  const from = clamp(Math.min(start, end), 0, text.length)
  const to = clamp(Math.max(start, end), 0, text.length)
  const selected = text.slice(from, to)
  const outer = from >= before.length && text.slice(from - before.length, from) === before && text.slice(to, to + after.length) === after
  if (outer) {
    return {
      text: `${text.slice(0, from - before.length)}${selected}${text.slice(to + after.length)}`,
      caret: from - before.length + selected.length
    }
  }
  const inner = selected || '文字'
  return {
    text: `${text.slice(0, from)}${before}${inner}${after}${text.slice(to)}`,
    caret: from + before.length + (selected ? selected.length : inner.length)
  }
}

/** Ctrl+K：包成链接；没有选区时用占位文字，光标直接落在 `(…)` 里等填地址。 */
export function linkInline(text: string, start: number, end: number): MarkdownEdit {
  const from = clamp(Math.min(start, end), 0, text.length)
  const to = clamp(Math.max(start, end), 0, text.length)
  const selected = text.slice(from, to) || '文字'
  return {
    text: `${text.slice(0, from)}[${selected}](url)${text.slice(to)}`,
    caret: from + selected.length + 3
  }
}

const ANY_MARKER = /^(\s*)((?:[-*+]|\d{1,9}[.)])\s+)/
const AS_MARKER = { ordered: /^\s*\d{1,9}[.)]\s+/, unordered: /^\s*[-*+]\s+/ }

/**
 * Ctrl+Shift+7/8：给选区覆盖到的每一行加有序 / 无序列表前缀；整段已经是这种
 * 前缀时取消（同一个快捷键即开关），另一种前缀会被换成这一种。
 */
export function prefixLines(text: string, start: number, end: number, marker: 'ordered' | 'unordered'): MarkdownEdit {
  const from = clamp(Math.min(start, end), 0, text.length)
  const to = clamp(Math.max(start, end), 0, text.length)
  const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const nl = text.indexOf('\n', to)
  const lineEnd = nl < 0 ? text.length : nl
  const rows = text.slice(lineStart, lineEnd).split('\n')
  const tagged = rows.some((row) => row.trim() !== '') && rows.every((row) => row.trim() === '' || AS_MARKER[marker].test(row))
  const next = rows.map((row, index) => {
    const indent = /^\s*/.exec(row)?.[0] ?? ''
    const body = row.slice(indent.length).replace(ANY_MARKER, '')
    if (tagged) return body === '' ? '' : `${indent}${body}`
    return `${indent}${marker === 'ordered' ? `${index + 1}. ` : '- '}${body}`
  })
  const body = next.join('\n')
  const single = from === to && rows.length === 1
  return {
    text: `${text.slice(0, lineStart)}${body}${text.slice(lineEnd)}`,
    caret: single ? from + (next[0].length - rows[0].length) : lineStart + body.length
  }
}

/**
 * 把「渲染后」的点击位置近似映射回块内原始 markdown 偏移：标记（`**`、`# `、
 * 列表符号、链接地址）不渲染，只能靠数可见字符来估。估偏一点没关系，落到
 * 点击处附近即可，绝不要退回到块首。
 */
export function renderedToRaw(raw: string, rendered: number): number {
  const target = Math.max(0, rendered)
  let shown = 0
  let i = 0
  while (i < raw.length) {
    const lineHead = i === 0 || raw[i - 1] === '\n'
      ? /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,9}[.)])\s+|- \[[ xX]\]\s+)/.exec(raw.slice(i))
      : null
    if (lineHead) {
      i += lineHead[0].length
      continue
    }
    if ('*_~`'.includes(raw[i])) {
      i += 1
      continue
    }
    // 链接文字两侧的方括号不渲染，跳过左括号、再跳过 `](地址)`
    if (raw[i] === '[' && raw.indexOf('](', i) > i) {
      i += 1
      continue
    }
    if (raw.startsWith('](', i)) {
      const close = raw.indexOf(')', i)
      i = close < 0 ? raw.length : close + 1
      continue
    }
    if (shown >= target) return i
    shown += 1
    i += 1
  }
  return raw.length
}
