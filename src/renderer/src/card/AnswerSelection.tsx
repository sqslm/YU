import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownView } from './MarkdownView'
import i18n from '../i18n'

/** One frozen-context explanation. It is never sent through the chat/Ask learning path. */
export function AnswerSelection({ children, snapshotKey, busy, onOpen }: { children: ReactNode; snapshotKey: string; busy: boolean; onOpen(open: boolean): void }): JSX.Element {
  const root = useRef<HTMLDivElement>(null), sequence = useRef(0)
  const [menu, setMenu] = useState<{ x: number; y: number; text: string; link: string } | null>(null)
  const [panel, setPanel] = useState<{ selected: string; answer: string; error: string; loading: boolean } | null>(null)
  const t = i18n.t.bind(i18n)
  const close = (): void => { sequence.current++; setPanel(null); onOpen(false); window.api.card.closeExplanation() }
  useEffect(() => { sequence.current++; setMenu(null); setPanel(null); onOpen(false); window.api.card.closeExplanation() }, [snapshotKey, onOpen])
  useEffect(() => () => { sequence.current++; window.api.card.closeExplanation(); onOpen(false) }, [onOpen])
  useEffect(() => window.api.card.onHidden(() => { sequence.current++; setMenu(null); setPanel(null); onOpen(false); window.api.card.closeExplanation() }), [onOpen])
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => { if (!(event.target as Element)?.closest('[data-answer-menu]')) setMenu(null) }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !menu && !panel) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (menu) setMenu(null); else close()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape, true) }
  }, [menu, panel])
  const explain = async (selected: string): Promise<void> => {
    const request = ++sequence.current
    setMenu(null); setPanel({ selected, answer: '', error: '', loading: true }); onOpen(true)
    try { const answer = await window.api.card.explain(selected); if (sequence.current === request) setPanel({ selected, answer, error: '', loading: false }) }
    catch (error) { if (sequence.current === request) setPanel({ selected, answer: '', error: String(error).replace(/^Error.*?: Error: /, ''), loading: false }) }
  }
  const itemStyle: React.CSSProperties = { border: 0, background: 'none', color: '#eef1f7', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 12, cursor: 'pointer', display: 'block' }
  return <div ref={root} onContextMenu={event => {
    event.preventDefault()
    const selection = window.getSelection(), text = selection?.anchorNode && root.current?.contains(selection.anchorNode) ? selection.toString().trim() : ''
    const anchor = (event.target as Element).closest('a')
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 190), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)), text, link: anchor?.href ?? '' })
  }}>{children}
    {menu && createPortal(<div data-answer-menu role="menu" aria-label={t('选区操作')} style={{ position: 'fixed', zIndex: 100, left: Math.max(8, menu.x), top: menu.y, width: 180, padding: '4px 0', border: '1px solid #48494d', borderRadius: 8, background: '#2b2c30', boxShadow: '0 5px 20px #0005' }} onMouseDown={event => event.preventDefault()}>
      <button role="menuitem" style={itemStyle} disabled={!menu.text} onClick={() => { void window.api.app.copyText(menu.text); setMenu(null) }}>{t('复制选中文字')}</button>
      <button role="menuitem" style={itemStyle} onClick={() => { const range = document.createRange(); range.selectNodeContents(root.current!); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); setMenu(null) }}>{t('全选回答')}</button>
      {menu.link && <button role="menuitem" style={itemStyle} onClick={() => { void window.api.app.copyText(menu.link); setMenu(null) }}>{t('复制链接')}</button>}
      <button role="menuitem" data-explain-selection style={{ ...itemStyle, borderTop: '1px solid #45464c', color: '#a9c8ff' }} disabled={busy || !menu.text || menu.text.length > 6000} onClick={() => void explain(menu.text)}>{t('解释所选内容')}</button>
    </div>, document.body)}
    {panel && createPortal(<aside data-answer-explanation aria-label={t('一次性解释')} style={{ position: 'fixed', right: 8, top: 8, bottom: 8, width: 'min(300px, 38vw)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 12, background: 'rgba(28,28,30,.98)', color: '#eef1f7', display: 'flex', flexDirection: 'column', fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #ffffff16' }}><strong style={{ flex: 1, fontSize: 13 }}>{t('解释')}</strong><button aria-label={t('关闭解释')} onClick={close} style={{ ...itemStyle, width: 'auto', padding: 2 }}>✕</button></header>
      <div style={{ padding: 14, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        <blockquote style={{ margin: '0 0 12px', padding: '6px 10px', borderLeft: '2px solid #8caef0', background: '#ffffff08', fontSize: 12, maxHeight: 100, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{panel.selected}</blockquote>
        <div style={{ fontSize: 10.5, color: '#939cae', marginBottom: 14 }}>{t('参考本次回答 · 不加入对话或长期记忆')}</div>
        {panel.loading ? <div role="status" style={{ fontSize: 12 }}>{t('正在解释…')}</div> : panel.error ? <div role="alert" style={{ fontSize: 12, color: '#ffb4aa' }}>{panel.error}<button style={{ ...itemStyle, color: '#a9c8ff', marginTop: 10 }} onClick={() => void explain(panel.selected)}>{t('重试')}</button></div> : <MarkdownView text={panel.answer} onCopyCode={text => { void window.api.app.copyText(text) }} />}
      </div>
      <footer style={{ borderTop: '1px solid #ffffff16', padding: '8px 14px' }}><button disabled={panel.loading || !panel.answer} style={{ ...itemStyle, color: '#a9c8ff', padding: 0 }} onClick={() => void window.api.app.copyText(panel.answer)}>{t('复制解释')}</button></footer>
    </aside>, document.body)}
  </div>
}
