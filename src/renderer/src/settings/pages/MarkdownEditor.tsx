import { useEffect, useRef } from 'react'
import { Box, useTheme } from '@mui/material'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import { replaceAll } from '@milkdown/kit/utils'
import { noteAttachmentUrl } from '@shared/noteAttachments'

export interface MarkdownEditorProps {
  value: string
  onChange: (next: string) => void
  noteId: string
  onAttachment: (path: string) => void
  placeholder?: string
  minHeight?: number | string
  /** Read-only while a recording is still being transcribed. */
  disabled?: boolean
}

/** Pause after the last keystroke before the parent hears about a change. */
const EMIT_MS = 220

/**
 * Typora-style writing surface for a note body.
 *
 * The hand-rolled block editor this replaces looked like Typora but behaved like a
 * form: every paragraph was its own textarea, Enter split strings instead of
 * paragraphs, and a whole list lived in one field. Milkdown (ProseMirror + remark)
 * is a real rich-text markdown editor: markdown is parsed on mount and serialised
 * back on every change, so typing behaves like a document — selections, IME,
 * undo/redo, nested lists, tables, code blocks and images come from the editor
 * instead of hand-written string surgery.
 *
 * Markdown stays the storage format: `onChange` receives serialised markdown, so
 * saving, exporting, syncing and the source view keep working unchanged.
 */
export function MarkdownEditor({ value, onChange, noteId, onAttachment, placeholder = '', minHeight = '42vh', disabled = false }: MarkdownEditorProps): JSX.Element {
  const theme = useTheme()
  const host = useRef<HTMLDivElement | null>(null)
  const crepe = useRef<Crepe | null>(null)
  /** The last markdown this component either loaded or emitted. */
  const known = useRef(value)
  const timer = useRef<number | null>(null)
  const props = useRef({ value, onChange, noteId, placeholder, disabled })
  props.current = { value, onChange, noteId, placeholder, disabled }

  const flush = (): void => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
    const instance = crepe.current
    if (!instance) return
    const markdown = instance.getMarkdown()
    if (markdown === known.current) return
    known.current = markdown
    props.current.onChange(markdown)
  }

  useEffect(() => {
    const root = host.current
    if (!root) return
    let disposed = false
    const upload = async (file: File): Promise<string> => {
      const added = await window.api.notes.addAttachment(props.current.noteId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      return added.path
    }
    const instance = new Crepe({
      root,
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
        [Crepe.Feature.ImageBlock]: {
          onUpload: upload,
          blockOnUpload: upload,
          inlineOnUpload: upload,
          // Stored markdown keeps note-relative paths; the renderer resolves them to
          // the note attachment scheme, the only way an `<img>` may reach a file.
          proxyDomURL: (url: string) => url.startsWith('attachments/') ? noteAttachmentUrl(props.current.noteId, url) : url
        }
      }
    })
    instance.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (disposed || markdown === known.current) return
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => { timer.current = null; flush() }, EMIT_MS)
      })
      listener.blur(() => flush())
    })
    crepe.current = instance
    void instance.create().then(() => { if (!disposed) instance.setReadonly(props.current.disabled) })
    return () => {
      // The last keystroke may still be inside the debounce window; emit it before the
      // editor goes away, otherwise switching notes silently drops those characters.
      if (timer.current !== null) flush()
      disposed = true
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
      crepe.current = null
      void instance.destroy()
    }
    // One editor per note: switching notes remounts instead of reconciling two
    // documents, which is what keeps undo history honest.
  }, [noteId])

  // An outside writer (re-transcription, a fresh fetch) replaces the document.
  useEffect(() => {
    const instance = crepe.current
    if (!instance || value === known.current) return
    known.current = value
    try { instance.editor.action(replaceAll(value)) } catch { /* still mounting: it starts from this value */ }
  }, [value])

  useEffect(() => {
    const instance = crepe.current
    if (!instance) return
    try { instance.setReadonly(disabled) } catch { /* created before the flag applied */ }
  }, [disabled])

  // `onAttachment` stays part of the contract: the page uses it for its own
  // attachment button, and image links inside the note are opened by the browser.
  void onAttachment

  return (
    <Box
      ref={host}
      data-notes-markdown
      data-notes-editor-mode="rich"
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
        // which all but disappears on a dark page. Text-secondary keeps markers legible
        // without making them loud.
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
        // The floating toolbar and block handle must not paint over the page chrome.
        '& .milkdown .milkdown-toolbar': { zIndex: 4 },
        '& .milkdown .milkdown-block-handle': { zIndex: 4 }
      }}
    />
  )
}
