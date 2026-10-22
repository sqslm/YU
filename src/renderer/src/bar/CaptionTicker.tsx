import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface CaptionGlyph { id: number; text: string }
const MAX_GLYPHS = 48
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Compare complete targets, including queued glyphs. Matching letters and
 * spelling corrections keep their IDs; only additions need an entry animation. */
export function reconcileCaption(previous: CaptionGlyph[], text: string, nextId: () => number): CaptionGlyph[] {
  const next = Array.from(segmenter.segment(text), item => item.segment).slice(-MAX_GLYPHS)
  const cols = next.length + 1
  const lengths = new Uint8Array((previous.length + 1) * cols)
  for (let i = previous.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) {
    lengths[i * cols + j] = previous[i].text === next[j]
      ? lengths[(i + 1) * cols + j + 1] + 1
      : Math.max(lengths[(i + 1) * cols + j], lengths[i * cols + j + 1])
  }
  const matches: Array<[number, number]> = []
  let i = 0, j = 0
  while (i < previous.length && j < next.length) {
    if (previous[i].text === next[j]) { matches.push([i++, j++]) }
    else if (lengths[(i + 1) * cols + j] >= lengths[i * cols + j + 1]) i++
    else j++
  }
  matches.push([previous.length, next.length])
  const result: CaptionGlyph[] = []
  let oldAt = 0, newAt = 0
  for (const [oldMatch, newMatch] of matches) {
    for (let n = newAt; n < newMatch; n++) {
      const old = oldAt + n - newAt
      result.push({ id: old < oldMatch ? previous[old].id : nextId(), text: next[n] })
    }
    if (oldMatch < previous.length) result.push(previous[oldMatch])
    oldAt = oldMatch + 1
    newAt = newMatch + 1
  }
  return result
}

export function CaptionTicker({ text }: { text: string }): JSX.Element {
  const [glyphs, setGlyphs] = useState<CaptionGlyph[]>([])
  const target = useRef<CaptionGlyph[]>([])
  const shown = useRef(new Set<number>())
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useLayoutEffect(() => {
    const next = reconcileCaption(target.current, text, () => ++sequence.current)
    target.current = next
    const ids = new Set(next.map(glyph => glyph.id))
    shown.current = new Set([...shown.current].filter(id => ids.has(id)))
    const reveal = (): void => {
      const pending = target.current.find(glyph => !shown.current.has(glyph.id))
      if (pending) shown.current.add(pending.id)
      setGlyphs(target.current.filter(glyph => shown.current.has(glyph.id)))
      if (!target.current.some(glyph => !shown.current.has(glyph.id)) && timer.current) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    setGlyphs(next.filter(glyph => shown.current.has(glyph.id)))
    if (!timer.current && next.some(glyph => !shown.current.has(glyph.id))) {
      reveal()
      if (next.some(glyph => !shown.current.has(glyph.id))) timer.current = setInterval(reveal, 45)
    }
  }, [text])
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])
  return <span data-live-caption role="status" aria-label={text} style={{ width: '100%', minWidth: 0, height: 25, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', maskImage: 'linear-gradient(to right, transparent, black 12px)' }}>
    <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0, whiteSpace: 'pre', fontSize: 14, lineHeight: '24px' }}>
      {glyphs.map(glyph => <span key={glyph.id} data-caption-glyph data-caption-id={glyph.id} style={{ display: 'inline-flex', flexShrink: 0, overflow: 'hidden', animation: 'caption-enter .14s ease-out both' }}>{glyph.text}</span>)}
    </span>
  </span>
}
