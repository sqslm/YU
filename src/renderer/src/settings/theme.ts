import { alpha, createTheme, type Theme } from '@mui/material/styles'
import type { ThemeMode } from '@shared/types'

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

export function makeTheme(mode: 'dark' | 'light'): Theme {
  const resolved = mode
  const t = palettes[resolved]
  return createTheme({
    palette: {
      mode: resolved,
      background: { default: t.canvas, paper: t.surface },
      primary: { main: t.accent, contrastText: resolved === 'dark' ? '#14271d' : '#ffffff' },
      secondary: { main: resolved === 'dark' ? '#c6bc9f' : '#76633f' },
      text: { primary: t.text, secondary: t.textDim },
      divider: t.line,
      error: { main: t.danger },
      success: { main: t.accent },
      warning: { main: resolved === 'dark' ? '#dfbc79' : '#8a621f' },
      info: { main: resolved === 'dark' ? '#a0c9cf' : '#426b77' },
      action: { active: t.textDim, hover: alpha(t.accent, 0.06), selected: t.accentSoft, focus: alpha(t.accent, 0.14) }
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily:
        '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
      fontSize: 14,
      h4: { fontSize: 30, fontWeight: 650, letterSpacing: -0.9, lineHeight: 1.3 },
      h5: { fontSize: 24, fontWeight: 650, letterSpacing: -0.6, lineHeight: 1.4 },
      h6: { fontSize: 18, fontWeight: 650, letterSpacing: -0.3, lineHeight: 1.5 },
      body1: { lineHeight: 1.7 },
      body2: { lineHeight: 1.7 },
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': { colorScheme: resolved },
          body: { background: t.canvas, color: t.text, WebkitFontSmoothing: 'antialiased' },
          '::selection': { background: alpha(t.accent, 0.23), color: t.text },
          ':focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: 3 },
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': { animationDuration: '0.01ms !important', animationIterationCount: '1 !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' }
          },
          '::-webkit-scrollbar': { width: 10, height: 10 },
          '::-webkit-scrollbar-thumb': {
            background: resolved === 'dark' ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.18)',
            borderRadius: 8,
            border: '3px solid transparent',
            backgroundClip: 'content-box'
          },
          '::-webkit-scrollbar-track': { background: 'transparent' }
        }
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            border: `1px solid ${t.line}`,
            backgroundColor: t.surface
          }
        }
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 9, padding: '7px 16px', transition: 'background-color 160ms ease, border-color 160ms ease', fontSize: 13 },
          sizeSmall: { padding: '5px 12px', fontSize: 12 },
          outlinedPrimary: { borderColor: t.line, color: t.text, '&:hover': { borderColor: alpha(t.accent, .4), backgroundColor: t.accentSoft } }
        }
      },
      MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': { outline: `2px solid ${t.accent}`, outlineOffset: 2 } } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 9, '&:hover': { backgroundColor: t.accentSoft } } } },
      MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
      MuiFormControl: { defaultProps: { size: 'small', fullWidth: true } },
      MuiOutlinedInput: { styleOverrides: { root: {
        borderRadius: 9, backgroundColor: alpha(t.surface, .7), fontSize: 13,
        '& .MuiOutlinedInput-notchedOutline': { borderColor: t.line },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: alpha(t.accent, .45) },
        '&.Mui-focused': { boxShadow: `0 0 0 3px ${t.accentSoft}` }
      } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 36 }, indicator: { height: 2, borderRadius: 2 } } },
      MuiTab: { styleOverrides: { root: { minHeight: 36, fontSize: 12.5, fontWeight: 500, '&.Mui-selected': { fontWeight: 650 } } } },
      MuiToggleButton: { styleOverrides: { root: { borderColor: t.line, textTransform: 'none', '&.Mui-selected': { backgroundColor: t.accentSoft, color: t.accent, '&:hover': { backgroundColor: alpha(t.accent, .16) } } } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 6, fontSize: 11.5 }, outlined: { borderColor: t.line } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 18, boxShadow: t.shadow } } },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'rgba(13,23,17,.48)' } } },
      MuiMenu: { styleOverrides: { paper: { borderRadius: 12, boxShadow: t.shadow, padding: 4 } } },
      MuiMenuItem: { styleOverrides: { root: { fontSize: 13, borderRadius: 6, minHeight: 36 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 10, fontSize: 12.5 } } },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 9,
            color: t.textDim,
            '&.Mui-selected': {
              color: t.accent,
              backgroundColor: t.accentSoft,
              '&:hover': {
                backgroundColor: alpha(t.accent, 0.15)
              }
            }
          }
        }
      },
      MuiTooltip: {
        styleOverrides: { tooltip: { backgroundColor: t.surfaceHi, color: t.text, border: `1px solid ${t.line}`, borderRadius: 7, fontSize: 11.5, padding: '6px 10px', boxShadow: t.shadow } }
      }
    }
  })
}

export const theme = makeTheme('dark')
