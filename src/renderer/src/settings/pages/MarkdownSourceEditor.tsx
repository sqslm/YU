import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Box, useTheme } from '@mui/material'
import { EditorSelection, EditorState, Compartment } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'

export interface MarkdownSourceHandle {
  focus(): void
  selection(): { from: number; to: number } | null
  /** Replaces the current selection (used by the attachment button). */
  insert(text: string): void
}

export interface MarkdownSourceEditorProps {
  value: string
  onChange: (next: string) => void
  /** `polished` / `transcript`: keeps the DOM contract the page and tests rely on. */
  field: string
  disabled?: boolean
  minHeight?: number | string
  placeholder?: string
}

/** Trim a leading marker off one line, returning the lines it should become. */
function withPrefix(view: EditorView, prefix: (line: string, index: number) => string): void {
  const { state } = view
  const range = state.selection.main
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(range.to)
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (let number = first.number; number <= last.number; number += 1) {
    const line = state.doc.line(number)
    const next = prefix(line.text, number - first.number)
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }
  if (!changes.length) return
  view.dispatch({ changes, selection: EditorSelection.cursor(changes[changes.length - 1].from + changes[changes.length - 1].insert.length) })
  view.focus()
}

/** Wrap the selection in `marker` (or insert a pair with the caret inside). */
function wrap(view: EditorView, marker: string, placeholder = '文字'): void {
  const { state } = view
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to)
  const body = selected || placeholder
  const text = `${marker}${body}${marker}`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: selected
      ? EditorSelection.cursor(range.from + text.length)
      : EditorSelection.range(range.from + marker.length, range.from + marker.length + body.length)
  })
  view.focus()
}

/** `[text](url)` with the caret parked inside the parentheses. */
function link(view: EditorView): void {
  const { state } = view
  const range = state.selection.main
  const selected = state.sliceDoc(range.from, range.to) || '文字'
  const text = `[${selected}](url)`
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + selected.length + 3)
  })
  view.focus()
}

/**
 * Enter inside a list or quote continues the marker, exactly like Typora: the
 * next bullet appears without typing it, ordered lists count up, and pressing
 * Enter on an empty item ends the list instead of leaving a stray dash.
 */
function continueList(view: EditorView): boolean {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.from)
  if (range.from !== line.to) return false
  const bullet = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line.text)
  if (bullet) {
    const [, indent, symbol, number, delimiter, , task] = bullet
    const empty = line.text.slice(bullet[0].length).trim() === ''
    if (empty) {
      // Second Enter on an empty item closes the list.
      view.dispatch({ changes: { from: line.from, to: line.to, insert: indent }, selection: EditorSelection.cursor(line.from + indent.length) })
      return true
    }
    const marker = symbol ?? `${Number(number) + 1}${delimiter}`
    const box = task ? '[ ] ' : ''
    const insert = `\n${indent}${marker} ${box}`
    view.dispatch({ changes: { from: range.from, insert }, selection: EditorSelection.cursor(range.from + insert.length) })
    return true
  }
  const quote = /^(\s*(?:>\s?)+)/.exec(line.text)
  if (quote && line.text.slice(quote[1].length).trim() !== '') {
    const insert = `\n${quote[1]}`
    view.dispatch({ changes: { from: range.from, insert }, selection: EditorSelection.cursor(range.from + insert.length) })
    return true
  }
  return false
}

/** Ctrl/Cmd+1..6 sets a heading, Ctrl/Cmd+0 turns it back into a paragraph. */
function heading(view: EditorView, level: number): void {
  withPrefix(view, (line) => line.replace(/^\s*#{1,6}\s+/, level === 0 ? '' : `${'#'.repeat(level)} `))
}

/**
 * Markdown source editor used by the 随记 「Markdown 源码」 view.
 *
 * A textarea with a couple of key handlers was the wrong tool: no undo grouping,
 * no syntax colouring, and every formatting shortcut had to be re-implemented per
 * key. CodeMirror 6 supplies the editing model (IME, multi-cursor, history,
 * indentation) and this file only adds Typora's markdown habits on top.
 */
export const MarkdownSourceEditor = forwardRef<MarkdownSourceHandle, MarkdownSourceEditorProps>(function MarkdownSourceEditor(
  { value, onChange, field, disabled = false, minHeight = '42vh', placeholder = '' },
  ref
) {
  const theme = useTheme()
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const readonly = useRef(new Compartment())
  const known = useRef(value)
  const props = useRef({ value, onChange, disabled, placeholder })
  props.current = { value, onChange, disabled, placeholder }

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    selection: () => {
      const current = view.current
      if (!current) return null
      const range = current.state.selection.main
      return { from: range.from, to: range.to }
    },
    insert: (text: string) => {
      const current = view.current
      if (!current) return
      current.dispatch(current.state.replaceSelection(text))
      current.focus()
    }
  }), [])

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const state = EditorState.create({
      doc: props.current.value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        cmPlaceholder(props.current.placeholder),
        readonly.current.of(EditorState.readOnly.of(props.current.disabled)),
        EditorView.theme({
          // `inherit` picked up the dialog's secondary text colour and made the whole
          // document look disabled; the theme's own text colour is what a source view wants.
          '&': { backgroundColor: 'transparent', color: theme.palette.text.primary, fontSize: '14px' },
          '.cm-content': { fontFamily: 'Consolas, "Cascadia Mono", monospace', padding: '0', color: theme.palette.text.primary, caretColor: theme.palette.primary.main },
          '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.8' },
          '.cm-line': { padding: '0' },
          '&.cm-focused': { outline: 'none' },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: theme.palette.primary.main },
          '.cm-activeLine': { backgroundColor: 'transparent' },
          '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(127,150,255,.28) !important' }
        }),
        keymap.of([
          { key: 'Enter', run: continueList },
          indentWithTab,
          { key: 'Mod-b', run: (v) => { wrap(v, '**'); return true } },
          { key: 'Mod-i', run: (v) => { wrap(v, '*'); return true } },
          { key: 'Mod-k', run: (v) => { link(v); return true } },
          { key: 'Mod-`', run: (v) => { wrap(v, '`'); return true } },
          { key: 'Mod-1', run: (v) => { heading(v, 1); return true } },
          { key: 'Mod-2', run: (v) => { heading(v, 2); return true } },
          { key: 'Mod-3', run: (v) => { heading(v, 3); return true } },
          { key: 'Mod-4', run: (v) => { heading(v, 4); return true } },
          { key: 'Mod-5', run: (v) => { heading(v, 5); return true } },
          { key: 'Mod-6', run: (v) => { heading(v, 6); return true } },
          { key: 'Mod-0', run: (v) => { heading(v, 0); return true } },
          { key: 'Mod-Shift-7', run: (v) => { withPrefix(v, (line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '1. ')); return true } },
          { key: 'Mod-Shift-8', run: (v) => { withPrefix(v, (line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '- ')); return true } },
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          const next = update.state.doc.toString()
          if (next === known.current) return
          known.current = next
          props.current.onChange(next)
        })
      ]
    })
    const instance = new EditorView({ state, parent })
    view.current = instance
    return () => { view.current = null; instance.destroy() }
  }, [field])

  // An outside writer (re-transcription, a fresh fetch) replaces the document.
  useEffect(() => {
    const current = view.current
    if (!current || value === known.current) return
    known.current = value
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: readonly.current.reconfigure(EditorState.readOnly.of(disabled)) })
  }, [disabled])

  return <Box
    ref={host}
    data-notes-editor={field}
    data-notes-editor-mode="source"
    sx={{ minHeight, border: 1, borderColor: 'divider', borderRadius: 1, p: 2, bgcolor: 'transparent', '& .cm-editor': { minHeight, maxHeight: 'none' }, '& .cm-scroller': { overflow: 'visible' }, '& .cm-placeholder': { color: theme.palette.text.disabled } }}
  />
})
