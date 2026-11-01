import { alpha, createTheme, type Theme } from '@mui/material/styles'
import type { ThemePack } from '@shared/types'
import { normalizeThemePack, skins } from './appearance'

/**
 * MUI themes per theme pack.
 *
 * The token layer lives in `./appearance` (no MUI imports, so the overlay
 * windows can use it without pulling the design system into their bundles) and
 * is re-exported here, which keeps every existing `from './theme'` import
 * working.
 */
export * from './appearance'

/**
 * The shipped theme.
 *
 * Kept as its own function, with the original numbers spelled out, rather than
 * folded into a shared builder: a shared builder is how a palette edit silently
 * restyles the UI someone asked to keep unchanged.
 */
function makeClassicTheme(mode: 'dark' | 'light'): Theme {
  const resolved = mode
  const t = skins.classic[resolved]
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

/**
 * The Apple-flavoured theme.
 *
 * Same component inventory as the shipped theme, different design language:
 * HIG type ramp with tighter tracking, 8px controls inside 12–20px sheets,
 * system-blue filled controls, separators that read as hairlines instead of
 * borders, capsule chips, the iOS green switch, and real `backdrop-filter`
 * materials on the sidebar, menus and tooltips.
 */
function makeAppleTheme(mode: 'dark' | 'light'): Theme {
  const s = skins.apple[mode]
  const dark = mode === 'dark'
  return createTheme({
    palette: {
      mode,
      background: { default: s.canvas, paper: s.surface },
      primary: { main: s.accentFill, contrastText: s.accentInk },
      // System indigo: the second colour of the iOS/macOS accent set.
      secondary: { main: dark ? '#5e5ce6' : '#5856d6' },
      text: { primary: s.text, secondary: s.textDim },
      divider: s.line,
      error: { main: s.danger },
      success: { main: s.positive },
      warning: { main: dark ? '#ffd60a' : '#b25000' },
      info: { main: dark ? '#64d2ff' : '#0071a4' },
      action: { active: s.textDim, hover: alpha(s.accent, 0.08), selected: s.accentSoft, focus: alpha(s.accent, 0.2) }
    },
    shape: { borderRadius: s.radiusSm },
    typography: {
      fontFamily: s.font,
      fontSize: 14,
      h4: { fontSize: 34, fontWeight: 700, letterSpacing: -1.1, lineHeight: 1.2 },
      h5: { fontSize: 26, fontWeight: 700, letterSpacing: -0.8, lineHeight: 1.3 },
      h6: { fontSize: 19, fontWeight: 600, letterSpacing: -0.35, lineHeight: 1.45 },
      body1: { lineHeight: 1.62, letterSpacing: -0.1 },
      body2: { lineHeight: 1.62, letterSpacing: -0.1 },
      button: { textTransform: 'none', fontWeight: 590, letterSpacing: -0.05 }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': { colorScheme: mode },
          body: {
            background: s.canvas,
            color: s.text,
            WebkitFontSmoothing: 'antialiased',
            textRendering: 'optimizeLegibility',
            // The HIG calls this "optical" tracking: subpixel-level tightening
            // that makes the SF stack read like a system app rather than a page.
            letterSpacing: '-0.011em'
          },
          // The hub's rail is drawn with an inline background, so the material is
          // applied as a filter over it instead of as another background.
          '[data-app-sidebar]': { backdropFilter: s.frost, WebkitBackdropFilter: s.frost },
          '[data-caption-bubble]': { backdropFilter: s.frost, WebkitBackdropFilter: s.frost },
          '::selection': { background: alpha(s.accent, 0.28), color: s.text },
          ':focus-visible': { outline: `3px solid ${alpha(s.accent, 0.6)}`, outlineOffset: 2 },
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': { animationDuration: '0.01ms !important', animationIterationCount: '1 !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' }
          },
          // macOS overlay scrollbars: thin, rounded, no track.
          '::-webkit-scrollbar': { width: 12, height: 12 },
          '::-webkit-scrollbar-thumb': {
            background: dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)',
            borderRadius: 999,
            border: '3px solid transparent',
            backgroundClip: 'content-box'
          },
          '::-webkit-scrollbar-thumb:hover': { background: dark ? 'rgba(255,255,255,.32)' : 'rgba(0,0,0,.32)' },
          '::-webkit-scrollbar-track': { background: 'transparent' }
        }
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            border: `1px solid ${s.line}`,
            backgroundColor: s.surface,
            borderRadius: s.radiusPanel + 2
          }
        }
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: s.radiusSm,
            padding: '6px 15px',
            fontSize: 13,
            fontWeight: 590,
            letterSpacing: -0.05,
            transition: 'background-color 180ms cubic-bezier(.4,0,.2,1), border-color 180ms cubic-bezier(.4,0,.2,1), transform 120ms cubic-bezier(.4,0,.2,1)',
            // The "press" of an iOS button is a scale, not a colour jump.
            '&:active': { transform: 'scale(.975)' }
          },
          sizeSmall: { padding: '4px 11px', fontSize: 12 },
          containedPrimary: {
            backgroundColor: s.accentFill,
            color: s.accentInk,
            '&:hover': { backgroundColor: dark ? '#3b9dff' : '#0a63c4' }
          },
          outlinedPrimary: {
            borderColor: s.line,
            color: s.accent,
            '&:hover': { borderColor: alpha(s.accent, .5), backgroundColor: s.accentSoft }
          },
          textPrimary: { color: s.accent }
        }
      },
      MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': { outline: `3px solid ${alpha(s.accent, .6)}`, outlineOffset: 2 } } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 8, transition: 'background-color 140ms ease', '&:hover': { backgroundColor: alpha(s.text, 0.08) } } } },
      MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
      MuiFormControl: { defaultProps: { size: 'small', fullWidth: true } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: s.radiusSm,
            backgroundColor: s.surface,
            fontSize: 13,
            transition: 'box-shadow 160ms ease, border-color 160ms ease',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: s.line },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: alpha(s.text, .24) },
            // The 3px halo is the macOS focus ring, drawn *outside* the hairline.
            '&.Mui-focused': { boxShadow: `0 0 0 4px ${alpha(s.accent, .2)}` },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: s.accent, borderWidth: 1 }
          }
        }
      },
      MuiTabs: { styleOverrides: { root: { minHeight: 36 }, indicator: { height: 2.5, borderRadius: 2 } } },
      MuiTab: { styleOverrides: { root: { minHeight: 36, fontSize: 12.5, fontWeight: 500, letterSpacing: -0.05, '&.Mui-selected': { fontWeight: 600 } } } },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            borderColor: s.line,
            textTransform: 'none',
            borderRadius: s.radiusSm,
            '&.Mui-selected': {
              backgroundColor: s.accentFill,
              color: s.accentInk,
              '&:hover': { backgroundColor: alpha(s.accentFill, .88) }
            }
          }
        }
      },
      // Capsule chips, as in every Apple settings sheet.
      MuiChip: { styleOverrides: { root: { borderRadius: 999, fontSize: 11.5, fontWeight: 500 }, outlined: { borderColor: s.line } } },
      MuiSwitch: {
        styleOverrides: {
          root: {
            '& .MuiSwitch-switchBase.Mui-checked': { color: '#ffffff' },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: s.positive, opacity: 1 }
          }
        }
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 20,
            boxShadow: s.shadow,
            backdropFilter: s.frost,
            WebkitBackdropFilter: s.frost
          }
        }
      },
      // macOS sheets do not black out the window behind them.
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: dark ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.16)' } } },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 12,
            boxShadow: s.shadow,
            padding: 4,
            border: `1px solid ${s.line}`,
            backdropFilter: s.frost,
            WebkitBackdropFilter: s.frost
          }
        }
      },
      MuiMenuItem: { styleOverrides: { root: { fontSize: 13, borderRadius: 7, minHeight: 34 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 10, fontSize: 12.5 } } },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            color: s.textDim,
            '&.Mui-selected': {
              color: s.accent,
              backgroundColor: s.accentSoft,
              '&:hover': { backgroundColor: alpha(s.accent, 0.16) }
            }
          }
        }
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: dark ? 'rgba(58,58,60,.96)' : 'rgba(255,255,255,.96)',
            color: s.text,
            border: `1px solid ${s.line}`,
            borderRadius: 7,
            fontSize: 11.5,
            padding: '5px 9px',
            boxShadow: s.shadow,
            backdropFilter: s.frost,
            WebkitBackdropFilter: s.frost
          }
        }
      }
    }
  })
}

/**
 * The brutalist theme.
 *
 * Structure over surface: every decision is a rule, a block or an offset.
 * 0 px radius everywhere, 2–3 px ink borders on components, *hard* shadows
 * (`6px 6px 0`) instead of blurs, 800-weight uppercase labels with wide
 * tracking, and a single signal orange for interaction. Transitions are
 * intentionally instant — the style calls for a mechanical press, not a glide —
 * which is also why the reduced-motion block still exists: a user who asks for
 * less motion must get none, not just shorter durations.
 */
function makeBrutalTheme(mode: 'dark' | 'light'): Theme {
  const s = skins.brutal[mode]
  const dark = mode === 'dark'
  /** Components are bordered in full ink; `line` stays a muted hairline. */
  const ink = s.text
  const rule = `${s.borderWidth}px solid ${ink}`
  return createTheme({
    palette: {
      mode,
      background: { default: s.canvas, paper: s.surface },
      primary: { main: s.accentFill, contrastText: s.accentInk },
      // The style's other two primaries, toned for a reading surface.
      secondary: { main: dark ? '#8ab4ff' : '#1a3fd0' },
      text: { primary: s.text, secondary: s.textDim },
      divider: s.line,
      error: { main: s.danger },
      success: { main: s.positive },
      warning: { main: dark ? '#ffd400' : '#8a4b00' },
      info: { main: dark ? '#8ab4ff' : '#1a3fd0' },
      action: { active: s.textDim, hover: alpha(s.accentFill, 0.12), selected: s.accentSoft, focus: alpha(s.accentFill, 0.3) }
    },
    shape: { borderRadius: 0 },
    typography: {
      fontFamily: s.font,
      fontSize: 14,
      h4: { fontSize: 32, fontWeight: 800, letterSpacing: -0.6, lineHeight: 1.15, textTransform: 'uppercase' },
      h5: { fontSize: 24, fontWeight: 800, letterSpacing: -0.4, lineHeight: 1.25 },
      h6: { fontSize: 18, fontWeight: 800, letterSpacing: 0.1, lineHeight: 1.35, textTransform: 'uppercase' },
      body1: { lineHeight: 1.62 },
      body2: { lineHeight: 1.62 },
      button: { textTransform: 'uppercase', fontWeight: 800, letterSpacing: '0.06em' }
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': { colorScheme: mode },
          body: { background: s.canvas, color: s.text, WebkitFontSmoothing: 'antialiased' },
          // A solid block of accent, with the black/white pairing the style uses.
          '::selection': { background: s.accentFill, color: s.accentInk },
          ':focus-visible': { outline: `3px solid ${ink}`, outlineOffset: 2 },
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': { animationDuration: '0.01ms !important', animationIterationCount: '1 !important', transitionDuration: '0.01ms !important', scrollBehavior: 'auto !important' }
          },
          // Square scrollbars with a visible rule, not a floating pill.
          '::-webkit-scrollbar': { width: 14, height: 14 },
          '::-webkit-scrollbar-thumb': { background: ink, borderRadius: 0, border: `3px solid ${s.canvas}` },
          '::-webkit-scrollbar-thumb:hover': { background: s.accentFill },
          '::-webkit-scrollbar-track': { background: s.canvas, borderLeft: `1px solid ${s.line}` }
        }
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            backgroundColor: s.surface,
            border: rule,
            borderRadius: 0,
            boxShadow: s.shadow
          }
        }
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 0,
            padding: '7px 16px',
            fontSize: 12.5,
            fontWeight: 800,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            border: rule,
            boxShadow: `3px 3px 0 ${ink}`,
            transition: 'none',
            // The press is a mechanical shift into its own shadow.
            '&:active': { transform: `translate(${s.borderWidth + 1}px, ${s.borderWidth + 1}px)`, boxShadow: 'none' }
          },
          sizeSmall: { padding: '5px 10px', fontSize: 11.5 },
          // Text buttons sit in dense rows; a 2 px box on every one would shout.
          text: { border: 'none', boxShadow: 'none', padding: '4px 8px', '&:hover': { backgroundColor: s.accentSoft } },
          containedPrimary: { backgroundColor: s.accentFill, color: s.accentInk, '&:hover': { backgroundColor: s.accentFill, filter: 'brightness(1.07)' } },
          outlinedPrimary: { borderColor: ink, color: s.text, backgroundColor: s.surface, '&:hover': { borderColor: ink, backgroundColor: s.accentSoft } },
          textPrimary: { color: s.accent }
        }
      },
      MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': { outline: `3px solid ${ink}`, outlineOffset: 2 } } } },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 0,
            border: `${s.borderWidth}px solid transparent`,
            transition: 'none',
            '&:hover': { borderColor: ink, backgroundColor: s.accentSoft }
          }
        }
      },
      MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
      MuiFormControl: { defaultProps: { size: 'small', fullWidth: true } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 0,
            backgroundColor: s.surface,
            fontSize: 13,
            transition: 'none',
            '& .MuiOutlinedInput-notchedOutline': { borderColor: ink, borderWidth: s.borderWidth },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: ink },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: s.accentFill, borderWidth: s.borderWidth + 1 }
          }
        }
      },
      MuiTabs: { styleOverrides: { root: { minHeight: 36 }, indicator: { height: 3, borderRadius: 0, backgroundColor: s.accentFill } } },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 36,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            '&.Mui-selected': { fontWeight: 800 }
          }
        }
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            border: rule,
            borderRadius: 0,
            textTransform: 'uppercase',
            fontWeight: 700,
            letterSpacing: '0.05em',
            '&.Mui-selected': {
              backgroundColor: s.accentFill,
              color: s.accentInk,
              '&:hover': { backgroundColor: s.accentFill }
            }
          }
        }
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 0, border: `${s.borderWidth}px solid ${ink}`, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' },
          outlined: { border: `${s.borderWidth}px solid ${ink}` }
        }
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            '& .MuiSwitch-track': { borderRadius: 0, border: `${s.borderWidth}px solid ${ink}`, backgroundColor: s.surface, opacity: 1 },
            '& .MuiSwitch-thumb': { borderRadius: 0, backgroundColor: ink },
            '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { backgroundColor: s.accentFill, opacity: 1 }
          }
        }
      },
      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 0, border: `3px solid ${ink}`, boxShadow: `10px 10px 0 ${ink}` }
        }
      },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: dark ? 'rgba(0,0,0,.72)' : 'rgba(16,16,16,.45)' } } },
      MuiMenu: {
        styleOverrides: {
          paper: { borderRadius: 0, border: `${s.borderWidth}px solid ${ink}`, boxShadow: `6px 6px 0 ${ink}`, padding: 4, backgroundColor: s.surface }
        }
      },
      MuiMenuItem: {
        styleOverrides: {
          root: { fontSize: 13, borderRadius: 0, minHeight: 36, '&.Mui-selected': { backgroundColor: s.accentSoft, fontWeight: 700 } }
        }
      },
      MuiAlert: { styleOverrides: { root: { borderRadius: 0, border: `${s.borderWidth}px solid ${ink}`, fontSize: 12.5 } } },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 0,
            color: s.textDim,
            '&.Mui-selected': {
              color: s.text,
              backgroundColor: s.accentSoft,
              '&:hover': { backgroundColor: s.accentSoft }
            }
          }
        }
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: { backgroundColor: ink, color: s.canvas, border: 'none', borderRadius: 0, fontSize: 11, fontWeight: 600, padding: '5px 8px', boxShadow: 'none' }
        }
      }
    }
  })
}

/**
 * Builds the theme for a pack.
 *
 * The pack argument defaults to `'classic'`, so every existing call site that
 * only passes a mode keeps painting the shipped look until it is taught about
 * packs — that is what makes the pack additive rather than a rewrite.
 */
export function makeTheme(mode: 'dark' | 'light', pack: ThemePack = 'classic'): Theme {
  const resolved = normalizeThemePack(pack)
  if (resolved === 'apple') return makeAppleTheme(mode)
  if (resolved === 'brutal') return makeBrutalTheme(mode)
  return makeClassicTheme(mode)
}

export const theme = makeTheme('dark')
