import type { BarAlert, BarAlertLevel, BarState } from '@shared/types'

/**
 * One level's worth of colour, kept in a single place so the dot, the copy, the
 * buttons and the pill border can never drift apart.
 *
 * The bar sits on top of the user's desktop with a near-black glass pill, so
 * every tone is a *light* accent tinted toward its hue: readable at 11.5px on
 * `rgba(18,19,23,.94)` without turning the pill into a traffic light.
 */
export interface AlertTone {
  /** Dot and button foreground. */
  accent: string
  /** Alert copy. */
  text: string
  /** Button fill — a low-alpha wash of `accent`. */
  tint: string
  /** Pill hairline, so the capsule itself carries the severity. */
  border: string
}

const TONES: Record<BarAlertLevel, AlertTone> = {
  // info — blue
  info: {
    accent: '#7f9dff',
    text: '#dbe4ff',
    tint: 'rgba(127,157,255,.16)',
    border: 'rgba(127,157,255,.42)'
  },
  // warn — amber
  warn: {
    accent: '#f0b64a',
    text: '#ffe6b8',
    tint: 'rgba(240,182,74,.16)',
    border: 'rgba(240,182,74,.45)'
  },
  // error — red
  error: {
    accent: '#ef6b6b',
    text: '#ffc6c6',
    tint: 'rgba(239,107,107,.18)',
    border: 'rgba(239,107,107,.48)'
  }
}

/**
 * Tone for a level. A main process that ships an unknown level must not get an
 * invisible alert, so anything unrecognised falls back to `info` (blue).
 */
export function alertTone(level: BarAlertLevel | string | undefined): AlertTone {
  if (level === 'warn') return TONES.warn
  if (level === 'error') return TONES.error
  return TONES.info
}

/**
 * The alert a state wants rendered, if any.
 *
 * Two phases carry one: `alert` (non-fatal notices such as `busy`) and `error`
 * (a failure that also gets retry/settings buttons). Everything else returns
 * `null`, which is also the signal for the legacy red-text error rendering.
 */
export function alertOf(state: BarState): BarAlert | null {
  if (state.phase === 'alert') return state.alert ?? null
  if (state.phase === 'error') return state.alert ?? null
  return null
}

/**
 * Whether the current state puts real buttons on screen.
 *
 * Existing notices stay passive. A newly created reminder alone offers an Undo
 * button, so the bar only receives clicks during that short confirmation.
 */
export function hasAlertActions(state: BarState): boolean {
  if (state.phase === 'done' && state.feedback) return true
  const alert = alertOf(state)
  return alert?.kind === 'reminder'
}

export interface AlertRowProps {
  alert: BarAlert
  /** Hover copy; the error phase passes its untruncated message here. */
  title?: string
}

/**
 * The alert half of the pill: level dot, clamped copy, action buttons.
 *
 * Rendered as a fragment (not a wrapper) because the pill is already the flex
 * container with the shared `gap`; a nested flex box would double the spacing
 * and fight the mode tag for width. Between the 60px window, the 8px stage
 * padding and the 38px pill there are ~22px of vertical room, so the copy is
 * clamped to two 15px lines and the buttons stay a single 22px row.
 */
export function AlertRow({ alert, title }: AlertRowProps): JSX.Element {
  const tone = alertTone(alert.level)
  return (
    <>
      <span style={{ ...dotStyle, background: tone.accent, opacity: 1 }} />
      <span style={{ ...textStyle, color: tone.text }} title={title ?? alert.text}>
        {alert.text}
      </span>
      {alert.kind === 'reminder' && alert.actions?.filter(action => action.id === 'undo-reminder').map(action =>
        <button key={action.id} data-bar-action={action.id} onClick={() => window.api.bar.action(action.id)}
          style={{ flexShrink: 0, border: 'none', borderRadius: 6, background: tone.tint, color: tone.accent,
            padding: '4px 7px', fontSize: 11, cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{action.label}</button>)}
    </>
  )
}

const dotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 99,
  flex: '0 0 auto'
}

/**
 * Two clamped lines, ellipsised. `-webkit-box` is the only display mode that
 * honours `-webkit-line-clamp`, and the explicit `maxHeight` is the belt to
 * that braces: a stale engine that ignores the clamp still cannot push the pill
 * past its 38px.
 */
const textStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  wordBreak: 'break-word',
  lineHeight: '15px',
  maxHeight: 30,
  fontSize: 11.5
}
