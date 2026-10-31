import { useEffect, useRef, useState } from 'react'
import { Box, useTheme } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import { replaceAll } from '@milkdown/kit/utils'
import { editorViewCtx } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import { AllSelection } from '@milkdown/kit/prose/state'
import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { noteAttachmentUrl } from '@shared/noteAttachments'
import { NoteContextMenu, type NoteMenuEntry } from './NoteContextMenu'

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  noteId: string
  onAttachment: (path: string) => void
  placeholder?: string
  minHeight?: number | string
  /** Read-only while a recording is still being transcribed. */
  disabled?: boolean
  /** Switch the page to the raw markdown view (context menu → 编辑 Markdown 源码). */
  onEditSource?: () => void
}

/** Pause after the last keystroke before the parent hears about a change. */
const EMIT_MS = 220

/**
 * Typora-style writing surface for a note body.
 *
 * Milkdown parses the note's markdown on mount and serialises it back on every
 * change, so typing behaves like a document: IME, undo, nested lists, tables and
 * code blocks come from the editor instead of hand-written string surgery.
 * Markdown stays the storage format, so saving, exporting and the source view
 * keep working unchanged.
 *
 * What makes it feel like Typora rather than a web form is the part on top: a
 * markdown-aware right-click menu for text and images, and a selection toolbar
 * whose labels follow the app's UI language.
 */
export function MarkdownEditor({ value, onChange, noteId, onAttachment, placeholder = '', minHeight = '42vh', disabled = false, onEditSource }: MarkdownEditorProps): JSX.Element {
  const theme = useTheme()
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement | null>(null)
  const crepe = useRef<Crepe | null>(null)
  /** The last markdown this component either loaded or emitted. */
  const known = useRef(value)
  const timer = useRef<number | null>(null)
  /**
   * Who this editor instance speaks for. Set when the instance is created and
   * cleared when it is torn down, so a late timer/blur from the previous note can
   * never hand text to the current one: the callback and the note id travel
   * together instead of reading whatever `props` happens to hold now.
   */
  const sink = useRef<{ noteId: string; send: (markdown: string) => void } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: NoteMenuEntry[] } | null>(null)
  const props = useRef({ value, onChange, noteId, placeholder, disabled })
  props.current = { value, onChange, noteId, placeholder, disabled }

  const flush = (): void => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
    const instance = crepe.current
    const owner = sink.current
    if (!instance || !owner) return
    let markdown = ''
    // A teardown can run while `create()` is still in flight; a throw here would
    // abort the unmount and leave the editor attached.
    try { markdown = instance.getMarkdown() } catch { return }
    if (markdown === known.current) return
    known.current = markdown
    owner.send(markdown)
  }

  /** Runs a ProseMirror command on the live view. */
  const withView = (run: (view: EditorView) => void): void => {
    const instance = crepe.current
    if (!instance) return
    try {
      instance.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.focus()
        run(view)
      })
    } catch { /* the editor is being torn down with the note */ }
  }

  const selectionText = (view: EditorView): string =>
    view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n', '\n')

  const copy = (text: string): void => { if (text) void window.api.app.copyText(text) }

  const paste = (): void => {
    void window.api.app.readClipboard().then((text) => {
      if (text) withView((view) => view.dispatch(view.state.tr.insertText(text)))
    })
  }

  const openMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const image = (event.target as HTMLElement).closest('img')
    if (image) {
      let range: { from: number; to: number } | null = null
      withView((view) => {
        const pos = view.posAtDOM(image, 0)
        const node = view.state.doc.nodeAt(pos)
        if (node && node.type.name === 'image') range = { from: pos, to: pos + node.nodeSize }
      })
      const src = image.getAttribute('src') || ''
      const relative = src.startsWith('attachments/') ? src : ''
      setMenu({
        x: event.clientX,
        y: event.clientY,
        entries: [
          { id: 'image-copy-path', label: t('复制图片地址'), disabled: !relative, run: () => copy(relative) },
          { id: 'image-reveal', label: t('在文件夹中显示'), disabled: !relative, run: () => { if (relative) onAttachment(relative) } },
          { divider: true },
          { id: 'image-delete', label: t('删除图片'), disabled: !range, run: () => withView((view) => { if (range) view.dispatch(view.state.tr.delete(range.from, range.to)) }) }
        ]
      })
      return
    }
    const block = (name: string): ((view: EditorView) => void) => (view) => {
      const node = view.state.schema.nodes[name]
      if (!node) return
      setBlockType(node)(view.state, view.dispatch, view)
    }
    const heading = (level: number): ((view: EditorView) => void) => (view) => {
      const node = view.state.schema.nodes.heading
      if (!node) return
      setBlockType(node, { level })(view.state, view.dispatch, view)
    }
    const wrap = (name: string): ((view: EditorView) => void) => (view) => {
      const node = view.state.schema.nodes[name]
      if (!node) return
      wrapIn(node)(view.state, view.dispatch, view)
    }
    const mark = (name: string): ((view: EditorView) => void) => (view) => {
      const type = view.state.schema.marks[name]
      if (!type) return
      toggleMark(type)(view.state, view.dispatch, view)
    }
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { id: 'cut', label: t('剪切'), shortcut: 'Ctrl+X', run: () => withView((view) => { copy(selectionText(view)); view.dispatch(view.state.tr.deleteSelection()) }) },
        { id: 'copy', label: t('复制'), shortcut: 'Ctrl+C', run: () => withView((view) => copy(selectionText(view))) },
        { id: 'paste', label: t('粘贴'), shortcut: 'Ctrl+V', run: paste },
        { id: 'select-all', label: t('全选'), shortcut: 'Ctrl+A', run: () => withView((view) => view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))) },
        { divider: true },
        { id: 'bold', label: t('加粗'), shortcut: 'Ctrl+B', run: () => withView(mark('strong')) },
        { id: 'italic', label: t('斜体'), shortcut: 'Ctrl+I', run: () => withView(mark('em')) },
        { id: 'strike', label: t('删除线'), run: () => withView(mark('strikethrough')) },
        { id: 'code', label: t('行内代码'), shortcut: 'Ctrl+`', run: () => withView(mark('inlineCode')) },
        { divider: true },
        { id: 'h1', label: t('标题 1'), shortcut: 'Ctrl+1', run: () => withView(heading(1)) },
        { id: 'h2', label: t('标题 2'), shortcut: 'Ctrl+2', run: () => withView(heading(2)) },
        { id: 'h3', label: t('标题 3'), shortcut: 'Ctrl+3', run: () => withView(heading(3)) },
        { id: 'paragraph', label: t('正文'), shortcut: 'Ctrl+0', run: () => withView(block('paragraph')) },
        { id: 'quote', label: t('引用'), run: () => withView(wrap('blockquote')) },
        { id: 'bullet', label: t('无序列表'), run: () => withView(wrap('bullet_list')) },
        { id: 'ordered', label: t('有序列表'), run: () => withView(wrap('ordered_list')) },
        { id: 'code-block', label: t('代码块'), run: () => withView(block('code_block')) },
        { id: 'rule', label: t('分隔线'), run: () => withView((view) => {
          const rule = view.state.schema.nodes.hr
          if (rule) view.dispatch(view.state.tr.replaceSelectionWith(rule.create()))
        }) },
        { divider: true },
        { id: 'clear', label: t('清除格式'), run: () => withView((view) => {
          const paragraph = view.state.schema.nodes.paragraph
          if (paragraph) setBlockType(paragraph)(view.state, view.dispatch, view)
          const { from, to } = view.state.selection
          view.dispatch(view.state.tr.removeMark(from, to))
        }) },
        { id: 'copy-markdown', label: t('复制全文 Markdown'), run: () => copy(crepe.current?.getMarkdown() ?? '') },
        ...(onEditSource ? [{ id: 'edit-source', label: t('编辑 Markdown 源码'), run: () => { flush(); onEditSource() } }] : [])
      ]
    })
  }

  useEffect(() => {
    const root = host.current
    if (!root) return
    let disposed = false
    // Everything below is a snapshot of *this* note. Reading it back from `props`
    // later is how a teardown flush used to write note A's text into note B.
    const owner = { noteId: props.current.noteId, send: props.current.onChange }
    const noteOwner = owner.noteId
    const upload = async (file: File): Promise<string> => {
      const added = await window.api.notes.addAttachment(noteOwner, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      return added.path
    }
    // A child node per instance: the previous editor's DOM (and its ProseMirror
    // view, which owns the undo history) lives in its own subtree, so the async
    // `destroy()` can only ever clear leftovers we are throwing away, never the
    // document the user is now looking at.
    const mount = document.createElement('div')
    root.appendChild(mount)
    const instance = new Crepe({
      root: mount,
      defaultValue: props.current.value,
      features: {
        // No AI rewrite button: it would be a second, unconfigured model behind the
        // user's back. The note page owns every call this app makes.
        [Crepe.Feature.AI]: false,
        // The top bar holds a read-only toggle and a word count, both already present
        // in the note page's own chrome.
        [Crepe.Feature.TopBar]: false
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: props.current.placeholder },
        // The selection toolbar ships English labels; they must follow the UI language
        // like every other string the app shows.
        [Crepe.Feature.Toolbar]: {
          boldLabel: t('加粗'),
          italicLabel: t('斜体'),
          strikethroughLabel: t('删除线'),
          codeLabel: t('行内代码'),
          linkLabel: t('链接'),
          latexLabel: t('公式'),
          aiLabel: t('AI 改写')
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: upload,
          blockOnUpload: upload,
          inlineOnUpload: upload,
          // Stored markdown keeps note-relative paths; the renderer resolves them to
          // the note attachment scheme, the only way an `<img>` may reach a file.
          proxyDomURL: (url: string) => url.startsWith('attachments/') ? noteAttachmentUrl(noteOwner, url) : url
        }
      }
    })
    instance.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        // Only the live instance may speak: a view left over from the previous
        // note can still deliver updates while it is being torn down.
        if (disposed || crepe.current !== instance || markdown === known.current) return
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => { timer.current = null; flush() }, EMIT_MS)
      })
      listener.blur(() => { if (crepe.current === instance) flush() })
    })
    known.current = props.current.value
    sink.current = owner
    crepe.current = instance
    void instance.create().then(() => {
      if (disposed) return
      instance.setReadonly(props.current.disabled)
      // The first render after a switch can still hand us the *previous* note's
      // draft (the page resets the drafts one tick later), so the document this
      // editor was born with may be somebody else's text. Reconcile once the
      // context is ready: here `replaceAll` cannot be swallowed by a mounting
      // editor, which is what used to leave note A's body inside note B.
      const live = props.current.value
      if (live === known.current) return
      try {
        instance.editor.action(replaceAll(live))
        known.current = live
      } catch { /* the teardown already started */ }
    })
    return () => {
      // The last keystroke may still be inside the debounce window; emit it — to *this*
      // note, through the callback captured above — before the editor goes away.
      if (timer.current !== null) flush()
      disposed = true
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
      sink.current = null
      crepe.current = null
      mount.remove()
      void instance.destroy()
    }
    // One editor per note: switching notes remounts instead of reconciling two
    // documents, which is what keeps undo history honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId])

  // An outside writer (re-transcription, a fresh fetch) replaces the document.
  useEffect(() => {
    const instance = crepe.current
    if (!instance || value === known.current) return
    try {
      instance.editor.action(replaceAll(value))
      // Only remember the value once it really landed: a replace issued while
      // `create()` is still running throws, and forgetting that would leave the
      // editor showing the wrong note's text with no further correction.
      known.current = value
    } catch { /* still mounting: create() reconciles the live value when it resolves */ }
  }, [value])

  useEffect(() => {
    const instance = crepe.current
    if (!instance) return
    try { instance.setReadonly(disabled) } catch { /* created before the flag applied */ }
  }, [disabled])

  return (
    <Box
      ref={host}
      data-notes-markdown
      data-notes-editor-mode="rich"
      onContextMenu={openMenu}
      sx={{
        minHeight,
        p: 0,
        border: 0,
        cursor: disabled ? 'default' : 'text',
        opacity: disabled ? 0.8 : 1,
        // Crepe ships a warm Material palette; the app's colours come from MUI, so the
        // design tokens are re-pointed here instead of importing a second theme file.
        '--crepe-color-background': 'transparent',
        '--crepe-color-on-background': theme.palette.text.primary,
        '--crepe-color-surface': theme.palette.background.paper,
        '--crepe-color-surface-low': theme.palette.action.hover,
        '--crepe-color-on-surface': theme.palette.text.primary,
        '--crepe-color-on-surface-variant': theme.palette.text.secondary,
        '--crepe-color-outline': theme.palette.divider,
        '--crepe-color-primary': theme.palette.primary.main,
        '--crepe-color-secondary': theme.palette.action.selected,
        '--crepe-color-on-secondary': theme.palette.text.primary,
        '--crepe-color-inline-code': theme.palette.warning.main,
        '--crepe-color-error': theme.palette.error.main,
        '--crepe-color-hover': theme.palette.action.hover,
        '--crepe-color-selected': theme.palette.action.selected,
        '--crepe-color-inverse': theme.palette.background.default,
        '--crepe-color-on-inverse': theme.palette.text.primary,
        '& .milkdown': { background: 'transparent', color: 'inherit' },
        '& .milkdown .ProseMirror': {
          padding: 0,
          outline: 'none',
          minHeight,
          fontFamily: 'inherit',
          fontSize: 15,
          lineHeight: 1.85,
          color: theme.palette.text.primary,
          overflowWrap: 'anywhere'
        },
        '& .milkdown .ProseMirror > :first-child': { mt: 0 },
        '& .milkdown .ProseMirror > :last-child': { mb: 0 },
        '& .milkdown .ProseMirror h1': { fontSize: 28, lineHeight: 1.35, mt: 2.4, mb: 1 },
        '& .milkdown .ProseMirror h2': { fontSize: 23, lineHeight: 1.4, mt: 2, mb: 0.85 },
        '& .milkdown .ProseMirror h3': { fontSize: 19, lineHeight: 1.45, mt: 1.75, mb: 0.75 },
        '& .milkdown .ProseMirror h4, & .milkdown .ProseMirror h5, & .milkdown .ProseMirror h6': { fontSize: 16, lineHeight: 1.5, mt: 1.5, mb: 0.6 },
        '& .milkdown .ProseMirror p': { my: 0.85 },
        // Crepe paints list bullets with `--crepe-color-outline` (the divider colour),
        // which all but disappears on a dark page.
        '& .milkdown .milkdown-list-item-block li .label-wrapper': { color: theme.palette.text.secondary, height: 26 },
        '& .milkdown .milkdown-list-item-block li .label-wrapper svg': { fill: theme.palette.text.secondary },
        '& .milkdown .milkdown-list-item-block li': { gap: '2px' },
        // Crepe's list rows carry a 32px marker cell and a paragraph margin, which reads
        // as a gap between bullets that Typora does not have.
        '& .milkdown .ProseMirror li': { my: 0.1 },
        '& .milkdown .ProseMirror li p': { my: 0.1 },
        '& .milkdown .milkdown-list-item-block li .label-wrapper .label': { height: 26, padding: '2px 0' },
        '& .milkdown .ProseMirror ul, & .milkdown .ProseMirror ol': { paddingLeft: '0.4em' },
        '& .milkdown .ProseMirror blockquote': { ml: 0, pl: 2, borderLeft: '3px solid', borderColor: 'divider', color: theme.palette.text.secondary },
        '& .milkdown .ProseMirror code': { fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: '0.92em' },
        '& .milkdown .ProseMirror pre': { p: 1.5, borderRadius: 1, bgcolor: theme.palette.action.hover, overflowX: 'auto' },
        '& .milkdown .ProseMirror table': { borderCollapse: 'collapse', width: '100%' },
        '& .milkdown .ProseMirror th, & .milkdown .ProseMirror td': { border: '1px solid', borderColor: theme.palette.divider, p: 1, textAlign: 'left' },
        '& .milkdown .ProseMirror img': { maxWidth: '100%', height: 'auto', borderRadius: 1 },
        '& .milkdown .ProseMirror a': { color: theme.palette.primary.main },
        // The selection toolbar drew its icons with the divider colour — the "all grey,
        // looks disabled" report — so icons use the body's secondary text colour and the
        // active state keeps the accent.
        '& .milkdown .milkdown-toolbar': { zIndex: 4, bgcolor: theme.palette.background.paper, border: '1px solid', borderColor: theme.palette.divider },
        '& .milkdown .milkdown-toolbar .toolbar-item svg': { color: theme.palette.text.secondary, fill: theme.palette.text.secondary },
        '& .milkdown .milkdown-toolbar .toolbar-item:hover svg': { color: theme.palette.text.primary, fill: theme.palette.text.primary },
        '& .milkdown .milkdown-toolbar .toolbar-item.active svg': { color: theme.palette.primary.main, fill: theme.palette.primary.main },
        '& .milkdown .milkdown-block-handle': { zIndex: 4 }
      }}
    >
      <NoteContextMenu anchor={menu ? { x: menu.x, y: menu.y } : null} entries={menu?.entries ?? []} onClose={() => setMenu(null)} />
    </Box>
  )
}
