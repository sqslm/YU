import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { NoteMarkdownBody, noteMarkdownSx } from './NoteMarkdown'
import {
  editorBlocks,
  insertAt,
  linkInline,
  mergeWithPrevious,
  prefixLines,
  renderedToRaw,
  replaceBlock,
  splitBlockAt,
  wrapInline,
  type MarkdownBlock,
  type MarkdownEdit
} from './markdownBlocks'

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  noteId: string
  onAttachment: (path: string) => void
  placeholder?: string
  minHeight?: number | string
  /** 只读（例如录音笔记只能看）：渲染照旧，点不进编辑。 */
  disabled?: boolean
}

/** 正在原地编辑的那一块；`draft` 是这一块的原始 markdown。 */
interface Editing {
  start: number
  /** 开始编辑时的块内容：外部把它改掉了就放弃草稿，别写回旧内容。 */
  base: string
  draft: string
  /** 待恢复的光标（块内坐标）；程序化改动后用它把插入点放对。 */
  caret: number | null
}

/**
 * 把「渲染后」的点击位置换回可见字符下标。Chromium 有 caretRangeFromPoint，
 * 拿不到时返回 null（调用方退回块尾，绝不退回块首）。
 */
function caretFromPoint(el: HTMLElement, x: number, y: number): number | null {
  const doc = el.ownerDocument
  const pick = (doc as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint
  const range = pick?.call(doc, x, y)
  if (!range || !el.contains(range.startContainer)) return null
  const before = doc.createRange()
  before.selectNodeContents(el)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

/**
 * 块级即时渲染的 markdown 编辑器。
 *
 * 平时每个块都用 react-markdown 渲染成排版好的样子（和 NoteMarkdown 同一套
 * 样式）；点哪一块，哪一块就变回 textarea 显示它自己的原始 markdown，失焦即
 * 提交。所有改动都通过 `onChange(整篇文本)` 回传，保存去抖仍由 NotesPage 负责。
 */
export function MarkdownEditor({ value, onChange, noteId, onAttachment, placeholder, minHeight = '42vh', disabled = false }: MarkdownEditorProps): JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<Editing | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  // 换笔记立刻丢掉编辑态（渲染期改状态，避免旧草稿多活一帧后落到新笔记上）
  const noteRef = useRef(noteId)
  if (noteRef.current !== noteId) {
    noteRef.current = noteId
    if (editing) setEditing(null)
  }

  // 把正在编辑的草稿贴回整篇文本：其它块的偏移、以及提交给父级的文本都按它算
  const live = useMemo(() => {
    if (!editing) return value
    const block = editorBlocks(value).find(item => item.start === editing.start)
      ?? { start: editing.start, end: Math.min(value.length, editing.start), text: '' }
    return replaceBlock(value, block, editing.draft)
  }, [value, editing])
  const liveRef = useRef(live)
  liveRef.current = live
  const blocks = useMemo(() => editorBlocks(live), [live])

  // 外部（重新加载、切换来源）改掉了这一块：丢弃本地草稿，不让旧内容写回去
  const external = useRef(value)
  if (external.current !== value) {
    external.current = value
    if (editing) {
      const block = editorBlocks(value).find(item => item.start === editing.start)
      if (!block || block.text !== editing.base) setEditing(null)
    }
  }

  const commit = useCallback((next?: string): void => {
    const text = next ?? liveRef.current
    if (text !== valueRef.current) onChange(text)
  }, [onChange])

  // textarea 高度随内容长（不出现内部滚动条），顺手恢复程序化改动后的光标
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (editing?.caret != null) {
      el.focus()
      el.setSelectionRange(editing.caret, editing.caret)
      setEditing(current => (current ? { ...current, caret: null } : current))
    }
  })

  const startEdit = (block: MarkdownBlock, caret: number | null): void => {
    if (disabled) return
    const at = caret == null ? block.text.length : Math.max(0, Math.min(caret, block.text.length))
    setEditing({ start: block.start, base: block.text, draft: block.text, caret: at })
  }

  const onBlockClick = (block: MarkdownBlock, event: React.MouseEvent<HTMLDivElement>): void => {
    if (disabled) return
    if ((event.target as HTMLElement).closest('a')) return
    const shown = caretFromPoint(event.currentTarget, event.clientX, event.clientY)
    startEdit(block, shown == null ? null : renderedToRaw(block.text, shown))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!editing) return
    // 输入法组字中的回车/Esc 属于输入法，别抢
    if (event.nativeEvent.isComposing) return
    const el = event.currentTarget
    const from = el.selectionStart
    const to = el.selectionEnd
    const draft = editing.draft
    const mod = event.ctrlKey || event.metaKey
    // 块内改动：只动草稿，等失焦/退出时一次性提交
    const local = (next: MarkdownEdit): void => {
      event.preventDefault()
      setEditing(current => (current ? { ...current, draft: next.text, caret: next.caret } : current))
    }
    // 整篇改动（拆块/并块）：立即提交，光标进到落点所在的新块
    const settle = (next: MarkdownEdit): void => {
      event.preventDefault()
      commit(next.text)
      const list = editorBlocks(next.text)
      const target = [...list].reverse().find(item => next.caret >= item.start && next.caret <= item.end) ?? list[list.length - 1]
      if (!target) {
        setEditing(null)
        return
      }
      setEditing({ start: target.start, base: target.text, draft: target.text, caret: next.caret - target.start })
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      commit()
      setEditing(null)
      return
    }
    if (event.key === 'Enter' && event.shiftKey) return local(insertAt(draft, from, '\n'))
    if (event.key === 'Enter' && !mod && !event.altKey) {
      // 段落回车拆块；列表/引用/代码块续上前缀，仍保持一块
      return settle(splitBlockAt(liveRef.current, { start: editing.start, end: editing.start + draft.length, text: draft }, editing.start + from))
    }
    if (event.key === 'Tab') return local(insertAt(draft, from, '  '))
    if (event.key === 'Backspace' && from === 0 && to === 0) {
      const list = editorBlocks(liveRef.current)
      const index = list.findIndex(item => item.start === editing.start)
      const merged = index > 0 ? mergeWithPrevious(liveRef.current, list, index) : null
      if (merged) return settle(merged)
      return
    }
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 'b') return local(wrapInline(draft, from, to, '**'))
    if (key === 'i') return local(wrapInline(draft, from, to, '*'))
    if (key === 'k') return local(linkInline(draft, from, to))
    if (event.key === '`') return local(wrapInline(draft, from, to, '`'))
    if (event.shiftKey && (event.key === '7' || event.key === '&')) return local(prefixLines(draft, from, to, 'ordered'))
    if (event.shiftKey && (event.key === '8' || event.key === '*')) return local(prefixLines(draft, from, to, 'unordered'))
  }

  const empty = !editing && blocks.length === 1 && blocks[0].text.trim() === ''
  return <Box data-notes-markdown data-notes-blocks={blocks.length}
    sx={{ ...noteMarkdownSx, minHeight, p: 2, border: 1, borderColor: 'divider', borderRadius: 1, cursor: disabled ? 'default' : 'text', opacity: disabled ? .8 : 1 }}>
    {empty && <Typography data-notes-editor-placeholder onClick={() => startEdit(blocks[0], 0)}
      sx={{ color: 'text.disabled', fontSize: 14, lineHeight: 1.8, cursor: disabled ? 'default' : 'text' }}>{placeholder ?? ''}</Typography>}
    {!empty && blocks.map(block => block.start === editing?.start
      ? <Box key={`edit-${block.start}`} data-notes-block-editor={block.start} sx={{ my: .5 }}>
        <Box component="textarea" ref={areaRef} value={editing.draft} data-notes-block-field={block.start}
          aria-label={t('编辑这一块')} spellCheck={false}
          onChange={event => setEditing(current => (current ? { ...current, draft: event.target.value, caret: null } : current))}
          onKeyDown={onKeyDown}
          onBlur={() => { commit(); setEditing(null) }}
          sx={{ display: 'block', width: '100%', boxSizing: 'border-box', m: 0, p: 0, border: 0, outline: 0, bgcolor: 'transparent', color: 'inherit',
            font: 'inherit', fontSize: 14, lineHeight: 1.8, resize: 'none', overflow: 'hidden', whiteSpace: 'pre-wrap' }} />
      </Box>
      : <Box key={block.start} data-notes-block={block.start} role="button" tabIndex={disabled ? -1 : 0}
        aria-label={t('编辑这一块')}
        onClick={event => onBlockClick(block, event)}
        onKeyDown={event => { if (event.key === 'Enter' && !disabled) { event.preventDefault(); startEdit(block, block.text.length) } }}
        sx={{ my: .5, borderRadius: .5, cursor: disabled ? 'default' : 'text',
          '&:hover': { bgcolor: disabled ? 'transparent' : 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', bgcolor: 'action.hover' },
          ...(block.text.trim() === '' ? { minHeight: '1.8em' } : {}) }}>
        {block.text.trim() !== '' && <NoteMarkdownBody text={block.text} noteId={noteId} onAttachment={onAttachment} />}
      </Box>)}
  </Box>
}
