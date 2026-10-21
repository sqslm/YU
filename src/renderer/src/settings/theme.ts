import { alpha, createTheme, type Theme } from '@mui/material/styles'
import type { ThemeMode } from '@shared/types'

/**
 * Palette sampled from the reference app: a mid-dark grey canvas (not
 * near-black), one step darker sidebar, cards that lift by ~8% white, and a
 * single blue accent used only for primary actions and the active nav pill.
 */
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
    canvas: '#232323',
    sidebar: '#1c1c1c',
    surface: '#2b2b2b',
    surfaceHi: '#343434',
    line: 'rgba(255,255,255,.08)',
    text: '#f1f1f1',
    textDim: '#a6a6a6',
    textFaint: '#7b7b7b',
    accent: '#4c8dff',
    accentSoft: 'rgba(76,141,255,.16)',
    danger: '#f06a6a',
    shadow: '0 12px 32px rgba(0,0,0,.45)'
  },
  light: {
    canvas: '#f6f6f8',
    sidebar: '#eeeef0',
    surface: '#ffffff',
    surfaceHi: '#f1f1f3',
    line: 'rgba(0,0,0,.08)',
    text: '#1b1b1d',
    textDim: '#5d5d63',
    textFaint: '#8b8b91',
    accent: '#2f6bff',
    accentSoft: 'rgba(47,107,255,.12)',
    danger: '#d14444',
    shadow: '0 12px 32px rgba(15,15,20,.16)'
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
      primary: { main: t.accent },
      secondary: { main: '#8f7cff' },
      text: { primary: t.text, secondary: t.textDim },
      divider: t.line,
      error: { main: t.danger }
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily:
        '"Inter", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
      fontSize: 13.5,
      h4: { fontSize: 30, fontWeight: 600, letterSpacing: -0.4 },
      h5: { fontSize: 20, fontWeight: 600, letterSpacing: -0.2 },
      h6: { fontSize: 15, fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 500 }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { background: t.canvas, color: t.text },
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
          root: { borderRadius: 8, paddingInline: 14 },
          containedPrimary: { color: '#fff' }
        }
      },
      MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
      MuiFormControl: { defaultProps: { size: 'small', fullWidth: true } },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            '&.Mui-selected': {
              backgroundColor: alpha(resolved === 'dark' ? '#ffffff' : '#000000', 0.08),
              '&:hover': {
                backgroundColor: alpha(resolved === 'dark' ? '#ffffff' : '#000000', 0.11)
              }
            }
          }
        }
      },
      MuiTooltip: {
        styleOverrides: { tooltip: { backgroundColor: t.surfaceHi, fontSize: 12 } }
      }
    }
  })
}

export const theme = makeTheme('dark')
