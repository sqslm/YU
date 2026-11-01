import { useEffect, useRef, useState } from 'react'
import { Box, useTheme } from '@mui/material'
import { useTranslation } from 'react-i18next'
import { Crepe } from '@milkdown/crepe'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import '@milkdown/crepe/theme/common/style.css'
import { replaceAll } from '@milkdown/kit/utils'
import { editorViewCtx } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import { AllSelection, TextSelection, type Command } from '@milkdown/kit/prose/state'
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { noteAttachmentUrl } from '@shared/noteAttachments'
import { NoteContextMenu, type NoteMenuEntry } from './NoteContextMenu'
import { guardEditorSelectionDrag } from './editorDragGuard'

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
  /** Reports a failed image action (clipboard copy, 另存为) to the page's notice line. */
  onError?: (message: string) => void
}

/** Pause after the last keystroke before the parent hears about a change. */
const EMIT_MS = 220

/** Strips Electron's `Error invoking remote method …` wrapper for a readable message. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error)
}

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
export function MarkdownEditor({ value, onChange, noteId, onAttachment, placeholder = '', minHeight = '42vh', disabled = false, onEditSource, onError }: MarkdownEditorProps): JSX.Element {
  const theme = useTheme()
  const { t } = useTranslation()
  /**
   * The CodeMirror theme handed to Crepe's code blocks.
   *
   * Crepe's own default is `@codemirror/theme-one-dark`, so on a light pack the
   * block drew a dark editor's colours on the porcelain sheet: light-grey code,
   * a charcoal active-line chip in the gutter. Light packs get the app's own
   * colours instead; dark packs keep One Dark, which already fits them. Syntax
   * colours come from CodeMirror's default highlight style that Crepe's
   * `basicSetup` installs, so this only has to own surfaces and ink.
   */
  const codeTheme = theme.palette.mode === 'dark'
    ? {}
    : {
      theme: [CodeMirrorView.theme({
        '&': { backgroundColor: 'transparent', color: theme.palette.text.primary },
        '.cm-content': { caretColor: theme.palette.primary.main, fontFamily: 'Consolas, "Cascadia Mono", monospace' },
        '.cm-gutters': { backgroundColor: 'transparent', color: theme.palette.text.disabled, border: 'none' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
        '.cm-selectionBackground, ::selection': { backgroundColor: theme.palette.action.selected }
      }, { dark: false })]
    }
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
  /**
   * The selection the menu was opened on.
   *
   * Clicking a menu item moves DOM focus to the menu, and a right-click can
   * collapse ProseMirror's selection to the click point. Both are why the
   * format commands used to do nothing visible: they ran against an empty
   * range. The range is captured when the menu opens and restored before a
   * command runs.
   */
  const menuRange = useRef<{ from: number; to: number } | null>(null)
  /** Hidden picker behind 插入 → 图像. */
  const pickImage = useRef<HTMLInputElement | null>(null)
  const props = useRef({ value, onChange, noteId, placeholder, disabled, onError })
  props.current = { value, onChange, noteId, placeholder, disabled, onError }

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

  /** Reads the live view without moving focus: a right-click must not move the caret. */
  const readView = (run: (view: EditorView) => void): void => {
    const instance = crepe.current
    if (!instance) return
    try { instance.editor.action((ctx) => run(ctx.get(editorViewCtx))) } catch { /* the editor is being torn down with the note */ }
  }

  /** Runs a ProseMirror command on the live view. */
  const withView = (run: (view: EditorView) => void): void => readView((view) => { view.focus(); run(view) })

  /**
   * The state the context menu renders against.
   *
   * `availableMarks` / `nodes` exist so an entry whose schema type is missing is
   * *disabled and visible* instead of silently doing nothing — the shape of the
   * bug that made 斜体 and 删除线 look broken. `activeMarks` drives the toggle
   * ticks, `block` / `level` / `in*` drive the heading and list submenus.
   */
  interface MenuSnapshot {
    activeMarks: Set<string>
    availableMarks: Set<string>
    nodes: Set<string>
    block: string
    level: number
    inQuote: boolean
    inBullet: boolean
    inOrdered: boolean
  }
  const menuSnapshot = (): MenuSnapshot => {
    const snap: MenuSnapshot = {
      activeMarks: new Set(), availableMarks: new Set(), nodes: new Set(),
      block: '', level: 0, inQuote: false, inBullet: false, inOrdered: false
    }
    readView((view) => {
      const { state } = view
      snap.nodes = new Set(Object.keys(state.schema.nodes))
      snap.availableMarks = new Set(Object.keys(state.schema.marks))
      const { from, to, $from } = state.selection
      for (const [name, type] of Object.entries(state.schema.marks)) {
        if (!type) continue
        const active = from !== to ? state.doc.rangeHasMark(from, to, type) : Boolean(type.isInSet($from.marks()))
        if (active) snap.activeMarks.add(name)
      }
      snap.block = $from.parent.type.name
      snap.level = Number($from.parent.attrs.level ?? 0)
      for (let depth = $from.depth; depth > 0; depth--) {
        const name = $from.node(depth).type.name
        if (name === 'blockquote') snap.inQuote = true
        if (name === 'bullet_list') snap.inBullet = true
        if (name === 'ordered_list') snap.inOrdered = true
      }
    })
    return snap
  }

  /**
   * Runs a `Command` with the dispatch it expects.
   *
   * Two bugs made every format entry in the context menu look dead:
   *  1. `command(state, view.dispatch)` passes an unbound method — ProseMirror
   *     calls it as a bare function, `this` is lost, it throws, and the throw
   *     was swallowed by `withView`'s catch. Binding it fixes 斜体/删除线/标题.
   *  2. Opening the menu collapses the selection (menu focus, right-click on a
   *     caret), so the command ran over an empty range. The range captured when
   *     the menu opened is restored first.
   */
  const apply = (command: Command): ((view: EditorView) => void) => (view) => {
    const range = menuRange.current
    if (range && range.from !== range.to) {
      const { from, to } = view.state.selection
      if (from === to) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)))
    }
    command(view.state, view.dispatch.bind(view), view)
  }

  const selectionText = (view: EditorView): string =>
    view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n', '\n')

  const copy = (text: string): void => { if (text) void window.api.app.copyText(text) }

  /** Surfaces a failed menu action on the page's notice line. */
  const fail = (message: string): void => { props.current.onError?.(message) }

  /**
   * Ctrl/Cmd+click on a link.
   *
   * A plain click has to stay inert: the note body is an editor, and letting the
   * renderer follow a link would replace the whole window. With the modifier the
   * URL goes to main, which runs the same safe-link gate as every other
   * outbound link, so `javascript:` and `file:` stay refused.
   */
  const openLink = (event: React.MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest('a[href]')
    if (!anchor) return
    event.preventDefault()
    if (!(event.ctrlKey || event.metaKey)) return
    const href = anchor.getAttribute('href') ?? ''
    if (href) void window.api.app.openExternal(href)
  }

  const paste = (): void => {
    void window.api.app.readClipboard().then((text) => {
      if (text) withView((view) => view.dispatch(view.state.tr.insertText(text)))
    })
  }

  /**
   * Uploads a picked file as a note attachment and drops an image node at the
   * caret. Same storage path the paste/drop flow uses, so the markdown keeps a
   * note-relative `attachments/…` reference.
   */
  const uploadImage = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const owner = sink.current
    if (!file || !owner) return
    try {
      const added = await window.api.notes.addAttachment(owner.noteId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      withView((view) => {
        const image = view.state.schema.nodes.image
        if (!image) return
        view.dispatch(view.state.tr.replaceSelectionWith(image.create({ src: added.path, alt: file.name })))
      })
    } catch { /* the attachment store refused; the page reports its own error */ }
  }

  const openMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    readView((view) => { menuRange.current = { from: view.state.selection.from, to: view.state.selection.to } })
    // `img` may be wrapped by Crepe's image block, and the overlay that draws the
    // caption sits on top of the picture: match the wrapper too, otherwise an
    // image right-click fell through to the text menu.
    const target = (event.target as HTMLElement).closest('img, .milkdown-image-block, .milkdown-image-inline')
    if (target) {
      /**
       * Where the image node itself lives. Crepe wraps a block image in a
       * `milkdown-image-block` node, so the picture is the wrapper's child and
       * every edit (ratio, delete) has to address that inner node. The holder
       * object keeps the value readable after `readView`'s callback returns.
       */
      const found: { at: { pos: number; from: number; to: number; attrs: Record<string, unknown> } | null } = { at: null }
      readView((view) => {
        try {
          const pos = view.posAtDOM(target, 0)
          const wrapper = view.state.doc.nodeAt(pos)
          if (wrapper?.type.name === 'image') found.at = { pos, from: pos, to: pos + wrapper.nodeSize, attrs: { ...wrapper.attrs } }
          else if (wrapper?.firstChild?.type.name === 'image') {
            found.at = { pos: pos + 1, from: pos, to: pos + wrapper.nodeSize, attrs: { ...wrapper.firstChild.attrs } }
          }
        } catch { /* the click landed between nodes */ }
      })
      const element = target instanceof HTMLImageElement ? target : target.querySelector('img')
      const src = element?.getAttribute('src') || ''
      const relative = src.startsWith('attachments/') ? src : ''
      const owner = sink.current?.noteId ?? ''
      const ratio = Number(found.at?.attrs.ratio ?? 1)
      const setRatio = (next: number): (() => void) => () => withView((view) => {
        if (!found.at) return
        const node = view.state.doc.nodeAt(found.at.pos)
        if (node?.type.name !== 'image') return
        view.dispatch(view.state.tr.setNodeMarkup(found.at.pos, undefined, { ...node.attrs, ratio: next }))
      })
      const attachment = (run: (path: string) => Promise<unknown>): (() => void) => () => {
        if (!relative || !owner) return
        void run(relative).catch((error: unknown) => fail(messageOf(error)))
      }
      setMenu({
        x: event.clientX,
        y: event.clientY,
        entries: [
          { id: 'image-copy', label: t('复制图片'), disabled: !relative, run: attachment(path => window.api.notes.copyAttachment(owner, path)) },
          { id: 'image-save-as', label: t('图片另存为'), disabled: !relative, run: attachment(path => window.api.notes.saveAttachmentAs(owner, path)) },
          { divider: true },
          {
            id: 'image-scale',
            label: t('缩放'),
            disabled: !found.at,
            children: [
              { id: 'image-scale-50', label: '50%', checked: ratio === 0.5, run: setRatio(0.5) },
              { id: 'image-scale-75', label: '75%', checked: ratio === 0.75, run: setRatio(0.75) },
              { id: 'image-scale-100', label: t('原始大小'), checked: ratio === 1, run: setRatio(1) },
              { id: 'image-scale-125', label: '125%', checked: ratio === 1.25, run: setRatio(1.25) },
              { id: 'image-scale-150', label: '150%', checked: ratio === 1.5, run: setRatio(1.5) }
            ]
          },
          { id: 'image-reveal', label: t('打开所在文件夹'), disabled: !relative, run: () => { if (relative) onAttachment(relative) } },
          { divider: true },
          { id: 'image-delete', label: t('删除图片'), disabled: !found.at, run: () => withView((view) => { if (found.at) view.dispatch(view.state.tr.delete(found.at.from, found.at.to)) }) }
        ]
      })
      return
    }
    /**
     * What the menu should show as active, and which schema names this editor
     * actually has.
     *
     * The names are Milkdown's, not ProseMirror's defaults: italics are
     * `emphasis` (not `em`) and strikethrough is `strike_through` (not
     * `strikethrough`). Looking those up by the wrong key returned `undefined`,
     * the command quietly returned `false`, and the entry did nothing — the
     * "斜体/删除线 are dead" report.
     */
    const snap = menuSnapshot()
    const has = (kind: 'mark' | 'node', name: string): boolean => (kind === 'mark' ? snap.availableMarks : snap.nodes).has(name)
    const toggleMarkEntry = (name: string): ((view: EditorView) => void) => apply((state, dispatch, view) => {
      const type = state.schema.marks[name]
      return type ? toggleMark(type)(state, dispatch, view) : false
    })
    const setHeading = (level: number): ((view: EditorView) => void) => apply((state, dispatch, view) => {
      const heading = state.schema.nodes.heading
      const paragraph = state.schema.nodes.paragraph
      if (!heading || !paragraph) return false
      const current = state.selection.$from.parent
      // Second click on the same heading level goes back to a plain paragraph.
      if (current.type === heading && current.attrs.level === level) return setBlockType(paragraph)(state, dispatch, view)
      return setBlockType(heading, { level })(state, dispatch, view)
    })
    /** Applies a block type, or lifts it again when the caret is already inside one. */
    const toggleBlock = (name: string): ((view: EditorView) => void) => apply((state, dispatch, view) => {
      const node = state.schema.nodes[name]
      const paragraph = state.schema.nodes.paragraph
      if (!node || !paragraph) return false
      const { $from } = state.selection
      let inside = false
      for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === name) inside = true
      if (inside) {
        // A code block has no wrapper to lift out of; it turns back into prose.
        return name === 'code_block' ? setBlockType(paragraph)(state, dispatch, view) : lift(state, dispatch, view)
      }
      // Textblocks (code_block) replace the current block; containers wrap it.
      return node.isTextblock ? setBlockType(node)(state, dispatch, view) : wrapIn(node)(state, dispatch, view)
    })
    const toggleParagraph = (): ((view: EditorView) => void) => apply((state, dispatch, view) => {
      const paragraph = state.schema.nodes.paragraph
      if (!paragraph) return false
      // Already plain prose: nothing to change, but keep the entry honest.
      if (state.selection.$from.parent.type === paragraph) return false
      return setBlockType(paragraph)(state, dispatch, view)
    })
    const headingOn = (level: number): boolean => snap.block === 'heading' && snap.level === level

    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { id: 'cut', label: t('剪切'), shortcut: 'Ctrl+X', run: () => withView((view) => { copy(selectionText(view)); view.dispatch(view.state.tr.deleteSelection()) }) },
        { id: 'copy', label: t('复制'), shortcut: 'Ctrl+C', run: () => withView((view) => copy(selectionText(view))) },
        { id: 'paste', label: t('粘贴'), shortcut: 'Ctrl+V', run: paste },
        { id: 'select-all', label: t('全选'), shortcut: 'Ctrl+A', run: () => withView((view) => view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))) },
        { divider: true },
        { id: 'bold', label: t('加粗'), shortcut: 'Ctrl+B', disabled: !has('mark', 'strong'), checked: snap.activeMarks.has('strong'), run: () => withView(toggleMarkEntry('strong')) },
        { id: 'italic', label: t('斜体'), shortcut: 'Ctrl+I', disabled: !has('mark', 'emphasis'), checked: snap.activeMarks.has('emphasis'), run: () => withView(toggleMarkEntry('emphasis')) },
        { id: 'strike', label: t('删除线'), disabled: !has('mark', 'strike_through'), checked: snap.activeMarks.has('strike_through'), run: () => withView(toggleMarkEntry('strike_through')) },
        { id: 'code', label: t('行内代码'), shortcut: 'Ctrl+`', disabled: !has('mark', 'inlineCode'), checked: snap.activeMarks.has('inlineCode'), run: () => withView(toggleMarkEntry('inlineCode')) },
        { id: 'clear', label: t('清除格式'), run: () => withView((view) => {
          const paragraph = view.state.schema.nodes.paragraph
          if (paragraph) apply(setBlockType(paragraph))(view)
          // The range the menu was opened on, not the (possibly collapsed) one
          // the click left behind.
          const range = menuRange.current ?? view.state.selection
          view.dispatch(view.state.tr.removeMark(range.from, range.to))
        }) },
        { divider: true },
        {
          id: 'heading',
          label: t('标题'),
          children: [
            ...[1, 2, 3, 4, 5, 6].map(level => ({
              id: `h${level}`,
              label: t(['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'][level - 1]!),
              // Milkdown only binds Ctrl+1…6 in its own keymap; the first three
              // are advertised here because those are the ones the app documents.
              ...(level <= 3 ? { shortcut: `Ctrl+${level}` } : {}),
              disabled: !has('node', 'heading'),
              checked: headingOn(level),
              run: () => withView(setHeading(level))
            })),
            { divider: true },
            { id: 'paragraph', label: t('段落'), shortcut: 'Ctrl+0', disabled: !has('node', 'paragraph'), checked: snap.block === 'paragraph', run: () => withView(toggleParagraph()) }
          ]
        },
        {
          id: 'blocks',
          label: t('列表与块'),
          children: [
            { id: 'bullet', label: t('无序列表'), disabled: !has('node', 'bullet_list'), checked: snap.inBullet, run: () => withView(toggleBlock('bullet_list')) },
            { id: 'ordered', label: t('有序列表'), disabled: !has('node', 'ordered_list'), checked: snap.inOrdered, run: () => withView(toggleBlock('ordered_list')) },
            { id: 'quote', label: t('引用'), disabled: !has('node', 'blockquote'), checked: snap.inQuote, run: () => withView(toggleBlock('blockquote')) },
            { id: 'code-block', label: t('代码块'), disabled: !has('node', 'code_block'), checked: snap.block === 'code_block', run: () => withView(toggleBlock('code_block')) }
          ]
        },
        {
          id: 'insert',
          label: t('插入'),
          children: [
            { id: 'insert-image', label: t('图像'), disabled: !has('node', 'image'), run: () => pickImage.current?.click() },
            { id: 'insert-rule', label: t('水平分割线'), disabled: !has('node', 'hr'), run: () => withView((view) => {
              const rule = view.state.schema.nodes.hr
              if (rule) view.dispatch(view.state.tr.replaceSelectionWith(rule.create()))
            }) }
          ]
        },
        { divider: true },
        { id: 'copy-markdown', label: t('复制全文 Markdown'), run: () => copy(crepe.current?.getMarkdown() ?? '') },
        ...(onEditSource ? [{ id: 'edit-source' as const, label: t('编辑 Markdown 源码'), run: () => { flush(); onEditSource() } }] : [])
      ]
    })
  }

  useEffect(() => {
    const root = host.current
    if (!root) return
    // Pressing inside an existing selection must extend it, not drag it: without
    // this the browser starts an HTML5 drag of the selected text, ProseMirror
    // treats the drop as a move, and the paragraph splits in two under the
    // cursor ("选中文字会突然跳一下" / "重新选字时把整段字拖走了").
    const releaseDragGuard = guardEditorSelectionDrag(root, () => {
      try { return crepe.current?.editor.action(ctx => ctx.get(editorViewCtx)) ?? null } catch { return null }
    })
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
        },
        // Crepe hard-wires One Dark into its code blocks, so a light note got a
        // dark editor's light-grey text on porcelain plus a charcoal
        // active-line chip — the "代码块显示异常" report. Light packs get a
        // CodeMirror theme built from the same palette; dark packs keep One
        // Dark, which is already the right palette there.
        [Crepe.Feature.CodeMirror]: codeTheme
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
      releaseDragGuard()
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
      onClick={openLink}
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
        // `minHeight` on the wrapper too: the editor's own box is the drop target
        // for a dragged block, so the empty area under the last line has to belong
        // to the editor instead of to the card behind it.
        '& .milkdown': { background: 'transparent', color: 'inherit', minHeight },
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
        // Crepe's code block is `--crepe-color-surface` (the page's own paper), so on
        // the porcelain sheet the block read as an empty white band with a stray dark
        // line-number chip. Tint it, outline it, and paint the CodeMirror gutters with
        // the same tokens as the rest of the app.
        '& .milkdown .milkdown-code-block': {
          bgcolor: theme.palette.action.hover,
          border: '1px solid',
          borderColor: theme.palette.divider,
          borderRadius: '8px',
          px: 1.5,
          pt: 0.75,
          pb: 1,
          my: 1
        },
        '& .milkdown .milkdown-code-block .cm-editor, & .milkdown .milkdown-code-block .cm-gutters': { bgcolor: 'transparent' },
        '& .milkdown .milkdown-code-block .cm-activeLine, & .milkdown .milkdown-code-block .cm-activeLineGutter': { bgcolor: 'transparent' },
        '& .milkdown .milkdown-code-block .cm-gutterElement': { color: theme.palette.text.disabled },
        // Crepe fades the language chip out until hover, which leaves the block's
        // whole first row blank on screen. Keep it visible: it names the language
        // and is the only way to change it.
        '& .milkdown .milkdown-code-block .tools .language-button': { color: theme.palette.text.secondary, opacity: 1 },
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
        // The handle is drawn in the gutter the note page reserves for it. Crepe
        // paints its two icons with `--crepe-color-outline`, i.e. the 11 %-ink
        // divider, so the ＋ and the grip all but vanished on the porcelain field
        // ("太淡了"). Icons now use the secondary text colour with a themed hover
        // pad, so every pack — 青瓷, 苹果风, 粗野 — gets a handle you can see and
        // aim at, and only the opacity animates: transitioning `all` made the
        // handle slide in from its previous spot the first time it appeared.
        '& .milkdown .milkdown-block-handle': { zIndex: 4, gap: '2px', transition: 'opacity .15s ease' },
        // The handle is drawn outside the block it belongs to; 26 px items plus
        // the gutter NotesPage reserves for it keep it inside the pane instead
        // of being clipped in half.
        '& .milkdown .milkdown-block-handle .operation-item': {
          width: 26,
          height: 26,
          padding: '3px',
          borderRadius: '6px',
          transition: 'background-color .15s ease'
        },
        '& .milkdown .milkdown-block-handle .operation-item svg': {
          width: 18,
          height: 18,
          fill: theme.palette.text.secondary,
          color: theme.palette.text.secondary
        },
        '& .milkdown .milkdown-block-handle .operation-item:hover': { bgcolor: theme.palette.action.hover },
        '& .milkdown .milkdown-block-handle .operation-item:hover svg': {
          fill: theme.palette.text.primary,
          color: theme.palette.text.primary
        },
        '& .milkdown .milkdown-block-handle .operation-item.active': { bgcolor: theme.palette.action.selected }
      }}
    >
      <NoteContextMenu anchor={menu ? { x: menu.x, y: menu.y } : null} entries={menu?.entries ?? []} onClose={() => setMenu(null)} />
      <input ref={pickImage} type="file" accept="image/*" hidden data-notes-pick-image onChange={event => void uploadImage(event)} aria-hidden tabIndex={-1} />
    </Box>
  )
}
