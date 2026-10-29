import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box } from '@mui/material'
import { isSafeLink } from '@shared/links'
import { decodeAttachmentTarget, noteAttachmentUrl } from '@shared/noteAttachments'

/**
 * 随记正文的 markdown 排版。抽出来共用：只读预览（NoteMarkdown）和块级编辑器
 * （MarkdownEditor）要给出一模一样的字体/间距，否则点进编辑时文字会跳一下。
 */
export const noteMarkdownSx = {
  fontSize: 14,
  lineHeight: 1.8,
  overflowWrap: 'anywhere',
  '& > :first-child': { mt: 0 },
  '& > :last-child': { mb: 0 },
  '& h1, & h2, & h3, & h4, & h5, & h6': { lineHeight: 1.4, mt: 2, mb: 1 },
  '& h1': { fontSize: 26 },
  '& h2': { fontSize: 22 },
  '& h3': { fontSize: 18 },
  '& p': { my: 1 },
  '& blockquote': { ml: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
  '& pre': { p: 1.5, bgcolor: 'action.hover', overflowX: 'auto', borderRadius: 1 },
  '& code': { fontFamily: 'Consolas, monospace', fontSize: '.92em' },
  '& :not(pre) > code': { px: 0.5, bgcolor: 'action.hover', borderRadius: 0.5 },
  '& table': { borderCollapse: 'collapse', width: '100%' },
  '& th, & td': { border: 1, borderColor: 'divider', p: 1, textAlign: 'left' },
  '& img': { maxWidth: '100%', height: 'auto', borderRadius: 1 },
  '& a': { color: 'primary.main' },
  '& .contains-task-list': { listStyle: 'none', pl: 1 },
  '& li > p': { my: 0.5 }
}

/** CommonMark + GFM。Raw HTML and executable/local-file URLs remain inert. */
export function NoteMarkdownBody({ text, noteId, onAttachment }: { text: string; noteId: string; onAttachment: (path: string) => void }): JSX.Element {
  return <Markdown remarkPlugins={[remarkGfm]} urlTransform={url => url.startsWith('attachments/') || url.startsWith('#') || isSafeLink(url) ? url : ''}
    components={{
      img: ({ src, alt, title }) => src?.startsWith('attachments/')
        ? <img src={noteAttachmentUrl(noteId, src)} alt={alt || ''} title={title} loading="lazy" />
        : src && /^https?:/i.test(src) ? <img src={src} alt={alt || ''} title={title} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt}</span>,
      a: ({ href, children, title }) => href?.startsWith('attachments/')
        ? <a href={noteAttachmentUrl(noteId, href)} title={title} onClick={event => { event.preventDefault(); onAttachment(decodeAttachmentTarget(href)) }}>{children}</a>
        : <a href={href || undefined} title={title} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>,
      table: ({ children }) => <Box sx={{ overflowX: 'auto', my: 1 }}><table>{children}</table></Box>
    }}>{text}</Markdown>
}

export function NoteMarkdown({ text, noteId, onAttachment }: { text: string; noteId: string; onAttachment: (path: string) => void }): JSX.Element {
  return <Box data-notes-markdown sx={{ ...noteMarkdownSx, minHeight: '42vh', p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
    <NoteMarkdownBody text={text} noteId={noteId} onAttachment={onAttachment} />
  </Box>
}
