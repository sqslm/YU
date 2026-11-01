import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import InputBase from '@mui/material/InputBase'
import { useTranslation } from 'react-i18next'
import type { AnswerCardPayload } from '@shared/api'
import type { CardAction, Settings } from '@shared/types'
import { isSafeLink } from '@shared/links'
import { stripSourceTail } from '@shared/sourceText'
import { MarkdownView } from './MarkdownView'
import i18n, { applyUiLanguage } from '../i18n'
import { answerNote } from './answerNote'
import { useVoiceQuestion } from './useVoiceQuestion'
import { AnswerSelection } from './AnswerSelection'
import { accentWash, glassOf, glassSkin, wash, type GlassSkin } from '../settings/appearance'

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
  ready(): void
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
  useTranslation()
  const [data, setData] = useState<AnswerCardPayload | null>(null)
  const [explanationOpen, setExplanationOpen] = useState(false)
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  /** Follow-up question that is waiting for its answer. */
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [previousAnswer, setPreviousAnswer] = useState<AnswerCardPayload | null>(null)
  const followUpHeight = useRef(0)
  /**
   * Sources start open: they are the only place a searched answer can be verified,
   * and the card is the surface people read them on. Hiding them behind a toggle
   * made "where did this come from" a second click away.
   */
  const [sourcesExpanded, setSourcesExpanded] = useState(true)
  const [sourcePage, setSourcePage] = useState(1)
  const [itemPage, setItemPage] = useState(1)
  const [sourceSize, setSourceSize] = useState(30)
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<AnswerCardPayload | null>(null)
  const [saveError, setSaveError] = useState('')
  const dataRef = useRef<AnswerCardPayload | null>(null)
  const saveInFlight = useRef(false)
  /**
   * The colours this card paints with. Seeded with the shipped pack so the frame
   * drawn before `settings.get()` resolves is the card this app always had.
   */
  const [glass, setGlass] = useState<GlassSkin>(() => glassSkin('classic', 'dark'))
  const s = useMemo(() => cardStyles(glass), [glass])

  /** True once this mount has played `cardIn`; reset when the window hides. */
  const enteredRef = useRef(false)
  const closingRef = useRef(false)
  /** Only a window that really held focus may close itself on blur. */
  const focusedRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const reportedHeight = useRef(0)
  const copyTimer = useRef<number | null>(null)
  const enterTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const submitQuestion = useCallback((value: string): void => {
    const text = value.trim(), current = dataRef.current
    if (!text || !current || current.streaming) return
    setPreviousAnswer(current.question ? current : null)
    followUpHeight.current = cardRef.current?.getBoundingClientRect().height ?? 0
    setDraft(''); setPending(text)
    bridge().action?.({ id: 'ask', label: i18n.t('追问'), payload: text })
  }, [])
  const voice = useVoiceQuestion(submitQuestion)

  useEffect(() => {
    const apply = (settings: Settings): void => {
      applyUiLanguage(settings.uiLanguage)
      setSourceSize(settings.listPageSize)
      setGlass(glassOf(settings))
    }
    void window.api.settings.get().then(apply)
    return window.api.settings.onChanged(apply)
  }, [])

  /**
   * Plays `cardOut` and only then asks the main process to hide the window —
   * hiding first would cut the exit animation off at frame 0.
   */
  const requestClose = useCallback((): void => {
    voice.cancel()
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
  }, [voice.cancel])

  useEffect(() => {
    const off = bridge().onData((payload) => {
      dataRef.current = payload
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
    bridge().ready()
    return off
  }, [])

  // Native hide is authoritative on Windows; visibilitychange is also handled.
  useEffect(() => {
    const resetHidden = (): void => {
      enteredRef.current = false
      focusedRef.current = false
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      closeTimer.current = null
      closingRef.current = false
      setClosing(false)
      setPinned(false); setDraft(''); setPending(null); setSaved(null); setSaveError('')
      setPreviousAnswer(null); followUpHeight.current = 0; voice.cancel()
      voice.clearError()
      dataRef.current = null
    }
    const onVisibility = (): void => { if (document.visibilityState === 'hidden') resetHidden() }
    const offHidden = window.api.card.onHidden(resetHidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { offHidden(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  useEffect(() => setSourcePage(1), [data?.question, sourceSize])
  useEffect(() => setItemPage(1), [data?.question, sourceSize])

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
      if (pinned || explanationOpen || pending !== null || data?.streaming || voice.recording || voice.working) return
      if (!focusedRef.current || document.visibilityState === 'hidden') return
      focusedRef.current = false
      requestClose()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [requestClose, pinned, explanationOpen, pending, data?.streaming, voice.recording, voice.working])

  // The window is sized by the main process, so the card reports the height its
  // content actually needs. `reportHeight` becomes `card:height` in the main
  // process and ends in `resizeCardToContent`, which re-anchors the card.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const report = (): void => {
      const scroll = scrollRef.current
      const overflow = scroll ? Math.max(0, scroll.scrollHeight - scroll.clientHeight) : 0
      const height = Math.ceil(el.getBoundingClientRect().height + overflow) + STAGE_PADDING * 2
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
  }, [data, sourcesExpanded])

  useEffect(() => {
    voice.clearError()
    setSourcesExpanded(false)
    setDraft(''); setSaved(null); setSaveError('')
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [data?.question])

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
  const sourceList = data.sources ?? []
  // The card draws its own clickable source section below the answer, so a source
  // list the answer carries in its text would show the same links twice. Strip it
  // only when cards exist: with no cards the text is the only way to reach them.
  const answer = sourceList.length ? stripSourceTail(data.answer ?? '') : data.answer ?? ''
  const tools = data.tools ?? []
  const actions = data.actions ?? []
  const busy = pending !== null || data.streaming === true
  const statusLine = pending !== null ? i18n.t('正在思考…') : (data.status ?? '').trim() || (data.taskState === 'awaiting_confirmation' ? i18n.t('等待确认') : null)
  const streaming = data.streaming === true
  const items = data.localResults?.flatMap(result => result.items ?? []) ?? []
  const itemPages = Math.max(1, Math.ceil(items.length / sourceSize))
  const safeItemPage = Math.min(itemPage, itemPages)
  const retrieval = data.retrieval
  const sourcePages = Math.max(1, Math.ceil(sourceList.length / sourceSize))
  const safeSourcePage = Math.min(sourcePage, sourcePages)
  const searchLabel = retrieval?.failed ? i18n.t('检索未成功')
    : retrieval?.searched || sourceList.length > 0 ? i18n.t('已联网') : i18n.t('未联网')

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

  const saveAnswer = async (): Promise<void> => {
    if (saveInFlight.current || busy || !answer.trim()) return
    const snapshot = data
    saveInFlight.current = true; setSaving(true); setSaveError('')
    try {
      await window.api.notes.createText({ text: answerNote(snapshot) })
      if (dataRef.current?.question === snapshot.question && dataRef.current?.answer === snapshot.answer) setSaved(snapshot)
    } catch (error) {
      if (dataRef.current?.question === snapshot.question && dataRef.current?.answer === snapshot.answer) {
        setSaveError(i18n.t(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)))
      }
    } finally { saveInFlight.current = false; setSaving(false) }
  }

  const submitFollowUp = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    submitQuestion(text)
  }

  return (
    <div style={s.stage}>
      <style>{s.baseCss}</style>

      <div
        ref={cardRef}
        style={{
          ...s.card,
          width: explanationOpen ? 'calc(100% - min(312px, 40vw))' : '100%',
          minHeight: busy && followUpHeight.current ? Math.min(followUpHeight.current, window.innerHeight - STAGE_PADDING * 2) : undefined,
          animation: closing
            ? `cardOut ${EXIT_MS}ms cubic-bezier(.3,0,.6,1) both`
            : entering
              ? `cardIn ${ENTER_MS}ms cubic-bezier(.05,.6,.4,.95) both`
              : 'none'
        }}
      >
        <div style={s.header}>
          <div style={s.brandRow}>
            <span style={s.brandDot} />
            <span style={s.brandText}>{data.selection ? i18n.t('选区处理') : 'Ask'}</span>
            {!busy && !data.selection && <span style={s.chip} data-card-retrieval>{data.stopped ? i18n.t('已停止') : searchLabel}</span>}
          </div>
          <div style={s.headerActions}>
            <button type="button" data-card-pin aria-pressed={pinned} title={i18n.t(pinned ? '取消固定' : '固定显示')}
              aria-label={i18n.t(pinned ? '取消固定' : '固定显示')} style={{ ...s.iconButton, width: 'auto', padding: '0 6px', color: pinned ? glass.accent : glass.textFaint }}
              onClick={() => setPinned(value => !value)}>{i18n.t(pinned ? '已固定' : '固定')}</button>
            <button
              type="button"
              title={i18n.t('关闭')}
              aria-label={i18n.t('关闭')}
              style={s.iconButton}
              onClick={requestClose}
            >
              ✕
            </button>
          </div>
        </div>

        {previousAnswer && !data.selection && <details data-card-context style={{ padding: '6px 14px', fontSize: 11.5, color: glass.textDim }}>
          <summary>{i18n.t('沿用上下文：{{question}}', { question: previousAnswer.question })}</summary>
          <div style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', marginTop: 6 }}>{previousAnswer.answer}</div>
        </details>}
        {question !== '' && (
          <div style={s.questionRow}>
            <MicIcon stroke={s.micStroke} />
            <span style={s.questionText} title={question}>
              {question}
            </span>
          </div>
        )}

        {statusLine !== null && (
          <div style={s.statusRow} aria-live="polite">
            {busy && <span className="card-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>}
            <span style={s.statusText}>{statusLine}</span>
          </div>
        )}

        <div ref={scrollRef} style={s.answerBox} data-card-scroll>
          <div style={s.answerTitleRow}>
            <span style={s.answerMark}>✦</span>
            <span style={s.answerTitle}>{i18n.t(data.selection ? '处理结果' : '回答')}</span>
          </div>
          <div style={s.answerBody} data-card-body>
            <AnswerSelection snapshotKey={`${data.taskId ?? ''}:${data.question}:${answer}`} busy={busy} onOpen={setExplanationOpen} glass={glass}>
            <MarkdownView text={answer} streaming={streaming} sources={sourceList} copiedCode={copied} glass={glass}
              onCopyCode={busy ? undefined : (text, key) => runAction({ id: 'copy', label: i18n.t('复制代码'), payload: text }, key)} />
            </AnswerSelection>
          </div>
          {items.length > 0 && <div data-card-items>
            {items.slice((safeItemPage - 1) * sourceSize, safeItemPage * sourceSize).map((item, index) => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 12 }}>
                <div>{(safeItemPage - 1) * sourceSize + index + 1}. {item.name}</div><div style={{ color: glass.textFaint, fontSize: 11, marginTop: 3 }}>{item.path}</div>
              </div>
              <button data-card-open-item={item.id} style={s.primaryButton} disabled={busy} onClick={() => bridge().action?.({ id: 'open-item', payload: item.id, label: i18n.t('打开') })}>{i18n.t('打开')}</button>
            </div>)}
            {itemPages > 1 && <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={s.primaryButton} disabled={safeItemPage <= 1} onClick={() => setItemPage(safeItemPage - 1)}>{i18n.t('上一页')}</button>
              <span style={s.sourcesTitle}>{i18n.t('第 {{page}} / {{total}} 页', { page: safeItemPage, total: itemPages })}</span>
              <button style={s.primaryButton} disabled={safeItemPage >= itemPages} onClick={() => setItemPage(safeItemPage + 1)}>{i18n.t('下一页')}</button>
            </div>}
          </div>}

          {data.memoryTemporary && <div style={{ color: glass.textFaint, fontSize: 11, marginTop: 10 }}>{i18n.t('临时对话：不读取或保存长期记忆')}</div>}
          {Boolean(data.memories?.length) && <details style={{ marginTop: 10, fontSize: 12 }} data-card-memories><summary>{i18n.t('本次使用的记忆')} · {data.memories!.length}</summary>{data.memories!.map(row => <div key={row.id} style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{row.text}</div>)}</details>}
          {sourceList.length > 0 && (
            <div style={s.sources}>
              <button type="button" style={s.sourceToggle} aria-expanded={sourcesExpanded} data-card-sources-toggle onClick={() => setSourcesExpanded(value => !value)}>
                <span>{i18n.t('来源')} · {sourceList.length}</span><span>{sourcesExpanded ? '−' : '+'}</span>
              </button>
              {retrieval && <div style={s.sourcesTitle} data-card-coverage>
                {i18n.t('检索 {{queries}} 个方向 · 阅读 {{pages}} 篇原文', { queries: retrieval.queries.length, pages: retrieval.pagesRead })}
                {retrieval.partial && ` · ${i18n.t('部分检索未完成')}`}
              </div>}
              {retrieval?.digest && <div style={s.sourcesTitle}>{i18n.t('已合并重复报道；仅代表本次检索覆盖范围。')}</div>}
              {sourcesExpanded && sourceList.slice((safeSourcePage - 1) * sourceSize, safeSourcePage * sourceSize).map((item, localIndex) => {
                const index = (safeSourcePage - 1) * sourceSize + localIndex
                return (
                <a data-card-source
                  data-card-source-open={index + 1}
                  key={`${item.url}-${index}`}
                  href={isSafeLink(item.url) ? item.url : undefined}
                  target="_blank" rel="noopener noreferrer"
                  style={s.sourceLink}
                  title={`${i18n.t('在默认浏览器打开')}：${item.title || item.url}\n${item.url}`}
                >
                  <span style={s.sourceNumber}>{index + 1}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: glass.label, fontSize: 12 }}>{item.title || item.url}</span>
                    <span style={{ display: 'block', color: glass.textFaint, fontSize: 10.5, marginTop: 3 }}>{sourceHost(item.url)}{item.publishedAt ? ` · ${item.publishedAt.slice(0, 10)}` : ''}</span>
                    {item.snippet && <span style={s.sourceSnippet}>{item.snippet}</span>}
                  </span>
                </a>
              )})}
              {sourcesExpanded && sourcePages > 1 && <div data-card-source-pagination style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <button type="button" style={s.primaryButton} data-source-prev disabled={safeSourcePage <= 1} onClick={() => setSourcePage(safeSourcePage - 1)}>{i18n.t('上一页')}</button>
                <span style={s.sourcesTitle}>{i18n.t('第 {{page}} / {{total}} 页', { page: safeSourcePage, total: sourcePages })}</span>
                <button type="button" style={s.primaryButton} data-source-next disabled={safeSourcePage >= sourcePages} onClick={() => setSourcePage(safeSourcePage + 1)}>{i18n.t('下一页')}</button>
              </div>}

            </div>
          )}
        </div>

        {tools.length > 0 && (
          <div style={s.chipRow}>
            {tools.map((tool, index) => (
              <span key={`${tool}-${index}`} style={s.chip}>
                {toolLabel(tool)}
              </span>
            ))}
          </div>
        )}

        <div style={s.actionRow}>
          {busy && <button type="button" style={s.primaryButton} data-card-stop onClick={() => bridge().action?.({ id: 'stop', label: i18n.t('停止生成') })}>{i18n.t('停止生成')}</button>}
          <button type="button" style={s.primaryButton} onClick={copyAnswer} disabled={!answer}>
            {copied === 'answer' ? i18n.t('已复制') : i18n.t(data.selection ? '复制结果' : '复制回答')}
          </button>
          {!data.selection && <button type="button" data-card-save-note style={s.primaryButton}
            disabled={busy || saving || !answer.trim() || saved?.question === data.question && saved?.answer === answer} onClick={() => void saveAnswer()}>
            {i18n.t(saving ? '保存中…' : saved?.question === data.question && saved?.answer === answer ? '已保存到随记' : '保存到随记')}
          </button>}
          {actions.filter(action => action.id !== 'copy').map((action, index) => {
              const key = `action-${index}`
              return (
                <button
                  key={key}
                  type="button"
                  style={s.primaryButton}
                  disabled={busy}
                  onClick={() => runAction(action, key)}
                >
                  {copied === key ? i18n.t('已复制') : action.label}
                </button>
              )
            })}
        </div>
        {saveError && <div role="alert" style={{ padding: '0 14px 8px', fontSize: 12, color: glass.dangerFaint }}>{saveError}</div>}
        {voice.error && <div role="alert" style={{ padding: '0 14px 8px', fontSize: 12, color: glass.dangerFaint }}>{voice.error}</div>}

        {!data.selection && <div style={s.askRow}>
          <InputBase
            className="card-ask"
            autoFocus={data.assistant && !data.question}
            value={draft}
            disabled={busy || voice.recording || voice.working}
            placeholder={voice.recording ? i18n.t('正在聆听，点击结束并发送…') : voice.working ? i18n.t('正在识别语音…') : busy ? i18n.t('正在思考…') : data.stopped ? i18n.t('重新提问…') : i18n.t('继续追问…')}
            style={s.askInput}
            inputProps={{ 'aria-label': i18n.t('追问'), style: s.askInputInner }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // Never let Enter reach the app behind the card or submit a form.
              event.preventDefault()
              if (event.nativeEvent.isComposing) return
              submitFollowUp()
            }}
          />
          <button type="button" data-card-voice style={{ ...s.askButton, color: voice.recording ? glass.dangerFaint : glass.accentTint }}
            disabled={busy || voice.working} aria-pressed={voice.recording} onClick={voice.toggle}>
            {i18n.t(voice.recording ? '结束并发送' : voice.working ? '识别中…' : '语音追问')}
          </button>
          {(voice.recording || voice.working) && <button type="button" style={s.askButton} onClick={voice.cancel}>{i18n.t('取消')}</button>}
          <button
            type="button"
            style={{ ...s.askButton, opacity: busy || draft.trim() === '' ? 0.5 : 1 }}
            disabled={busy || voice.recording || voice.working || draft.trim() === ''}
            onClick={submitFollowUp}
          >
            {i18n.t('追问')}
          </button>
        </div>}
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

function sourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function MicIcon({ stroke }: { stroke: string }): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
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

/** Everything the card paints, so a pack swap re-derives one object. */
interface CardStyles {
  baseCss: string
  /** Stroke of the mic glyph that heads the question row. */
  micStroke: string
  stage: React.CSSProperties
  card: React.CSSProperties
  header: React.CSSProperties
  brandRow: React.CSSProperties
  brandDot: React.CSSProperties
  brandText: React.CSSProperties
  headerActions: React.CSSProperties
  iconButton: React.CSSProperties
  questionRow: React.CSSProperties
  questionText: React.CSSProperties
  statusRow: React.CSSProperties
  statusText: React.CSSProperties
  answerBox: React.CSSProperties
  answerTitleRow: React.CSSProperties
  answerMark: React.CSSProperties
  answerTitle: React.CSSProperties
  answerBody: React.CSSProperties
  sources: React.CSSProperties
  sourcesTitle: React.CSSProperties
  sourceLink: React.CSSProperties
  sourceToggle: React.CSSProperties
  sourceNumber: React.CSSProperties
  sourceSnippet: React.CSSProperties
  chipRow: React.CSSProperties
  chip: React.CSSProperties
  actionRow: React.CSSProperties
  primaryButton: React.CSSProperties
  askRow: React.CSSProperties
  askInput: React.CSSProperties
  askInputInner: React.CSSProperties
  askButton: React.CSSProperties
}

/**
 * The card's whole style table, resolved from one skin.
 *
 * Every colour, type face, corner radius and material lives here so a theme pack
 * repaints the card by changing `glass` alone; layout, sizes, spacing and the
 * animation timings stay literals because they are not the pack's business.
 * Classic values are exactly the literals this file used to hard-code.
 */
function cardStyles(g: GlassSkin): CardStyles {
  const baseCss = `
  html, body, #root { margin: 0; height: 100%; background: transparent; overflow: hidden }
  * { box-sizing: border-box }
  button:disabled { opacity: .45; cursor: default !important }
  button:focus-visible, a:focus-visible { outline: 2px solid ${g.accent}; outline-offset: 2px }
  [data-card-source]:hover { background: ${wash(g, .06)} !important }
  ::-webkit-scrollbar { width: 6px; height: 6px }
  ::-webkit-scrollbar-thumb {
    background: ${wash(g, .14)}; border-radius: 8px;
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
    width: 4px; height: 4px; border-radius: 99px; background: ${g.textFaint};
    animation: cardDot 1.2s ease-in-out infinite;
  }
  .card-dots > span:nth-child(2) { animation-delay: .15s }
  .card-dots > span:nth-child(3) { animation-delay: .3s }

  .card-ask {
    border: ${g.borderWidth}px solid ${wash(g, .10)};
    background: ${wash(g, .04)};
    border-radius: ${g.radiusSm}px;
    padding: 3px 8px;
    transition: border-color .15s ease;
  }
  .card-ask:focus-within { border-color: ${accentWash(g, .45)} }
  .card-ask.Mui-disabled { opacity: .6 }
  .card-ask input::placeholder { color: ${g.textFaint}; opacity: 1 }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important } }
`

  return {
    baseCss,
    micStroke: g.iconStroke,
    stage: {
      // Flex-end keeps the card glued to the bottom edge of the window — the edge
      // that faces the pill — even when the main process enlarged the window before
      // the content grew (or clamped it at CARD_MIN_HEIGHT for a short answer).
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      height: '100%',
      padding: STAGE_PADDING,
      fontFamily: g.font
    } as React.CSSProperties,
    card: {
      display: 'flex',
      flexDirection: 'column',
      // Height follows the content; the window is resized to match, so growing
      // answers push the card upwards away from the pill.
      height: 'auto',
      maxHeight: '100%',
      minHeight: 0,
      borderRadius: g.radiusPanel,
      background: g.cardSurface,
      backdropFilter: g.frostedPanel,
      WebkitBackdropFilter: g.frostedPanel,
      border: `${g.borderWidth}px solid ${wash(g, .10)}`,
      color: g.text,
      overflow: 'hidden',
      // The card is anchored above the pill: it should rise out of the bar.
      transformOrigin: 'bottom center',
      // No shadow: the window is transparent and shadowless, a CSS shadow here
      // would paint a dark ring around the card.
      boxShadow: 'none'
    } as React.CSSProperties,
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 40,
      padding: '0 10px 0 14px',
      flex: '0 0 auto',
      borderBottom: `${g.borderWidth}px solid ${wash(g, .06)}`,
      WebkitAppRegion: 'drag'
    } as React.CSSProperties,
    brandRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    },
    brandDot: {
      width: 7,
      height: 7,
      borderRadius: 99,
      background: g.accent
    },
    brandText: {
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: 0.2,
      color: g.label
    },
    headerActions: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      WebkitAppRegion: 'no-drag'
    } as React.CSSProperties,
    iconButton: {
      width: 24,
      height: 24,
      display: 'grid',
      placeItems: 'center',
      borderRadius: 6,
      border: 'none',
      background: 'transparent',
      color: g.textFaint,
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
      WebkitAppRegion: 'no-drag'
    } as React.CSSProperties,
    questionRow: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '12px 14px 8px',
      flex: '0 0 auto'
    },
    questionText: {
      flex: 1,
      minWidth: 0,
      fontSize: 12.5,
      lineHeight: 1.5,
      color: g.textDim,
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden'
    } as React.CSSProperties,
    statusRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 14px 8px',
      flex: '0 0 auto',
      minHeight: 18
    },
    statusText: {
      fontSize: 12,
      lineHeight: 1.4,
      color: g.textFaint
    },
    answerBox: {
      flex: '0 1 auto',
      minHeight: 0,
      padding: '10px 16px 12px',
      overflowY: 'auto',
      userSelect: 'text'
    },
    answerTitleRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      marginBottom: 6
    },
    answerMark: {
      fontSize: 11,
      color: g.accent
    },
    answerTitle: {
      fontSize: 11,
      letterSpacing: 0.6,
      color: g.textFaint
    },
    answerBody: {
      // The body itself no longer sets type: MarkdownView owns the scale, spacing and
      // inline styling, and the scroll box only has to keep the text selectable.
      color: g.text,
      wordBreak: 'break-word',
      userSelect: 'text'
    },
    sources: {
      marginTop: 10,
      paddingTop: 8,
      borderTop: `${g.borderWidth}px solid ${wash(g, .06)}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 3
    },
    sourcesTitle: {
      fontSize: 10.5,
      letterSpacing: 0.5,
      color: g.textFaint,
      marginBottom: 2
    },
    sourceLink: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 9,
      padding: '9px 8px',
      borderRadius: g.radiusSm,
      background: wash(g, .025),
      textDecoration: 'none',
    },
    sourceToggle: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      width: '100%', padding: '3px 0 6px', color: g.textDim, background: 'transparent', border: 0, fontSize: 12, cursor: 'pointer'
    },
    sourceNumber: {
      flex: '0 0 22px', textAlign: 'center', padding: '2px 0', border: `${g.borderWidth}px solid ${accentWash(g, .25)}`, borderRadius: 5, color: g.accent, fontSize: 11
    },
    sourceSnippet: {
      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 11.5, lineHeight: 1.5, color: g.textDim, marginTop: 4
    } as React.CSSProperties,
    chipRow: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      padding: '8px 14px 0',
      flex: '0 0 auto'
    },
    chip: {
      padding: '1px 7px',
      borderRadius: 99,
      border: `${g.borderWidth}px solid ${wash(g, .08)}`,
      background: wash(g, .04),
      color: g.textDim,
      fontSize: 10.5,
      lineHeight: 1.6
    },
    actionRow: {
      display: 'flex',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: 8,
      padding: '8px 14px 0',
      borderTop: `${g.borderWidth}px solid ${wash(g, .06)}`,
      flex: '0 0 auto'
    },
    primaryButton: {
      padding: '5px 12px',
      borderRadius: g.radiusSm,
      border: `${g.borderWidth}px solid ${accentWash(g, .35)}`,
      background: accentWash(g, .16),
      color: g.accentTint,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer'
    },
    askRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px 12px',
      flex: '0 0 auto'
    },
    askInput: {
      flex: 1,
      minWidth: 0,
      fontSize: 12.5,
      color: g.text
    },
    askInputInner: {
      padding: '2px 0',
      color: g.text
    },
    askButton: {
      flex: '0 0 auto',
      padding: '5px 12px',
      borderRadius: g.radiusSm,
      border: `${g.borderWidth}px solid ${accentWash(g, .35)}`,
      background: accentWash(g, .16),
      color: g.accentTint,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer'
    }
  }
}
