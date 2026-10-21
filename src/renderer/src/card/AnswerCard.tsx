import { useCallback, useEffect, useRef, useState } from 'react'
import InputBase from '@mui/material/InputBase'
import type { AnswerCardPayload } from '@shared/api'
import type { CardAction } from '@shared/types'
import { MarkdownView } from './MarkdownView'
import i18n from '../i18n'

/** Entrance/exit timings shared with the bar's own "appear" language. */
const ENTER_MS = 200
const EXIT_MS = 140
/** Vertical padding of the stage around the card (used for the height report). */
const STAGE_PADDING = 8

/** Tool ids the answer side emits, rendered as small Chinese chips. */
const TOOL_LABEL: Record<string, string> = {
  get_weather: '天气',
  weather: '天气',
  web_search: '网页检索',
  search: '网页检索',
  web: '网页检索',
  websearch: '网页检索',
  lookup: '网页检索',
  read_webpage: '读取网页',
  get_datetime: '时间',
  time: '时间',
  clock: '时间',
  timezone: '时间',
  calculate: '计算',
  calc: '计算',
  calculator: '计算',
  math: '计算',
  get_selection: '读取选中',
  replace_selection: '改写选中',
  open_search: '打开搜索',
  translate: '翻译',
  news: '新闻',
  asr: '语音识别'
}

function toolLabel(id: string): string {
  const key = id.toLowerCase()
  // The agent emits `get_weather`-style ids; older paths emit bare names.
  const label = TOOL_LABEL[key] ?? TOOL_LABEL[key.replace(/^get_/, '')]
  return label ? i18n.t(label) : id
}

/**
 * `window.api.card` carries `action` / `reportHeight` / `close` in the shared
 * contract, but the preload bridge that ships those methods is wired on the
 * main side (`preload/index.ts` is shared and owned elsewhere). Calling through
 * this optional shape keeps the card working — clipboard and layout still
 * behave — instead of throwing on `undefined` until that wiring lands.
 */
interface CardBridge {
  onData(callback: (payload: AnswerCardPayload) => void): () => void
  hide(): void
  action?(action: CardAction): void
  reportHeight?(height: number): void
  close?(): void
}

function bridge(): CardBridge {
  return window.api.card as unknown as CardBridge
}

/**
 * The Ask Anything answer card.
 *
 * Shown in its own frameless, transparent window that is anchored just above
 * the recording pill, so the card reads as "growing out of the bar". It repeats
 * the bar's material (translucent dark glass, 1px hairline border, 14px radius)
 * and adds no shadow of its own: the window is `hasShadow: false`, so a large
 * CSS shadow would ring the card with a dark halo on the desktop.
 */
export function AnswerCard(): JSX.Element | null {
  const [data, setData] = useState<AnswerCardPayload | null>(null)
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  /** Follow-up question that is waiting for its answer. */
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  /** True once this mount has played `cardIn`; reset when the window hides. */
  const enteredRef = useRef(false)
  const closingRef = useRef(false)
  /** Only a window that really held focus may close itself on blur. */
  const focusedRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const reportedHeight = useRef(0)
  const copyTimer = useRef<number | null>(null)
  const enterTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  /**
   * Plays `cardOut` and only then asks the main process to hide the window —
   * hiding first would cut the exit animation off at frame 0.
   */
  const requestClose = useCallback((): void => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      closingRef.current = false
      setClosing(false)
      setEntering(false)
      bridge().hide()
    }, EXIT_MS)
  }, [])

  useEffect(() => {
    const off = bridge().onData((payload) => {
      setData(payload)
      setCopied(null)
      // Any payload — the answer itself, or a tool status for it — ends the
      // local "thinking" state the follow-up input started.
      setPending(null)

      // The entrance plays once per hidden -> visible transition: on the first
      // payload after mount, and again after the window was hidden (the
      // visibility effect below resets the flag). Status updates of a live
      // answer never replay it.
      if (!enteredRef.current) {
        enteredRef.current = true
        setEntering(true)
        if (enterTimer.current !== null) window.clearTimeout(enterTimer.current)
        enterTimer.current = window.setTimeout(() => {
          enterTimer.current = null
          setEntering(false)
        }, ENTER_MS)
      }
    })
    return off
  }, [])

  // A hidden window reports `visibilitychange`; the next answer then animates
  // in again instead of popping into place.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') enteredRef.current = false
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // ESC closes the card. The main process no longer hides it from
  // `before-input-event`, so this is the single path that owns the animation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [requestClose])

  // Clicking outside the card: `showInactive` means the window usually never
  // holds focus, so a blur only counts after the card actually gained it.
  useEffect(() => {
    const onFocus = (): void => {
      focusedRef.current = true
    }
    const onBlur = (): void => {
      if (!focusedRef.current) return
      focusedRef.current = false
      requestClose()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [requestClose])

  // The window is sized by the main process, so the card reports the height its
  // content actually needs. `reportHeight` becomes `card:height` in the main
  // process and ends in `resizeCardToContent`, which re-anchors the card.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const report = (): void => {
      const height = Math.ceil(el.getBoundingClientRect().height) + STAGE_PADDING * 2
      if (height <= STAGE_PADDING * 2) return
      // Ignore sub-pixel jitter so a rounding wobble never triggers a resize loop.
      if (Math.abs(height - reportedHeight.current) < 4) return
      reportedHeight.current = height
      bridge().reportHeight?.(height)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [data])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      if (enterTimer.current !== null) window.clearTimeout(enterTimer.current)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    []
  )

  // The window paints once before `card:data` lands; render nothing so the
  // empty first frame stays fully transparent instead of flashing a placeholder.
  if (!data) return null

  const question = data.question.trim()
  const answer = data.answer ?? ''
  const tools = data.tools ?? []
  const actions = data.actions ?? []
  const busy = pending !== null
  const statusLine = busy ? i18n.t('正在思考…') : (data.status ?? '').trim() || null
  const streaming = data.streaming === true

  const flash = (kind: string): void => {
    setCopied(kind)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null
      setCopied(null)
    }, 1400)
  }

  /** Clipboard locally first (works even if the main side is mid-wiring), then report. */
  const runAction = (action: CardAction, key: string): void => {
    const text = action.payload ?? answer
    if (action.id === 'copy') {
      if (text) {
        void copyText(text).then((ok) => {
          if (ok) flash(key)
        })
      }
    }
    bridge().action?.(action)
  }

  const copyAnswer = (): void => {
    runAction({ id: 'copy', label: i18n.t('复制'), payload: answer }, 'answer')
  }

  const submitFollowUp = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    setPending(text)
    bridge().action?.({ id: 'ask', label: i18n.t('追问'), payload: text })
  }

  return (
    <div style={stage}>
      <style>{baseCss}</style>

      <div
        ref={cardRef}
        style={{
          ...card,
          animation: closing
            ? `cardOut ${EXIT_MS}ms cubic-bezier(.3,0,.6,1) both`
            : entering
              ? `cardIn ${ENTER_MS}ms cubic-bezier(.05,.6,.4,.95) both`
              : 'none'
        }}
      >
        <div style={header}>
          <div style={brandRow}>
            <span style={brandDot} />
            <span style={brandText}>Typeless Rebuild</span>
          </div>
          <div style={headerActions}>
            <button
              type="button"
              title={i18n.t('关闭')}
              aria-label={i18n.t('关闭')}
              style={iconButton}
              onClick={requestClose}
            >
              ✕
            </button>
          </div>
        </div>

        {question !== '' && (
          <div style={questionRow}>
            <MicIcon />
            <span style={questionText} title={question}>
              {question}
            </span>
          </div>
        )}

        {statusLine !== null && (
          <div style={statusRow} aria-live="polite">
            <span className="card-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span style={statusText}>{statusLine}</span>
          </div>
        )}

        <div style={answerBox}>
          <div style={answerTitleRow}>
            <span style={answerMark}>✦</span>
            <span style={answerTitle}>{i18n.t('回答')}</span>
          </div>
          <div style={answerBody} data-card-body>
            <MarkdownView text={answer} streaming={streaming} />
          </div>

          {data.sources && data.sources.length > 0 && (
            <div style={sources}>
              <div style={sourcesTitle}>{i18n.t('来源')}</div>
              {data.sources.slice(0, 6).map((item, index) => (
                <a
                  key={`${item.url}-${index}`}
                  href={item.url}
                  style={sourceLink}
                  title={item.title || item.url}
                >
                  {item.title || item.url}
                </a>
              ))}
            </div>
          )}
        </div>

        {tools.length > 0 && (
          <div style={chipRow}>
            {tools.map((tool, index) => (
              <span key={`${tool}-${index}`} style={chip}>
                {toolLabel(tool)}
              </span>
            ))}
          </div>
        )}

        <div style={actionRow}>
          {actions.length > 0 ? (
            actions.map((action, index) => {
              const key = `action-${index}`
              return (
                <button
                  key={key}
                  type="button"
                  style={primaryButton}
                  onClick={() => runAction(action, key)}
                >
                  {copied === key ? i18n.t('已复制') : action.label}
                </button>
              )
            })
          ) : (
            <button type="button" style={primaryButton} onClick={copyAnswer}>
              {copied === 'answer' ? i18n.t('已复制') : i18n.t('复制回答')}
            </button>
          )}
        </div>

        <div style={askRow}>
          <InputBase
            className="card-ask"
            value={draft}
            disabled={busy}
            placeholder={busy ? i18n.t('正在思考…') : i18n.t('继续追问…')}
            style={askInput}
            inputProps={{ 'aria-label': i18n.t('追问'), style: askInputInner }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // Never let Enter reach the app behind the card or submit a form.
              event.preventDefault()
              if (event.nativeEvent.isComposing) return
              submitFollowUp()
            }}
          />
          <button
            type="button"
            style={{ ...askButton, opacity: busy || draft.trim() === '' ? 0.5 : 1 }}
            disabled={busy || draft.trim() === ''}
            onClick={submitFollowUp}
          >
            {i18n.t('追问')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Async clipboard first, then the legacy selection trick: a `file://` renderer
 * can be denied `navigator.clipboard` depending on the focus state.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

function MicIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#7b8598"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', marginTop: 2 }}
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  )
}

const baseCss = `
  html, body, #root { margin: 0; height: 100%; background: transparent; overflow: hidden }
  * { box-sizing: border-box }
  ::-webkit-scrollbar { width: 6px; height: 6px }
  ::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,.14); border-radius: 8px;
    border: 1px solid transparent; background-clip: content-box;
  }
  ::-webkit-scrollbar-track { background: transparent }

  /* Card entrance/exit: it grows out of the recording bar below it. */
  @keyframes cardIn {
    from { opacity: 0; transform: translateY(10px) scale(.96) }
    to { opacity: 1; transform: none }
  }
  @keyframes cardOut {
    from { opacity: 1; transform: none }
    to { opacity: 0; transform: translateY(6px) scale(.98) }
  }
  @keyframes cardDot {
    0%, 80%, 100% { opacity: .25; transform: translateY(0) }
    40% { opacity: 1; transform: translateY(-1px) }
  }
  @keyframes cardCaret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }

  .card-dots { display: inline-flex; gap: 2px; align-items: center }
  .card-dots > span {
    width: 4px; height: 4px; border-radius: 99px; background: #8f96a8;
    animation: cardDot 1.2s ease-in-out infinite;
  }
  .card-dots > span:nth-child(2) { animation-delay: .15s }
  .card-dots > span:nth-child(3) { animation-delay: .3s }

  .card-ask {
    border: 1px solid rgba(255,255,255,.10);
    background: rgba(255,255,255,.04);
    border-radius: 8px;
    padding: 3px 8px;
    transition: border-color .15s ease;
  }
  .card-ask:focus-within { border-color: rgba(127,150,255,.45) }
  .card-ask.Mui-disabled { opacity: .6 }
  .card-ask input::placeholder { color: #6f7788; opacity: 1 }
`

const stage: React.CSSProperties = {
  // Flex-end keeps the card glued to the bottom edge of the window — the edge
  // that faces the pill — even when the main process enlarged the window before
  // the content grew (or clamped it at CARD_MIN_HEIGHT for a short answer).
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  minHeight: '100%',
  padding: STAGE_PADDING,
  fontFamily: '"Inter", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
}

const card: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  // Height follows the content; the window is resized to match, so growing
  // answers push the card upwards away from the pill.
  height: 'auto',
  borderRadius: 14,
  background: 'rgba(28,28,30,.96)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
  border: '1px solid rgba(255,255,255,.10)',
  color: '#eef1f7',
  overflow: 'hidden',
  // The card is anchored above the pill: it should rise out of the bar.
  transformOrigin: 'bottom center',
  // No shadow: the window is transparent and shadowless, a CSS shadow here
  // would paint a dark ring around the card.
  boxShadow: 'none'
} as React.CSSProperties

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 40,
  padding: '0 10px 0 14px',
  flex: '0 0 auto',
  borderBottom: '1px solid rgba(255,255,255,.06)',
  WebkitAppRegion: 'drag'
} as React.CSSProperties

const brandRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8
}

const brandDot: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 99,
  background: '#7f96ff'
}

const brandText: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.2,
  color: '#cfd4e0'
}

const headerActions: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  WebkitAppRegion: 'no-drag'
} as React.CSSProperties

const iconButton: React.CSSProperties = {
  width: 24,
  height: 24,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: '#8b93a4',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
  WebkitAppRegion: 'no-drag'
} as React.CSSProperties

const questionRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '12px 14px 8px',
  flex: '0 0 auto'
}

const questionText: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: '#9aa2b1',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden'
} as React.CSSProperties


const statusRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 14px 8px',
  flex: '0 0 auto',
  minHeight: 18
}

const statusText: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.4,
  color: '#8b93a4'
}

const answerBox: React.CSSProperties = {
  flex: '0 0 auto',
  margin: '0 14px',
  padding: '10px 12px 12px',
  borderRadius: 10,
  background: 'rgba(255,255,255,.04)',
  border: '1px solid rgba(255,255,255,.06)',
  // Long answers scroll inside the card instead of growing the window past the
  // screen; the cap tracks the window height the main process settled on.
  maxHeight: '55vh',
  overflowY: 'auto',
  userSelect: 'text'
}

const answerTitleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  marginBottom: 6
}

const answerMark: React.CSSProperties = {
  fontSize: 11,
  color: '#8fa3ff'
}

const answerTitle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 0.6,
  color: '#8f96a8'
}

const answerBody: React.CSSProperties = {
  // The body itself no longer sets type: MarkdownView owns the scale, spacing and
  // inline styling, and the scroll box only has to keep the text selectable.
  color: '#e8ebf2',
  wordBreak: 'break-word',
  userSelect: 'text'
}


const sources: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 8,
  borderTop: '1px solid rgba(255,255,255,.06)',
  display: 'flex',
  flexDirection: 'column',
  gap: 3
}

const sourcesTitle: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: 0.5,
  color: '#6f7788',
  marginBottom: 2
}

const sourceLink: React.CSSProperties = {
  fontSize: 11.5,
  color: '#7f9bd8',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: '8px 14px 0',
  flex: '0 0 auto'
}

const chip: React.CSSProperties = {
  padding: '1px 7px',
  borderRadius: 99,
  border: '1px solid rgba(255,255,255,.08)',
  background: 'rgba(255,255,255,.04)',
  color: '#9aa2b1',
  fontSize: 10.5,
  lineHeight: 1.6
}

const actionRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  gap: 8,
  padding: '8px 14px 0',
  flex: '0 0 auto'
}

const primaryButton: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: 8,
  border: '1px solid rgba(76,141,255,.35)',
  background: 'rgba(76,141,255,.16)',
  color: '#b9cdff',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer'
}

const askRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px 12px',
  flex: '0 0 auto'
}

const askInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: '#e8ebf2'
}

const askInputInner: React.CSSProperties = {
  padding: '2px 0',
  color: '#e8ebf2'
}

const askButton: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '5px 12px',
  borderRadius: 8,
  border: '1px solid rgba(76,141,255,.35)',
  background: 'rgba(76,141,255,.16)',
  color: '#b9cdff',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer'
}
