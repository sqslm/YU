import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BarState, BarWindowLayout, Mode, Settings } from '@shared/types'
import { AlertRow, alertOf, alertTone, hasAlertActions } from './AlertRow'
import { MicCapture } from './capture'
import { disposeCues, playCue } from './cues'
import { CaptionTicker } from './CaptionTicker'
import i18n, { applyUiLanguage } from '../i18n'

/**
 * Mode tags are translated at render time rather than in a module constant:
 * this window never reloads, so a constant would keep the language it was
 * first evaluated with after the user switches languages.
 */
function modeLabel(mode: Mode): string {
  if (mode === 'translate') return i18n.t('翻译')
  if (mode === 'ask') return i18n.t('问答')
  return i18n.t('听写')
}

/** Mode assumed when a bar state arrives without one (old main process). */
const FALLBACK_MODE: Mode = 'dictation'

/**
 * The "current mode" tag the bar shows to the right of its own content.
 *
 * Only the three phases that carry a mode can show it: `idle` is the 40×6
 * strip with nothing to label, and `error` has no mode at all. `null` (not
 * `''`) is the "no tag" answer so the JSX call site can tell it apart from a
 * genuinely empty label.
 */
export function modeLabelFor(state: BarState, showMode: boolean): string | null {
  if (!showMode) return null
  switch (state.phase) {
    case 'recording':
    case 'working':
    case 'done': {
      if ('taskLabel' in state && state.taskLabel) return state.taskLabel
      // `mode` is required by the type but not by a stale main process, so the
      // lookup keeps a runtime default instead of trusting the declaration.
      const mode = (state as { mode?: Mode }).mode
      return modeLabel(mode ?? FALLBACK_MODE)
    }
    default:
      return null
  }
}

/**
 * The floating pill.
 *
 * Idle it is a 40×6 invisible bar hugging the bottom centre of the screen, the
 * way the reference app parks its bar; once recording starts it grows into a
 * rounded glass pill with a live waveform, then collapses again.
 */
export function Bar(): JSX.Element {
  const [state, setState] = useState<BarState>({ phase: 'idle' })
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [caption, setCaption] = useState<{ active: boolean; text: string; unavailable?: boolean }>({ active: false, text: '' })
  const [layout, setLayout] = useState<BarWindowLayout>({ barTop: 0, captionSide: 'above' })
  // Defaults to the shipped default (`showModeInBar: true`) so the tag does not
  // pop in a frame late while the first settings round-trip is in flight.
  const [showMode, setShowMode] = useState(true)
  const captureRef = useRef<MicCapture | null>(null)
  // Phase mirror for cue transitions, and the user's cue switch.
  const stateRef = useRef<BarState>({ phase: 'idle' })
  const soundsRef = useRef(true)

  const capture = useMemo(() => {
    const instance = new MicCapture({
      onChunk: (chunk) => window.api.bar.sendAudio(chunk),
      onLevel: (value) => setLevel(value),
      onError: (message) => window.api.bar.error(message),
      onDevices: (devices) => window.api.bar.devices(devices),
      onFormat: (format) => window.api.bar.log(`capture input=${format.sampleRate ?? 'unknown'}Hz channels=${format.channelCount ?? 'unknown'} noise=${format.noiseSuppression ?? 'unknown'} gain=${format.autoGainControl ?? 'unknown'} echo=${format.echoCancellation ?? 'unknown'}`),
      // The compressed copy arrives before `stopped()`, so main already holds it
      // when it decides which form to upload.
      onEncoded: (payload) => window.api.bar.encoded(payload.data, payload.contentType)
    })
    captureRef.current = instance
    return instance
  }, [])

  useEffect(() => {
    // Warm the microphone as soon as the bar exists so the first press does not
    // lose its first words to device-open latency.
    void capture.start().then(
      () => window.api.bar.log('capture warm'),
      (err: unknown) => window.api.bar.error(`warm failed: ${String(err)}`)
    )

    // The bar already pulls settings for the microphone, so the mode toggle rides
    // along on that existing channel — no preload or main-process change needed.
    const applySettings = (settings: Settings): void => {
      applyUiLanguage(settings.uiLanguage)
      void capture.setDevice(settings.inputDeviceId, settings.audioProcessing)
      setShowMode(settings.showModeInBar)
      soundsRef.current = settings.playSounds
    }
    void window.api.settings.get().then(applySettings, () => undefined)
    const offSettings = window.api.settings.onChanged(applySettings)

    const offState = window.api.bar.onState((next) => {
      const previous = stateRef.current.phase
      stateRef.current = next
      setState(next)
      if (next.phase !== 'recording') setCaption({ active: false, text: '' })
      // A notice that carries buttons needs real clicks; every other frame stays
      // click-through, so the pill never eats the pointer it floats over. Without
      // this the alert's 「知道了」 drew a button that could not be pressed.
      window.api.bar.interactive(hasAlertActions(next))
      // Cues fire on transitions only: a repeated `recording` frame (waveform
      // updates) must not re-beep.
      if (next.phase !== previous) {
        if (next.phase === 'recording') playCue('start', soundsRef.current)
        else if (next.phase === 'done') playCue(next.feedback?.failed ? 'error' : 'done', soundsRef.current)
        else if (next.phase === 'error') playCue('error', soundsRef.current)
      }
      if (next.phase === 'recording') {
        void capture.setActive(true)
        void capture.start()
      }
      if (next.phase === 'idle') {
        // Idle means the take was cancelled or discarded, so the drained tail is
        // dropped instead of being attributed to the next sentence.
        void capture.setActive(false, false)
        setLevel(0)
      }
    })
    const offCaption = window.api.bar.onCaption(setCaption)
    const offLayout = window.api.bar.onLayout(setLayout)

    const offStop = window.api.bar.onStop(async () => {
      // Wait for the worklet's partial block before confirming the stop: `main`
      // only starts concatenating once we answer, so a hasty `stopped()` truncates
      // the last syllable of every take.
      await capture.setActive(false)
      window.api.bar.stopped()
    })

    return () => {
      offSettings()
      offState()
      offCaption()
      offLayout()
      offStop()
      disposeCues()
      void capture.stop()
    }
  }, [capture])

  const since = state.phase === 'recording' ? state.since : 0

  useEffect(() => {
    if (state.phase !== 'recording' || !since) return
    const id = setInterval(() => setElapsed(Date.now() - since), 100)
    return () => clearInterval(id)
  }, [state.phase, since])

  // Either phase may carry an alert; `error` without one keeps the legacy red
  // line, which is why the render site checks `alert` instead of the phase.
  const alert = alertOf(state)
  const phase = state.phase
  const promptName = phase === 'recording' || phase === 'working' ? state.promptName : undefined
  const showCaption = phase === 'recording' && caption.active && Boolean(caption.text)
  const feedback = phase === 'done' ? state.feedback : undefined
  const feedbackText = phase === 'done' && feedback ? state.text : alert?.kind === 'reminder' ? alert.text : ''
  const showBubble = showCaption || Boolean(feedbackText)
  useLayoutEffect(() => { window.api.bar.captionVisible(showBubble) }, [showBubble])
  useEffect(() => () => window.api.bar.captionVisible(false), [])
  // A main process that knows the flag can ship it with the state itself; the
  // settings channel is the fallback so the tag also works without that.
  const showModeFromState =
    'showMode' in state && typeof state.showMode === 'boolean' ? state.showMode : undefined
  const modeLabel = modeLabelFor(state, showModeFromState ?? showMode)

  // Start click-through. State updates temporarily enable the reminder Undo
  // action; recording and other notices keep passing clicks to the editor.
  useEffect(() => {
    window.api.bar.interactive(false)
  }, [])

  return (
    <div
      style={
        {
          ...stage,
          // A `drag` region is hit-tested as a window caption and swallows the
          // click before the pill's own buttons see it, so the pill only gives
          // up the drag handle while it actually shows buttons.
          WebkitAppRegion: 'drag'
        } as React.CSSProperties
      }
    >
      <style>{`
        html, body, #root { margin: 0; height: 100%; background: transparent; overflow: hidden }
        * { box-sizing: border-box }
        @keyframes barwave { 0%,100% { transform: scaleY(.35) } 50% { transform: scaleY(1) } }
        @keyframes barfade { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
        @keyframes barpulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
        @keyframes caption-enter { from { opacity: 0; max-width: 0; transform: translate(7px,5px) scale(.9) } to { opacity: 1; max-width: 2em; transform: translate(0,0) scale(1) } }
        @keyframes caption-launch { from { opacity: 0; transform: translateY(var(--caption-launch-y)) scale(.35,.3) } to { opacity: 1; transform: translateY(0) scale(1) } }
        @media (prefers-reduced-motion: reduce) { [data-caption-glyph], [data-caption-bubble] { animation: none !important } }
        .bar-alert-action { transition: filter .12s ease, transform .08s ease }
        .bar-alert-action:hover { filter: brightness(1.32) }
        .bar-alert-action:active { transform: translateY(.5px) }
        .bar-alert-action:focus-visible { outline: none }
      `}</style>

      <div data-bar-strip style={{ position: 'absolute', left: 0, top: layout.barTop, width: 340, height: 60,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 8 }}>
      <div style={{ position: 'relative', maxWidth: 300, ...(feedbackText ? { minWidth: 264 } : {}) }}>
      {showBubble && (layout.barTop > 0 || layout.captionSide === 'below') && <div data-caption-bubble data-task-feedback={feedbackText ? true : undefined} data-caption-side={layout.captionSide}
        style={{ ...captionBubble, ...(layout.captionSide === 'above' ? { bottom: 48 } : { top: 48 }),
          '--caption-launch-y': layout.captionSide === 'above' ? '42px' : '-42px',
          transformOrigin: `center ${layout.captionSide === 'above' ? 'bottom' : 'top'}` } as React.CSSProperties & { '--caption-launch-y': string }}>
        {feedbackText ? <span title={feedbackText} role="status" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-line', fontSize: 12, lineHeight: '15px',
          color: feedback?.failed ? '#ffc6c6' : undefined }}>{feedbackText}</span> : <CaptionTicker text={caption.text} />}
        <span aria-hidden="true" style={{ position: 'absolute', left: 'calc(50% - 4.5px)',
          ...(layout.captionSide === 'above' ? { bottom: -5, borderRight: '1px solid rgba(255,255,255,.12)', borderBottom: '1px solid rgba(255,255,255,.12)' }
            : { top: -5, borderLeft: '1px solid rgba(255,255,255,.12)', borderTop: '1px solid rgba(255,255,255,.12)' }),
          width: 9, height: 9, transform: 'rotate(45deg)', background: '#202228' }} />
      </div>}
      {phase === 'idle' && <div style={idlePill} />}

      {phase !== 'idle' && (
        <div
          data-recording-pill
          style={{
            ...pill,
            // The alert owns the hairline while it is up (its level colours the
            // whole capsule); a bare `error` keeps the original red, and every
            // other phase stays borderless so the pill melts into the desktop.
            borderColor: alert
              ? alertTone(alert.level).border
              : phase === 'error'
                ? 'rgba(239,95,95,.45)'
                : phase === 'recording'
                  ? 'rgba(255,255,255,.10)'
                  : 'transparent',
            // Buttons need room: 340px window, 8px stage padding a side.
            maxWidth: pill.maxWidth,
            animation: 'barfade .18s ease-out'
          }}
        >
          {phase === 'recording' && (
            <>
              <span data-caption-unavailable={caption.unavailable || undefined} title={caption.unavailable ? i18n.t('字幕暂不可用') : undefined}
                style={{ ...dot, ...(caption.unavailable ? { background: '#cf9b52' } : {}), animation: 'barpulse 1.4s ease-in-out infinite' }} />
              <div data-recording-wave style={wave}>
                {Array.from({ length: 16 }).map((_, index) => {
                  const center = 7.5
                  const distance = Math.abs(index - center) / center
                  const base = 4 + 13 * level
                  const height = Math.max(3, base * (1 - distance * 0.5))
                  return (
                    <span
                      key={index}
                      style={{
                        width: 2.5,
                        height,
                        borderRadius: 2,
                        background: '#c9d4ff',
                        animation: `barwave ${0.7 + (index % 5) * 0.09}s ease-in-out infinite`
                      }}
                    />
                  )
                })}
              </div>
              {/* The mode text lives in the right-hand tag so the
                  `showModeInBar` switch controls it in one place. */}
              <span style={timer}>{(elapsed / 1000).toFixed(1)}s</span>
            </>
          )}

          {phase === 'working' && (
            <>
              <span style={{ ...dot, background: '#8f9bd6' }} />
              <span style={{ ...label, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{state.hint ?? i18n.t('处理中…')}</span>
            </>
          )}

          {phase === 'done' && <span style={{ ...result, ...(feedback?.failed ? { color: '#ffc6c6' } : {}) }}>
            {feedback ? i18n.t(feedback.failed ? '任务失败' : '已完成') : truncate(state.text)}</span>}


          {/* A failure that carries an alert gets the same row as the notice
              phase — dot, clamp, buttons — so retry/open-settings are always in
              the same place; a bare error keeps the legacy red line. */}
          {phase === 'error' &&
            (state.alert ? (
              <AlertRow alert={state.alert} title={state.message} />
            ) : (
              <span style={{ ...result, color: '#ffb3b3' }}>{truncate(state.message)}</span>
            ))}

          {/* Non-fatal notices: busy, network advice, cancelled, session cap. */}
          {phase === 'alert' && alert && <AlertRow alert={feedbackText ? { ...alert, text: i18n.t('快速提醒') } : alert} title={alert.text} />}
          {feedbackText && <button data-bar-action="dismiss" aria-label={i18n.t('关闭')} style={feedbackButton}
            onClick={() => window.api.bar.action('dismiss')}>×</button>}

          {promptName && <span data-bar-prompt title={promptName} aria-label={promptName} style={promptTag}>{promptName}</span>}

          {/* Always the right-most child: `modeLabelFor` returns null for idle
              and error, so nothing is appended in those phases. */}
          {modeLabel && <span style={modeTag}>{modeLabel}</span>}
        </div>
      )}
      </div>
      </div>
    </div>
  )
}

function truncate(text: string): string {
  return text.length > 64 ? `${text.slice(0, 64)}…` : text
}

const stage: React.CSSProperties = {
  height: '100%',
  position: 'relative',
  fontFamily: '"Inter", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  WebkitAppRegion: 'drag'
} as React.CSSProperties

const captionBubble: React.CSSProperties = {
  position: 'absolute', left: -14, width: 'calc(100% + 28px)', maxWidth: 324, height: 42,
  display: 'flex', alignItems: 'center', padding: '0 16px', borderRadius: 12,
  color: '#eef1f7', background: '#202228', border: '1px solid rgba(255,255,255,.12)',
  boxShadow: '0 3px 10px rgba(0,0,0,.12)', animation: 'caption-launch .24s cubic-bezier(.2,.8,.25,1) both'
}

const feedbackButton: React.CSSProperties = {
  flexShrink: 0, border: 'none', borderRadius: 6, background: 'rgba(127,157,255,.16)', color: '#b8c9ff',
  padding: '4px 7px', fontSize: 11, cursor: 'pointer', WebkitAppRegion: 'no-drag'
} as React.CSSProperties

const idlePill: React.CSSProperties = {
  width: 40,
  height: 6,
  borderRadius: 99,
  background: 'rgb(128,128,128)',
  opacity: 0.18,
  // The window is transparent and shadowless: any shadow here would ring the
  // pill with a dark halo on the desktop.
  boxShadow: 'none',
  transition: 'opacity .2s cubic-bezier(.05,.6,.4,.95)'
}

const pill: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 38,
  maxWidth: 300,
  padding: '0 14px',
  borderRadius: 99,
  background: 'rgba(18,19,23,.94)',
  // Only the recording state keeps a hairline border; everything else is
  // borderless so the pill melts into the desktop.
  border: '1px solid transparent',
  boxShadow: 'none',
  backdropFilter: 'blur(14px)',
  color: '#eef1f7',
  fontSize: 12,
  overflow: 'hidden'
}

const dot: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 99,
  background: '#7f96ff',
  flex: '0 0 auto'
}

const wave: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  height: 22,
  flex: '0 0 auto'
}

const label: React.CSSProperties = {
  fontSize: 11.5,
  color: '#b6bdcb',
  whiteSpace: 'nowrap'
}

const timer: React.CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontSize: 11,
  color: '#7f8593'
}

const promptTag: React.CSSProperties = {
  fontSize: 10.5, lineHeight: '18px', color: '#bbc5e7', background: 'rgba(127,150,255,.08)',
  border: '1px solid rgba(127,150,255,.18)', borderRadius: 5, padding: '0 6px',
  minWidth: 0, maxWidth: 80, flex: '0 1 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
}

/**
 * The optional "current mode" tag. Deliberately the cheapest thing in the pill:
 * fixed-size, capped at 72 px and never asked to give up width, so a long
 * transcript or hint (which already ellipsise) is what shrinks first. The
 * `overflow`/`textOverflow` pair is the backstop for a label that outgrows the
 * cap: it ellipsises inside its own box instead of bursting the 272 px capsule.
 * No shadow, per the borderless bar style.
 */
const modeTag: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.02em',
  opacity: 0.72,
  color: '#9aa3b5',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: '0 0 auto',
  maxWidth: 72,
  boxShadow: 'none'
}

const result: React.CSSProperties = {
  fontSize: 11.5,
  color: '#c8cdd8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
}
