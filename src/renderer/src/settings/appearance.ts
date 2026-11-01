import type { Settings, ThemeMode, ThemePack } from '@shared/types'

/**
 * Appearance layer: palettes, theme packs and the colours of the floating
 * surfaces.
 *
 * Deliberately **free of MUI imports**. Every overlay window (recording bar,
 * answer card) renders plain inline styles, and importing `theme.ts` there would
 * drag `@mui/material/styles` — a few hundred kilobytes of design system the
 * overlay never uses — into a bundle that has to appear in a couple of frames.
 * `theme.ts` builds the MUI themes on top of this module and re-exports it, so
 * call sites can keep importing from either name.
 */

/** Warm neutral surfaces and jade accents shared by the desktop renderers. */
export interface Tokens {
  canvas: string
  sidebar: string
  surface: string
  surfaceHi: string
  line: string
  text: string
  textDim: string
  textFaint: string
  accent: string
  accentSoft: string
  danger: string
  shadow: string
}

export const palettes: Record<'dark' | 'light', Tokens> = {
  dark: {
    canvas: '#191c1a',
    sidebar: '#141715',
    surface: '#202421',
    surfaceHi: '#2a302c',
    line: 'rgba(224,235,224,.10)',
    text: '#eef1e9',
    textDim: '#abb5ac',
    textFaint: '#909d92',
    accent: '#9bd6bb',
    accentSoft: 'rgba(155,214,187,.11)',
    danger: '#f0948c',
    shadow: '0 20px 64px rgba(0,0,0,.32)'
  },
  light: {
    canvas: '#f5f5f0',
    sidebar: '#eeefe8',
    surface: '#fdfdf9',
    surfaceHi: '#e9ece4',
    line: 'rgba(35,53,42,.11)',
    text: '#25352b',
    textDim: '#616e62',
    textFaint: '#64705f',
    accent: '#28664c',
    accentSoft: 'rgba(40,102,76,.09)',
    danger: '#b3443b',
    shadow: '0 20px 64px rgba(35,53,42,.13)'
  }
}

/** Backwards-compatible default export used by every renderer module. */
export const tokens = palettes.dark

/** Media query the OS answers with its own light/dark choice. */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Which palette a stored preference paints with.
 *
 * `'system'` asks the browser rather than a timer or a clock: Chromium already
 * tracks Windows' light/dark setting, and main's `nativeTheme` reads the same
 * source, so the page and the native window buttons agree.
 */
export function resolveThemeMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/** Calls back when the OS flips appearance; returns the unsubscribe function. */
export function onSystemThemeChange(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

/* ------------------------------------------------------------------------- *
 * Theme packs
 *
 * A pack is one *visual language*, and it is deliberately orthogonal to
 * `themeMode`: every pack carries its own dark and light palette, its own type
 * stack and its own geometry. The two dials compose, so 设置 → 外观 keeps two
 * independent controls instead of turning them into a menu of four fixed skins.
 *
 * `classic` is the palette this app shipped with. Its `Skin` is built by
 * spreading `palettes` above and reusing the same numbers and font stack the
 * original `makeTheme` hard-coded, so an install that never opens the pack
 * picker renders pixel-identically to the build before packs existed.
 * ------------------------------------------------------------------------- */

/**
 * Everything a pack decides beyond raw colour: the type stack, the corner
 * geometry, the material filter, and the pair used by a *filled* control.
 */
export interface Skin extends Tokens {
  /** Corner radius of a small floating surface (the caption bubble). */
  radius: number
  /** Corner radius of a large panel (the answer card, dialogs). */
  radiusPanel: number
  /** Corner radius of controls: buttons, fields, menu rows. */
  radiusSm: number
  /** Whole-application font stack. */
  font: string
  /** `backdrop-filter` value for translucent surfaces; `'none'` keeps them flat. */
  frost: string
  /** Fill of a primary/contained button. */
  accentFill: string
  /** Ink that sits on `accentFill`. */
  accentInk: string
  /** Switch / success colour; the shipped pack reuses the accent. */
  positive: string
  /** Stroke width of component borders, in px. Brutalism draws 2–3 px rules. */
  borderWidth: number
}

const CLASSIC_FONT =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'

/**
 * Apple's system stack first, then the Windows faces that sit closest to it.
 * Nothing is downloaded — the CSP allows `'self'` only — so on a Mac this is the
 * real SF Pro, and on Windows it degrades to Segoe UI Variable, which is the
 * same face the shipped pack already uses.
 */
const APPLE_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'

/** The shipped pack: the palette above plus the numbers the original theme used. */
function classicSkin(mode: 'dark' | 'light'): Skin {
  return {
    ...palettes[mode],
    radius: 12,
    radiusPanel: 14,
    radiusSm: 9,
    font: CLASSIC_FONT,
    frost: 'none',
    // The original theme painted a contained button with the accent itself.
    accentFill: palettes[mode].accent,
    accentInk: mode === 'dark' ? '#14271d' : '#ffffff',
    positive: palettes[mode].accent,
    borderWidth: 1
  }
}

/**
 * Apple-flavoured pack.
 *
 * Light is macOS Sonoma: `#f5f5f7` window chrome, white content cards, the
 * `#0071e3` system blue for filled controls and separators at ~16% grey.
 * Dark is `#1c1c1e` chrome with `#2c2c2e` cards and `#0a84ff`, the dark-mode
 * variant of the same blue, because the light blue is unreadable on near-black.
 * Text roles follow the HIG ramp exactly (label / secondary / tertiary).
 */
const APPLE: Record<'dark' | 'light', Skin> = {
  light: {
    canvas: '#f5f5f7',
    // Translucent so the CSS `backdrop-filter` in `makeAppleTheme` has something
    // to frost; over the opaque canvas it still resolves to a light sidebar.
    sidebar: 'rgba(244,244,247,.82)',
    surface: '#ffffff',
    surfaceHi: '#eeeef2',
    line: 'rgba(60,60,67,.16)',
    text: '#1d1d1f',
    textDim: '#6e6e73',
    textFaint: '#86868b',
    accent: '#0066cc',
    accentSoft: 'rgba(0,113,227,.10)',
    danger: '#d70015',
    shadow: '0 12px 36px rgba(0,0,0,.12), 0 1px 3px rgba(0,0,0,.06)',
    radius: 14,
    radiusPanel: 16,
    radiusSm: 8,
    font: APPLE_FONT,
    frost: 'saturate(180%) blur(28px)',
    accentFill: '#0071e3',
    accentInk: '#ffffff',
    positive: '#34c759',
    borderWidth: 1
  },
  dark: {
    canvas: '#1c1c1e',
    sidebar: 'rgba(28,28,30,.78)',
    surface: '#2c2c2e',
    surfaceHi: '#3a3a3c',
    line: 'rgba(255,255,255,.12)',
    text: '#f5f5f7',
    textDim: '#aeaeb2',
    textFaint: '#8e8e93',
    accent: '#0a84ff',
    accentSoft: 'rgba(10,132,255,.18)',
    danger: '#ff453a',
    shadow: '0 22px 60px rgba(0,0,0,.58), inset 0 1px 0 rgba(255,255,255,.05)',
    radius: 14,
    radiusPanel: 16,
    radiusSm: 8,
    font: APPLE_FONT,
    frost: 'saturate(180%) blur(28px)',
    accentFill: '#0a84ff',
    accentInk: '#ffffff',
    positive: '#30d158',
    borderWidth: 1
  }
}

/**
 * Brutalist pack — the third voice.
 *
 * The style is deliberately the opposite pole of the other two: no radius, no
 * blur, no soft shadow. Surfaces are flat blocks separated by 2 px rules and
 * stacked with *hard* offset shadows (`6px 6px 0`), type runs at 700–800 with
 * uppercase micro-labels and wide tracking, and one signal orange carries every
 * interactive state. The style reference allows pure red/blue/yellow; a
 * dictation tool is read for minutes at a time, so the orange here is a
 * vermilion that still clears 4.5:1 on the bone canvas, with black (not white)
 * as the ink on a filled control — the brutalist convention, and the higher
 * contrast pair.
 *
 * Light is bone paper (`#f2efe6`) with graphite ink; dark is a coal canvas
 * (`#121110`) with the same rules inverted to a warm off-white. Both keep the
 * hairline `line` token muted so dense settings pages stay legible, while the
 * 2 px component borders use the full ink contrast (`borderWidth: 2`).
 */
const BRUTAL_FONT =
  '"Segoe UI Variable Text", "Segoe UI", Arial, "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'

const BRUTAL: Record<'dark' | 'light', Skin> = {
  light: {
    canvas: '#f2efe6',
    sidebar: '#e7e2d3',
    surface: '#fffdf7',
    surfaceHi: '#ece7d9',
    line: 'rgba(16,16,16,.22)',
    text: '#101010',
    textDim: '#4a463c',
    textFaint: '#6b665a',
    accent: '#c23400',
    accentSoft: 'rgba(255,77,0,.16)',
    danger: '#b3120b',
    // 4 px, not 6: a stack of cards each casting 6 px reads as overlapping
    // panels. The dialogs and menus carry the bigger offsets instead.
    shadow: '4px 4px 0 #101010',
    radius: 0,
    radiusPanel: 0,
    radiusSm: 0,
    font: BRUTAL_FONT,
    frost: 'none',
    accentFill: '#ff4d00',
    accentInk: '#101010',
    positive: '#1a7f37',
    borderWidth: 2
  },
  dark: {
    canvas: '#121110',
    sidebar: '#0b0a09',
    surface: '#1b1a17',
    surfaceHi: '#26241f',
    line: 'rgba(242,239,230,.22)',
    text: '#f2efe6',
    textDim: '#b9b3a4',
    textFaint: '#8d8779',
    accent: '#ff6a00',
    accentSoft: 'rgba(255,106,0,.18)',
    danger: '#ff5f56',
    shadow: '4px 4px 0 #000000',
    radius: 0,
    radiusPanel: 0,
    radiusSm: 0,
    font: BRUTAL_FONT,
    frost: 'none',
    accentFill: '#ff6a00',
    accentInk: '#101010',
    positive: '#35c26a',
    borderWidth: 2
  }
}

export const skins: Record<ThemePack, Record<'dark' | 'light', Skin>> = {
  classic: { dark: classicSkin('dark'), light: classicSkin('light') },
  apple: APPLE,
  brutal: BRUTAL
}

/**
 * Which pack a stored value paints with.
 *
 * Anything unrecognised — a settings file from a newer build, a hand-edited
 * value, `undefined` from a pre-pack install — resolves to `'classic'`. A pack
 * that cannot paint is worse than the old look, so the fallback is the shipped
 * one rather than a half-built one.
 */
export function normalizeThemePack(pack: ThemePack | undefined | null): ThemePack {
  if (pack === 'apple') return 'apple'
  if (pack === 'brutal') return 'brutal'
  return 'classic'
}

/** Pack + resolved appearance → the tokens a window paints with. */
export function skinFor(pack: ThemePack | undefined, mode: 'dark' | 'light'): Skin {
  return skins[normalizeThemePack(pack)][mode]
}

/** Picker metadata; the labels are i18n keys, the source string is Chinese. */
export interface ThemePackOption {
  id: ThemePack
  name: string
  hint: string
}

export const THEME_PACKS: readonly ThemePackOption[] = [
  {
    // Named for its own material, like the other two are named for theirs:
    // celadon is the warm porcelain field with a jade glaze, which is exactly
    // this palette. It used to be called 「当前主题」 ("current theme"), which
    // read as "the theme you happen to have selected" — nonsense once two
    // other cards sit next to it.
    id: 'classic',
    name: '青瓷',
    hint: '暖白瓷面与青玉点缀，应用最初的界面。'
  },
  {
    id: 'apple',
    name: '苹果风',
    hint: '系统蓝、SF 字体层级与半透明材质。'
  },
  {
    id: 'brutal',
    name: '粗野',
    hint: '墨线分隔、硬投影与信号橙，0 圆角高对比。'
  }
] as const

/* ------------------------------------------------------------------------- *
 * Glass: the surfaces that float over the desktop
 *
 * The recording bar and the answer card are not MUI surfaces — they are inline
 * styled capsules with a blurred fill, because they sit on top of whatever the
 * user is working in. They still belong to the pack, so their colours come from
 * the same place as everything else.
 *
 * Two things make this exact rather than approximate. `washColor` + `wash()`
 * reproduce the neutral alphas the overlays were built from (`rgba(255,255,255,
 * .06)` and friends) and flip to a dark wash on Apple's white light sheet;
 * `accentRgb` + `accentWash()` do the same for the accent tints. Every classic
 * value below is the literal that used to be hard-coded at the call site.
 * ------------------------------------------------------------------------- */

export interface GlassSkin {
  /** Capsule fill of the recording bar. */
  surface: string
  /** Fill of the caption bubble and of floating mini-panels. */
  panel: string
  /** Opaque-ish body of the answer card (deliberately a hair darker). */
  cardSurface: string
  /** Raised mini-panel: context menus. */
  panelHi: string
  /** Hairline at the "border" weight (12%). */
  border: string
  /** Divider/outline of a raised mini-panel. */
  borderStrong: string
  /** The neutral an overlay is drawn with, as an `r,g,b` triple. */
  washColor: string
  text: string
  /** Body copy inside the capsule (hints, results, card rows). */
  label: string
  /** Between `text` and `textDim`: hint lines and quoted text. */
  textMuted: string
  /** A step brighter than `text`: headings and emphasis. */
  textStrong: string
  textDim: string
  textFaint: string
  /** SVG illustration stroke. */
  iconStroke: string
  /** Dot, working indicator, primary accent. */
  accent: string
  /** The same accent as an `r,g,b` triple, for arbitrary alphas. */
  accentRgb: string
  /** Slightly brighter accent: secondary action text. */
  accentTint: string
  /**
   * The waveform bars. Kept separate from `accentTint` because the shipped bar
   * has always drawn the wave a hair paler than its action text, and a pack
   * refactor is not allowed to nudge that.
   */
  accentWave: string
  danger: string
  /** Error text that replaces the result line. */
  dangerText: string
  /** Hairline used when the capsule carries a failure. */
  dangerLine: string
  /** Faint error copy used by the card's save/voice failures. */
  dangerFaint: string
  /** `backdrop-filter` for the capsule. */
  frosted: string
  /** `backdrop-filter` for the answer card (a taller material). */
  frostedPanel: string
  font: string
  /** Corner radius of the capsule and the caption bubble. */
  radius: number
  /** Corner radius of controls inside the overlays: menus, buttons, chips. */
  radiusSm: number
  /** Corner radius of the answer card. */
  radiusPanel: number
  shadow: string
  /** Shadow of a raised mini-panel. */
  shadowPanel: string
  /** Stroke width of the capsule's rules, in px. Brutalism draws 2 px. */
  borderWidth: number
}

const CLASSIC_GLASS: GlassSkin = {
  surface: 'rgba(20,23,21,.96)',
  panel: '#202421',
  cardSurface: 'rgba(25,28,26,.97)',
  panelHi: '#2a302c',
  border: 'rgba(255,255,255,.12)',
  borderStrong: '#3c4940',
  washColor: '255,255,255',
  text: '#eef1e9',
  label: '#d3ddd3',
  textMuted: '#bbc9bd',
  textStrong: '#f4f6ef',
  textDim: '#abb5ac',
  textFaint: '#909d92',
  iconStroke: '#7b8598',
  accent: '#9bd6bb',
  accentRgb: '155,214,187',
  accentTint: '#bce5cf',
  accentWave: '#c4e8d5',
  danger: '#ffc6c6',
  dangerText: '#ffb3b3',
  dangerLine: 'rgba(239,95,95,.45)',
  dangerFaint: '#ffb4aa',
  frosted: 'blur(14px)',
  frostedPanel: 'blur(18px)',
  font: CLASSIC_FONT,
  radius: 12,
  radiusSm: 8,
  radiusPanel: 14,
  shadow: '0 3px 10px rgba(0,0,0,.12)',
  shadowPanel: '0 5px 20px #0005',
  borderWidth: 1
}

/**
 * Apple materials.
 *
 * `surface` mirrors a macOS "regular material": mostly the window colour with
 * enough alpha that the desktop shows through the blur. Light is a white sheet
 * with a black hairline; dark is `#2c2c2e` glass with a white hairline, which is
 * exactly how the system HUD looks in dark mode.
 */
const APPLE_GLASS: Record<'dark' | 'light', GlassSkin> = {
  light: {
    surface: 'rgba(255,255,255,.84)',
    panel: 'rgba(255,255,255,.94)',
    cardSurface: 'rgba(255,255,255,.97)',
    panelHi: 'rgba(255,255,255,.98)',
    border: 'rgba(0,0,0,.08)',
    borderStrong: 'rgba(0,0,0,.10)',
    washColor: '0,0,0',
    text: '#1d1d1f',
    label: '#3a3a3c',
    textMuted: '#6e6e73',
    textStrong: '#000000',
    textDim: '#6e6e73',
    textFaint: '#86868b',
    iconStroke: '#86868b',
    accent: '#007aff',
    accentRgb: '0,122,255',
    accentTint: '#0071e3',
    accentWave: '#0071e3',
    danger: '#d70015',
    dangerText: '#d70015',
    dangerLine: 'rgba(215,0,21,.42)',
    dangerFaint: '#d70015',
    frosted: 'saturate(180%) blur(30px)',
    frostedPanel: 'saturate(180%) blur(30px)',
    font: APPLE_FONT,
    radius: 14,
    radiusSm: 12,
    radiusPanel: 16,
    shadow: '0 10px 30px rgba(0,0,0,.16), 0 1px 2px rgba(0,0,0,.08)',
    shadowPanel: '0 12px 32px rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.08)',
    borderWidth: 1
  },
  dark: {
    surface: 'rgba(44,44,46,.86)',
    panel: 'rgba(44,44,46,.94)',
    cardSurface: 'rgba(44,44,46,.97)',
    panelHi: 'rgba(58,58,60,.96)',
    border: 'rgba(255,255,255,.12)',
    borderStrong: 'rgba(255,255,255,.18)',
    washColor: '255,255,255',
    text: '#f5f5f7',
    label: '#c7c7cc',
    textMuted: '#aeaeb2',
    textStrong: '#ffffff',
    textDim: '#aeaeb2',
    textFaint: '#8e8e93',
    iconStroke: '#8e8e93',
    accent: '#0a84ff',
    accentRgb: '10,132,255',
    accentTint: '#64d2ff',
    accentWave: '#0a84ff',
    danger: '#ff6961',
    dangerText: '#ff6961',
    dangerLine: 'rgba(255,105,97,.42)',
    dangerFaint: '#ff8a80',
    frosted: 'saturate(180%) blur(30px)',
    frostedPanel: 'saturate(180%) blur(30px)',
    font: APPLE_FONT,
    radius: 14,
    radiusSm: 12,
    radiusPanel: 16,
    shadow: '0 14px 40px rgba(0,0,0,.5)',
    shadowPanel: '0 16px 44px rgba(0,0,0,.55)',
    borderWidth: 1
  }
}

/**
 * Brutalist overlay material.
 *
 * The capsule stops pretending to be glass: an opaque bone (or coal) block with
 * a 2 px ink rule and a hard, unblurred shadow offset down-right. That is the
 * pack's whole proposition, so `frosted` is `'none'` and both shadows are solid
 * `Npx Npx 0` offsets rather than blurs.
 */
const BRUTAL_GLASS: Record<'dark' | 'light', GlassSkin> = {
  light: {
    surface: '#fffdf7',
    panel: '#fffdf7',
    cardSurface: '#fffdf7',
    panelHi: '#fffdf7',
    border: '#101010',
    borderStrong: '#101010',
    washColor: '0,0,0',
    text: '#101010',
    label: '#1b1a17',
    textMuted: '#3d382f',
    textStrong: '#000000',
    textDim: '#4a463c',
    textFaint: '#6b665a',
    iconStroke: '#101010',
    accent: '#c23400',
    accentRgb: '255,77,0',
    accentTint: '#c23400',
    accentWave: '#ff4d00',
    danger: '#b3120b',
    dangerText: '#b3120b',
    dangerLine: 'rgba(179,18,11,.45)',
    dangerFaint: '#b3120b',
    frosted: 'none',
    frostedPanel: 'none',
    font: BRUTAL_FONT,
    radius: 0,
    radiusSm: 0,
    radiusPanel: 0,
    shadow: '4px 4px 0 #101010',
    shadowPanel: '6px 6px 0 #101010',
    borderWidth: 2
  },
  dark: {
    surface: '#1b1a17',
    panel: '#1b1a17',
    cardSurface: '#1b1a17',
    panelHi: '#26241f',
    border: '#f2efe6',
    borderStrong: '#f2efe6',
    washColor: '242,239,230',
    text: '#f2efe6',
    label: '#d8d2c3',
    textMuted: '#b9b3a4',
    textStrong: '#ffffff',
    textDim: '#b9b3a4',
    textFaint: '#8d8779',
    iconStroke: '#f2efe6',
    accent: '#ff6a00',
    accentRgb: '255,106,0',
    accentTint: '#ff8a3d',
    accentWave: '#ff6a00',
    danger: '#ff5f56',
    dangerText: '#ff5f56',
    dangerLine: 'rgba(255,95,86,.5)',
    dangerFaint: '#ff8a80',
    frosted: 'none',
    frostedPanel: 'none',
    font: BRUTAL_FONT,
    radius: 0,
    radiusSm: 0,
    radiusPanel: 0,
    shadow: '4px 4px 0 #000000',
    shadowPanel: '6px 6px 0 #000000',
    borderWidth: 2
  }
}

/**
 * Colours for the floating surfaces.
 *
 * `classic` ignores `mode` on purpose: the shipped bar and card are a single
 * dark glass design, and light mode has never changed them. Apple and brutalism
 * do answer the appearance dial, because a light sheet (white glass, bone
 * paper) is what makes each pack recognisable in light mode.
 */
export function glassSkin(pack: ThemePack | undefined, mode: 'dark' | 'light'): GlassSkin {
  const resolved = normalizeThemePack(pack)
  if (resolved === 'apple') return APPLE_GLASS[mode]
  if (resolved === 'brutal') return BRUTAL_GLASS[mode]
  return CLASSIC_GLASS
}

/** Entry-module convenience for the overlay windows. */
export function glassOf(settings: Settings | null | undefined): GlassSkin {
  return glassSkin(settings?.themePack, resolveThemeMode(settings?.themeMode ?? 'dark'))
}

/**
 * A neutral overlay at an arbitrary alpha.
 *
 * `wash(g, .06)` is `rgba(255,255,255,.06)` under the shipped pack and
 * `rgba(0,0,0,.06)` on Apple's light sheet, so one call site expresses the same
 * *intent* — "a 6% hairline over the panel" — in both languages.
 */
export function wash(g: GlassSkin, alpha: number): string {
  return `rgba(${g.washColor},${alpha})`
}

/** The accent as an overlay at an arbitrary alpha. */
export function accentWash(g: GlassSkin, alpha: number): string {
  return `rgba(${g.accentRgb},${alpha})`
}
