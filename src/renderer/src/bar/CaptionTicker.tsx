import { useEffect, useRef, useState } from 'react'

export interface CaptionGlyph { id: number; text: string }
const MAX_GLYPHS = 24

/** Preserve matching glyphs when an ASR window advances or revises its tail. */
export function captionUpdate(current: CaptionGlyph[], text: string): { keep: CaptionGlyph[]; pending: string[] } {
  const next = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment).slice(-MAX_GLYPHS)
  let overlap = Math.min(current.length, next.length)
  while (overlap > 0 && !current.slice(-overlap).every((glyph, index) => glyph.text === next[index])) overlap--
  let prefix = 0
  while (prefix < current.length && prefix < next.length && current[prefix].text === next[prefix]) prefix++
  if (overlap > prefix) return { keep: current.slice(-overlap), pending: next.slice(overlap) }
  return { keep: current.slice(0, prefix), pending: next.slice(prefix) }
}

export function CaptionTicker({ text }: { text: string }): JSX.Element {
  const [glyphs, setGlyphs] = useState<CaptionGlyph[]>([])
  const current = useRef<CaptionGlyph[]>([])
  const sequence = useRef(0)
  useEffect(() => {
    const { keep, pending } = captionUpdate(current.current, text)
    current.current = keep
    setGlyphs(keep)
    if (!pending.length) return
    let index = 0
    const timer = setInterval(() => {
      const next = [...current.current, { id: ++sequence.current, text: pending[index++] }].slice(-MAX_GLYPHS)
      current.current = next
      setGlyphs(next)
      if (index === pending.length) clearInterval(timer)
    }, 60)
    return () => clearInterval(timer)
  }, [text])
  return <span data-live-caption role="status" aria-label={text} style={{ width: 164, minWidth: 0, height: 23, flex: '1 1 164px', overflow: 'hidden', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', maskImage: 'linear-gradient(to right, transparent, black 12px)' }}>
    <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0, whiteSpace: 'pre', fontSize: 13.5, lineHeight: '22px' }}>
      {glyphs.map(glyph => <span key={glyph.id} data-caption-glyph style={{ display: 'inline-flex', flexShrink: 0, overflow: 'hidden', animation: 'caption-enter .12s ease-out both' }}>{glyph.text}</span>)}
    </span>
  </span>
}
