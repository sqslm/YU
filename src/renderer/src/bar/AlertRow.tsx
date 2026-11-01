import type { BarAlert, BarAlertLevel, BarState, ThemePack } from '@shared/types'

/**
 * One level's worth of colour, kept in a single place so the dot, the copy, the
 * buttons and the pill border can never drift apart.
 *
 * The bar sits on top of the user's desktop with a near-black glass pill, so
 * every tone is a *light* accent tinted toward its hue: readable at 11.5px on
 * `rgba(18,19,23,.94)` without turning the pill into a traffic light.
 *
 * That reasoning is what makes the tones pack-specific: the Apple pack paints a
 * *white* sheet in light mode, where those pale tints would disappear, so it
 * carries its own set below.
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

export type AlertTones = Record<BarAlertLevel, AlertTone>

const CLASSIC_TONES: AlertTones = {
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
 * Apple's system status colours, at the two weights the material needs.
 *
 * On the dark glass the copy is a *lightened* tint, exactly like the classic
 * set; on the light sheet it is a darkened one, because pale blue on white is
 * unreadable at 11.5px. Fills stay a 10–18% wash of the same hue in both.
 */
const APPLE_TONES: Record<'dark' | 'light', AlertTones> = {
  dark: {
    info: { accent: '#0a84ff', text: '#9fc6ff', tint: 'rgba(10,132,255,.18)', border: 'rgba(10,132,255,.42)' },
    warn: { accent: '#ffd60a', text: '#ffe9a8', tint: 'rgba(255,214,10,.16)', border: 'rgba(255,214,10,.44)' },
    error: { accent: '#ff453a', text: '#ffb4ae', tint: 'rgba(255,69,58,.18)', border: 'rgba(255,69,58,.48)' }
  },
  light: {
    info: { accent: '#0071e3', text: '#0055a4', tint: 'rgba(0,113,227,.10)', border: 'rgba(0,113,227,.38)' },
    warn: { accent: '#b25000', text: '#8a3d00', tint: 'rgba(255,159,10,.14)', border: 'rgba(178,80,0,.34)' },
    error: { accent: '#d70015', text: '#b00012', tint: 'rgba(215,0,21,.10)', border: 'rgba(215,0,21,.38)' }
  }
}

/**
 * Brutalist tones.
 *
 * This pack is the reason the tone set had to become pack- *and* mode-aware:
 * its capsule is opaque bone paper in light mode and coal in dark mode, so the
 * shipped pale-on-dark tints vanish on the light capsule — which is exactly the
 * "the text is invisible" report for the prompt-card switcher. Light keeps
 * darkened ink on paper, dark keeps lifted tints on coal.
 */
const BRUTAL_TONES: Record<'dark' | 'light', AlertTones> = {
  dark: {
    info: { accent: '#8ab4ff', text: '#cddaff', tint: 'rgba(138,180,255,.16)', border: 'rgba(138,180,255,.45)' },
    warn: { accent: '#ffd400', text: '#ffe9a8', tint: 'rgba(255,212,0,.16)', border: 'rgba(255,212,0,.45)' },
    error: { accent: '#ff5f56', text: '#ffc6c6', tint: 'rgba(255,95,86,.18)', border: 'rgba(255,95,86,.5)' }
  },
  light: {
    info: { accent: '#0047ff', text: '#002ba8', tint: 'rgba(0,71,255,.10)', border: 'rgba(0,71,255,.42)' },
    warn: { accent: '#8a4b00', text: '#6b3a00', tint: 'rgba(255,159,10,.16)', border: 'rgba(138,75,0,.42)' },
    error: { accent: '#b3120b', text: '#8f0f09', tint: 'rgba(179,18,11,.10)', border: 'rgba(179,18,11,.45)' }
  }
}

/** The tone set a pack paints with; anything unknown keeps the shipped one. */
export function alertTonesFor(pack: ThemePack | undefined, mode: 'dark' | 'light'): AlertTones {
  if (pack === 'apple') return APPLE_TONES[mode]
  if (pack === 'brutal') return BRUTAL_TONES[mode]
  return CLASSIC_TONES
}

/**
 * Tone for a level. A main process that ships an unknown level must not get an
 * invisible alert, so anything unrecognised falls back to `info` (blue).
 *
 * `tones` defaults to the shipped set, so a caller that predates theme packs —
 * and the existing unit tests — keep the original colours.
 */
export function alertTone(level: BarAlertLevel | string | undefined, tones: AlertTones = CLASSIC_TONES): AlertTone {
  if (level === 'warn') return tones.warn
  if (level === 'error') return tones.error
  return tones.info
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
  /** Level colours for the active theme pack; defaults to the shipped set. */
  tones?: AlertTones
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
export function AlertRow({ alert, title, tones }: AlertRowProps): JSX.Element {
  const tone = alertTone(alert.level, tones)
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
