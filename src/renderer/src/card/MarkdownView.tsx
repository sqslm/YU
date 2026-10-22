import type { CSSProperties } from 'react'
import { parseMarkdown } from './markdown'
import type { Block, Inline } from './markdown'
import type { SearchResult } from '@shared/types'
import { isSafeLink } from '@shared/links'

/**
 * Turns the card's answer text into readable prose.
 *
 * Typography rules of thumb, all measured on a 14 px base:
 * - body 14 / 1.72, dimmed to `#e8ebf2` so bold labels can be brighter;
 * - headings get air *above* and almost none below, so they read as labels for
 *   the block that follows rather than as their own paragraph;
 * - lists hang: the marker sits in a fixed 16 px gutter, so wrapped lines align
 *   with the text and not with the bullet;
 * - inline code, quotes and rules borrow the card's own hairline colours, so a
 *   formatted answer still looks like the same surface.
 */
const BODY: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.72,
  color: '#e8ebf2',
  wordBreak: 'break-word'
}

const paragraphStyle: CSSProperties = {
  ...BODY,
  // A soft wrap from the model is a line break the author asked for; `pre-wrap`
  // keeps it without turning the answer into one long re-flowed blob.
  whiteSpace: 'pre-wrap',
  margin: '0 0 8px'
}

function headingStyle(level: number): CSSProperties {
  const size = level <= 1 ? 16 : level === 2 ? 14.5 : 13.5
  return {
    fontSize: size,
    fontWeight: 650,
    lineHeight: 1.5,
    letterSpacing: 0.1,
    color: '#f2f5fb',
    margin: '12px 0 6px'
  }
}

const listStyle = (ordered: boolean): CSSProperties => ({
  ...BODY,
  margin: '0 0 8px',
  paddingInlineStart: 18,
  listStyleType: ordered ? 'decimal' : 'disc',
  listStylePosition: 'outside'
})

const listItemStyle: CSSProperties = {
  margin: '0 0 3px',
  whiteSpace: 'pre-wrap'
}

const quoteStyle: CSSProperties = {
  ...BODY,
  color: '#c3c9d6',
  margin: '0 0 8px',
  paddingLeft: 10,
  borderLeft: '2px solid rgba(127,150,255,.45)',
  whiteSpace: 'pre-wrap'
}

const codeStyle: CSSProperties = {
  margin: '0 0 8px',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(255,255,255,.05)',
  border: '1px solid rgba(255,255,255,.06)',
  fontSize: 12.5,
  lineHeight: 1.6,
  color: '#dfe4ef',
  overflowX: 'auto',
  whiteSpace: 'pre'
}

const ruleStyle: CSSProperties = {
  height: 0,
  margin: '10px 0',
  border: 'none',
  borderTop: '1px solid rgba(255,255,255,.10)'
}

const inlineCodeStyle: CSSProperties = {
  padding: '1px 5px',
  borderRadius: 5,
  background: 'rgba(255,255,255,.07)',
  fontSize: '0.92em',
  // `box-shadow` must not break at its hyphen: a code span split across two
  // lines reads as two tokens, and the card is narrow enough for that to happen
  // on almost every answer.
  whiteSpace: 'nowrap'
}

const linkStyle: CSSProperties = {
  color: '#8fb4ff',
  textDecoration: 'none',
  borderBottom: '1px solid rgba(143,180,255,.35)'
}

const citeStyle: CSSProperties = {
  fontSize: '0.78em',
  color: '#8fa3ff',
  paddingLeft: 1,
  verticalAlign: 'super',
  lineHeight: 0
}

const caretStyle: CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 14,
  marginLeft: 2,
  verticalAlign: '-2px',
  borderRadius: 1,
  background: '#8fa3ff',
  animation: 'cardCaret 1.05s steps(1, end) infinite'
}

function renderInline(inlines: Inline[], keyBase: string, sources: SearchResult[] = []): JSX.Element[] {
  return inlines.map((inline, index) => {
    const key = `${keyBase}-${index}`
    switch (inline.kind) {
      case 'strong':
        return (
          <strong key={key} style={{ fontWeight: 650, color: '#f4f7ff' }}>
            {inline.text}
          </strong>
        )
      case 'em':
        return (
          <em key={key} style={{ fontStyle: 'italic', color: '#d8dded' }}>
            {inline.text}
          </em>
        )
      case 'code':
        return (
          <code key={key} style={inlineCodeStyle}>
            {inline.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={key}
            href={inline.href}
            style={linkStyle}
            title={inline.href}
            target="_blank"
            rel="noreferrer"
          >
            {inline.text || inline.href}
          </a>
        )
      case 'cite': {
        const source = /^\d+$/.test(inline.label) ? sources[Number(inline.label) - 1] : undefined
        return (
          <sup key={key} style={citeStyle}>
            {source && isSafeLink(source.url)
              ? <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.title || source.url} style={{ color: 'inherit', textDecoration: 'none' }} data-card-citation={inline.label}>[{inline.label}]</a>
              : inline.label}
          </sup>
        )
      }
      default:
        return <span key={key}>{inline.text}</span>
    }
  })
}

/**
 * Renders `text` as blocks. `streaming` appends the blinking caret to the *last*
 * block, so a growing answer keeps its caret inside the paragraph being written
 * instead of dropping it onto a line of its own.
 */
export function MarkdownView({
  text,
  streaming = false,
  sources = []
}: {
  text: string
  streaming?: boolean
  sources?: SearchResult[]
}): JSX.Element {
  const blocks: Block[] = parseMarkdown(text)
  const caret = streaming ? <span style={caretStyle} aria-hidden="true" /> : null
  const last = blocks.length - 1

  return (
    <div data-card-markdown>
      {blocks.map((block, index) => {
        const withCaret = index === last ? caret : null
        const key = `${block.kind}-${index}`
        switch (block.kind) {
          case 'heading': {
            const level = Math.min(Math.max(block.level, 1), 4)
            const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
            return (
              <Tag key={key} style={headingStyle(block.level)}>
                {renderInline(block.inlines, key, sources)}
                {withCaret}
              </Tag>
            )
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={key} style={listStyle(block.ordered)}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} style={listItemStyle}>
                    {renderInline(item, `${key}-${itemIndex}`, sources)}
                    {itemIndex === block.items.length - 1 ? withCaret : null}
                  </li>
                ))}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={key} style={quoteStyle}>
                {renderInline(block.inlines, key, sources)}
                {withCaret}
              </blockquote>
            )
          case 'code':
            return (
              <pre key={key} style={codeStyle} data-lang={block.lang || undefined}>
                <code>{block.text}</code>
                {withCaret}
              </pre>
            )
          case 'rule':
            return <hr key={key} style={ruleStyle} />
          case 'table':
            return <div key={key} style={{ overflowX: 'auto', marginBottom: 10 }} data-card-table>
              <table style={{ ...BODY, width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr>{block.headers.map((cell, column) => <th key={column} style={{ textAlign: block.align[column], padding: '7px 9px', borderBottom: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.05)', whiteSpace: 'nowrap' }}>{renderInline(cell, `${key}-h${column}`, sources)}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column], padding: '7px 9px', borderBottom: '1px solid rgba(255,255,255,.08)', minWidth: 80 }}>{renderInline(cell, `${key}-${rowIndex}-${column}`, sources)}</td>)}</tr>)}</tbody>
              </table>{withCaret}
            </div>
          default:
            return (
              <p key={key} style={paragraphStyle} data-card-paragraph>
                {renderInline(block.inlines, key, sources)}
                {withCaret}
              </p>
            )
        }
      })}
    </div>
  )
}
