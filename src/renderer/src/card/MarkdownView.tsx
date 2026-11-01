import { useMemo, type CSSProperties } from 'react'
import { parseMarkdown } from './markdown'
import type { Block, Inline } from './markdown'
import type { SearchResult } from '@shared/types'
import { isSafeLink } from '@shared/links'
import { accentWash, glassSkin, wash, type GlassSkin } from '../settings/appearance'
import i18n from '../i18n'

/** The shipped card material, used when a host does not hand a skin down. */
const CLASSIC_GLASS: GlassSkin = glassSkin('classic', 'dark')

/**
 * Turns the card's answer text into readable prose.
 *
 * Typography rules of thumb, all measured on a 14 px base:
 * - body 14 / 1.72, in the pack's text colour so bold labels can be brighter;
 * - headings get air *above* and almost none below, so they read as labels for
 *   the block that follows rather than as their own paragraph;
 * - lists hang: the marker sits in a fixed 16 px gutter, so wrapped lines align
 *   with the text and not with the bullet;
 * - inline code, quotes and rules borrow the card's own hairline colours, so a
 *   formatted answer still looks like the same surface.
 */
function markdownStyles(g: GlassSkin) {
  const body: CSSProperties = {
    fontSize: 14,
    lineHeight: 1.72,
    color: `var(--answer-text, ${g.text})`,
    wordBreak: 'break-word'
  }

  const paragraph: CSSProperties = {
    ...body,
    // A soft wrap from the model is a line break the author asked for; `pre-wrap`
    // keeps it without turning the answer into one long re-flowed blob.
    whiteSpace: 'pre-wrap',
    margin: '0 0 8px'
  }

  const heading = (level: number): CSSProperties => {
    const size = level <= 1 ? 16 : level === 2 ? 14.5 : 13.5
    return {
      fontSize: size,
      fontWeight: 650,
      lineHeight: 1.5,
      letterSpacing: 0.1,
      color: `var(--answer-text, ${g.textStrong})`,
      margin: '12px 0 6px'
    }
  }

  const list = (ordered: boolean): CSSProperties => ({
    ...body,
    margin: '0 0 8px',
    paddingInlineStart: 18,
    listStyleType: ordered ? 'decimal' : 'disc',
    listStylePosition: 'outside'
  })

  const listItem: CSSProperties = {
    margin: '0 0 3px',
    whiteSpace: 'pre-wrap'
  }

  const quote: CSSProperties = {
    ...body,
    color: `var(--answer-muted, ${g.textMuted})`,
    margin: '0 0 8px',
    paddingLeft: 10,
    borderLeft: `2px solid var(--answer-accent, ${accentWash(g, .45)})`,
    whiteSpace: 'pre-wrap'
  }

  const code: CSSProperties = {
    margin: '0 0 8px',
    padding: '8px 10px',
    borderRadius: g.radiusSm,
    background: `var(--answer-fill, ${wash(g, .05)})`,
    border: `${g.borderWidth}px solid var(--answer-line, ${wash(g, .06)})`,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: `var(--answer-text, ${g.label})`,
    overflowX: 'auto',
    whiteSpace: 'pre'
  }

  const rule: CSSProperties = {
    height: 0,
    margin: '10px 0',
    border: 'none',
    borderTop: `${g.borderWidth}px solid var(--answer-line, ${wash(g, .10)})`
  }

  const inlineCode: CSSProperties = {
    padding: '1px 5px',
    borderRadius: 5,
    background: `var(--answer-fill, ${wash(g, .07)})`,
    fontSize: '0.92em',
    // `box-shadow` must not break at its hyphen: a code span split across two
    // lines reads as two tokens, and the card is narrow enough for that to happen
    // on almost every answer.
    whiteSpace: 'nowrap'
  }

  const link: CSSProperties = {
    color: `var(--answer-accent, ${g.accent})`,
    textDecoration: 'none',
    borderBottom: `${g.borderWidth}px solid var(--answer-line, ${accentWash(g, .35)})`
  }

  const cite: CSSProperties = {
    fontSize: '0.78em',
    color: `var(--answer-accent, ${g.accent})`,
    paddingLeft: 1,
    verticalAlign: 'super',
    lineHeight: 0
  }

  const caret: CSSProperties = {
    display: 'inline-block',
    width: 7,
    height: 14,
    marginLeft: 2,
    verticalAlign: '-2px',
    borderRadius: 1,
    background: `var(--answer-accent, ${g.accent})`,
    animation: 'cardCaret 1.05s steps(1, end) infinite'
  }

  const strong: CSSProperties = { fontWeight: 650, color: `var(--answer-text, ${g.textStrong})` }
  const em: CSSProperties = { fontStyle: 'italic', color: `var(--answer-text, ${g.label})` }

  return { body, paragraph, heading, list, listItem, quote, code, rule, inlineCode, link, cite, caret, strong, em }
}

type MarkdownStyles = ReturnType<typeof markdownStyles>

function renderInline(inlines: Inline[], keyBase: string, st: MarkdownStyles, sources: SearchResult[] = []): JSX.Element[] {
  return inlines.map((inline, index) => {
    const key = `${keyBase}-${index}`
    switch (inline.kind) {
      case 'strong':
        return (
          <strong key={key} style={st.strong}>
            {inline.text}
          </strong>
        )
      case 'em':
        return (
          <em key={key} style={st.em}>
            {inline.text}
          </em>
        )
      case 'code':
        return (
          <code key={key} style={st.inlineCode}>
            {inline.text}
          </code>
        )
      case 'link':
        return (
          <a
            key={key}
            href={inline.href}
            style={st.link}
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
          <sup key={key} style={st.cite}>
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
  sources = [],
  onCopyCode,
  copiedCode,
  glass = CLASSIC_GLASS
}: {
  text: string
  streaming?: boolean
  sources?: SearchResult[]
  onCopyCode?: (text: string, key: string) => void
  copiedCode?: string | null
  /** Card material. Hosts that do not pass one keep the shipped card skin. */
  glass?: GlassSkin
}): JSX.Element {
  const st = useMemo(() => markdownStyles(glass), [glass])
  const blocks: Block[] = parseMarkdown(text)
  const caret = streaming ? <span style={st.caret} aria-hidden="true" /> : null
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
              <Tag key={key} style={st.heading(block.level)}>
                {renderInline(block.inlines, key, st, sources)}
                {withCaret}
              </Tag>
            )
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={key} style={st.list(block.ordered)}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} style={st.listItem}>
                    {renderInline(item, `${key}-${itemIndex}`, st, sources)}
                    {itemIndex === block.items.length - 1 ? withCaret : null}
                  </li>
                ))}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={key} style={st.quote}>
                {renderInline(block.inlines, key, st, sources)}
                {withCaret}
              </blockquote>
            )
          case 'code':
            return (
              <div key={key}>
              {onCopyCode && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, color: `var(--answer-muted, ${glass.textDim})` }}>
                <span>{block.lang || i18n.t('代码')}</span>
                <button type="button" data-copy-code style={{ border: 'none', background: 'transparent', color: `var(--answer-accent, ${glass.accent})`, cursor: 'pointer', fontSize: 11, padding: '3px 6px' }}
                  onClick={() => onCopyCode(block.text, key)}>{i18n.t(copiedCode === key ? '已复制' : '复制代码')}</button>
              </div>}
              <pre style={st.code} data-lang={block.lang || undefined}>
                <code>{block.text}</code>
                {withCaret}
              </pre>
              </div>
            )
          case 'rule':
            return <hr key={key} style={st.rule} />
          case 'table':
            return <div key={key} style={{ overflowX: 'auto', marginBottom: 10 }} data-card-table>
              <table style={{ ...st.body, width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr>{block.headers.map((cell, column) => <th key={column} style={{ textAlign: block.align[column], padding: '7px 9px', borderBottom: `${glass.borderWidth}px solid var(--answer-line, ${wash(glass, .18)})`, background: `var(--answer-fill, ${wash(glass, .05)})`, whiteSpace: 'nowrap' }}>{renderInline(cell, `${key}-h${column}`, st, sources)}</th>)}</tr></thead>
                <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.align[column], padding: '7px 9px', borderBottom: `${glass.borderWidth}px solid var(--answer-line, ${wash(glass, .08)})`, minWidth: 80 }}>{renderInline(cell, `${key}-${rowIndex}-${column}`, st, sources)}</td>)}</tr>)}</tbody>
              </table>{withCaret}
            </div>
          default:
            return (
              <p key={key} style={st.paragraph} data-card-paragraph>
                {renderInline(block.inlines, key, st, sources)}
                {withCaret}
              </p>
            )
        }
      })}
    </div>
  )
}
