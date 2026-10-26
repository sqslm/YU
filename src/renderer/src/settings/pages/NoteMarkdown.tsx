import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Box } from '@mui/material'
import { isSafeLink } from '@shared/links'
import { decodeAttachmentTarget, noteAttachmentUrl } from '@shared/noteAttachments'

/** CommonMark + GFM. Raw HTML and executable/local-file URLs remain inert. */
export function NoteMarkdown({ text, noteId, onAttachment }: { text: string; noteId: string; onAttachment: (path: string) => void }): JSX.Element {
  return <Box data-notes-markdown sx={{ fontSize: 14, lineHeight: 1.8, overflowWrap: 'anywhere', minHeight: '42vh', p: 2, border: 1, borderColor: 'divider', borderRadius: 1,
    '& > :first-child': { mt: 0 }, '& > :last-child': { mb: 0 }, '& h1, & h2, & h3, & h4, & h5, & h6': { lineHeight: 1.4, mt: 2, mb: 1 },
    '& h1': { fontSize: 26 }, '& h2': { fontSize: 22 }, '& h3': { fontSize: 18 }, '& p': { my: 1 }, '& blockquote': { ml: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
    '& pre': { p: 1.5, bgcolor: 'action.hover', overflowX: 'auto', borderRadius: 1 }, '& code': { fontFamily: 'Consolas, monospace', fontSize: '.92em' },
    '& :not(pre) > code': { px: .5, bgcolor: 'action.hover', borderRadius: .5 }, '& table': { borderCollapse: 'collapse', width: '100%' }, '& th, & td': { border: 1, borderColor: 'divider', p: 1, textAlign: 'left' },
    '& img': { maxWidth: '100%', height: 'auto', borderRadius: 1 }, '& a': { color: 'primary.main' }, '& .contains-task-list': { listStyle: 'none', pl: 1 }, '& li > p': { my: .5 }
  }}>
    <Markdown remarkPlugins={[remarkGfm]} urlTransform={url => url.startsWith('attachments/') || url.startsWith('#') || isSafeLink(url) ? url : ''}
      components={{
        img: ({ src, alt, title }) => src?.startsWith('attachments/')
          ? <img src={noteAttachmentUrl(noteId, src)} alt={alt || ''} title={title} loading="lazy" />
          : src && /^https?:/i.test(src) ? <img src={src} alt={alt || ''} title={title} loading="lazy" referrerPolicy="no-referrer" /> : <span>{alt}</span>,
        a: ({ href, children, title }) => href?.startsWith('attachments/')
          ? <a href={noteAttachmentUrl(noteId, href)} title={title} onClick={event => { event.preventDefault(); onAttachment(decodeAttachmentTarget(href)) }}>{children}</a>
          : <a href={href || undefined} title={title} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>,
        table: ({ children }) => <Box sx={{ overflowX: 'auto', my: 1 }}><table>{children}</table></Box>
      }}>{text}</Markdown>
  </Box>
}
