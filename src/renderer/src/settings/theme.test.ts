import { describe, expect, it } from 'vitest'
import {
  accentWash,
  glassSkin,
  makeTheme,
  normalizeThemePack,
  palettes,
  skinFor,
  skins,
  THEME_PACKS,
  wash
} from './theme'

/**
 * The theme pack contract.
 *
 * Two things must never regress:
 *  1. `classic` is the palette the app shipped with. If a pack refactor moves a
 *     colour, the "I asked you to keep my UI" promise is broken.
 *  2. An unknown/missing pack value falls back to `classic`, so a settings file
 *     from a newer build cannot leave a window unpainted.
 */
describe('theme packs', () => {
  it('keeps the shipped palette byte-identical', () => {
    expect(palettes.dark).toEqual({
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
    })
    expect(palettes.light).toEqual({
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
    })
  })

  it('gives the classic skin exactly the colour tokens above', () => {
    expect(skins.classic.dark).toMatchObject(palettes.dark)
    expect(skins.classic.light).toMatchObject(palettes.light)
  })

  it('builds the classic theme with the original palette and geometry', () => {
    const dark = makeTheme('dark', 'classic')
    expect(dark.palette.background.default).toBe('#191c1a')
    expect(dark.palette.background.paper).toBe('#202421')
    expect(dark.palette.primary.main).toBe('#9bd6bb')
    expect(dark.palette.primary.contrastText).toBe('#14271d')
    expect(dark.shape.borderRadius).toBe(12)

    const light = makeTheme('light', 'classic')
    expect(light.palette.background.default).toBe('#f5f5f0')
    expect(light.palette.primary.contrastText).toBe('#ffffff')
  })

  it('defaults the pack argument to the shipped look', () => {
    // Every legacy call site passes a mode only; it must not silently repaint.
    expect(makeTheme('dark').palette.background.default).toBe('#191c1a')
  })

  it('paints Apple with system blue and the SF stack', () => {
    const light = makeTheme('light', 'apple')
    expect(light.palette.background.default).toBe('#f5f5f7')
    expect(light.palette.primary.main).toBe('#0071e3')
    expect(light.palette.text.primary).toBe('#1d1d1f')
    expect(light.typography.fontFamily).toContain('-apple-system')
    expect(light.shape.borderRadius).toBe(8)

    const dark = makeTheme('dark', 'apple')
    expect(dark.palette.background.default).toBe('#1c1c1e')
    expect(dark.palette.primary.main).toBe('#0a84ff')
    expect(dark.palette.text.primary).toBe('#f5f5f7')
  })

  it('paints brutalism with ink rules, hard shadows and one signal orange', () => {
    const light = makeTheme('light', 'brutal')
    expect(light.palette.background.default).toBe('#f2efe6')
    expect(light.palette.background.paper).toBe('#fffdf7')
    // Filled controls use black ink on the orange, the higher-contrast pair.
    expect(light.palette.primary.main).toBe('#ff4d00')
    expect(light.palette.primary.contrastText).toBe('#101010')
    expect(light.palette.text.primary).toBe('#101010')
    // Zero radius is the pack's defining geometry.
    expect(light.shape.borderRadius).toBe(0)
    expect(light.typography.button?.textTransform).toBe('uppercase')
    expect(light.typography.h6?.textTransform).toBe('uppercase')

    const dark = makeTheme('dark', 'brutal')
    expect(dark.palette.background.default).toBe('#121110')
    expect(dark.palette.primary.main).toBe('#ff6a00')
    expect(dark.palette.text.primary).toBe('#f2efe6')
    expect(dark.shape.borderRadius).toBe(0)
  })

  it('keeps the three dials independent', () => {
    // Pack changes colour language, mode changes light/dark — never the reverse.
    expect(makeTheme('dark', 'apple').palette.mode).toBe('dark')
    expect(makeTheme('light', 'apple').palette.mode).toBe('light')
    expect(makeTheme('light', 'classic').palette.mode).toBe('light')
    expect(makeTheme('dark', 'brutal').palette.mode).toBe('dark')
    expect(makeTheme('light', 'brutal').palette.mode).toBe('light')
  })

  it('falls back to the shipped pack for anything unknown', () => {
    expect(normalizeThemePack('apple')).toBe('apple')
    expect(normalizeThemePack('brutal')).toBe('brutal')
    expect(normalizeThemePack('classic')).toBe('classic')
    expect(normalizeThemePack(undefined)).toBe('classic')
    expect(normalizeThemePack(null)).toBe('classic')
    expect(normalizeThemePack('nord' as never)).toBe('classic')
    expect(skinFor('nord' as never, 'dark').canvas).toBe('#191c1a')
  })

  it('offers every pack to the picker', () => {
    expect(THEME_PACKS.map(pack => pack.id)).toEqual(['classic', 'apple', 'brutal'])
    expect(THEME_PACKS.every(pack => pack.name.length > 0 && pack.hint.length > 0)).toBe(true)
  })
})

describe('glass surfaces', () => {
  it('keeps the shipped bar and card colours exactly', () => {
    const glass = glassSkin('classic', 'dark')
    // Bar capsule.
    expect(glass.surface).toBe('rgba(20,23,21,.96)')
    expect(glass.panel).toBe('#202421')
    expect(glass.border).toBe('rgba(255,255,255,.12)')
    expect(glass.frosted).toBe('blur(14px)')
    expect(glass.radius).toBe(12)
    expect(glass.shadow).toBe('0 3px 10px rgba(0,0,0,.12)')
    // Answer card.
    expect(glass.cardSurface).toBe('rgba(25,28,26,.97)')
    expect(glass.frostedPanel).toBe('blur(18px)')
    expect(glass.radiusPanel).toBe(14)
    expect(glass.panelHi).toBe('#2a302c')
    expect(glass.borderStrong).toBe('#3c4940')
    expect(glass.shadowPanel).toBe('0 5px 20px #0005')
    // Type ramp.
    expect(glass.text).toBe('#eef1e9')
    expect(glass.label).toBe('#d3ddd3')
    expect(glass.textMuted).toBe('#bbc9bd')
    expect(glass.textStrong).toBe('#f4f6ef')
    expect(glass.textDim).toBe('#abb5ac')
    expect(glass.textFaint).toBe('#909d92')
    expect(glass.iconStroke).toBe('#7b8598')
    // Accent and status.
    expect(glass.accent).toBe('#9bd6bb')
    expect(glass.accentRgb).toBe('155,214,187')
    expect(glass.accentTint).toBe('#bce5cf')
    expect(glass.accentWave).toBe('#c4e8d5')
    expect(glass.danger).toBe('#ffc6c6')
    expect(glass.dangerText).toBe('#ffb3b3')
    expect(glass.dangerLine).toBe('rgba(239,95,95,.45)')
    expect(glass.dangerFaint).toBe('#ffb4aa')
    expect(glass.washColor).toBe('255,255,255')
    // Geometry and stroke weight the overlays derive from.
    expect(glass.radiusSm).toBe(8)
    expect(glass.borderWidth).toBe(1)
  })

  it('reproduces every neutral and accent alpha the overlays were built from', () => {
    const glass = glassSkin('classic', 'dark')
    // These are the alphas that used to be written out as literals in Bar.tsx
    // and in the card; the emitted CSS is equivalent (`0.06` === `.06`), which
    // is what keeps the shipped pack looking exactly as it did.
    expect(wash(glass, .06)).toBe('rgba(255,255,255,0.06)')
    expect(wash(glass, .14)).toBe('rgba(255,255,255,0.14)')
    expect(wash(glass, .025)).toBe('rgba(255,255,255,0.025)')
    expect(wash(glass, .10)).toBe('rgba(255,255,255,0.1)')
    expect(accentWash(glass, .16)).toBe('rgba(155,214,187,0.16)')
    expect(accentWash(glass, .08)).toBe('rgba(155,214,187,0.08)')
    expect(accentWash(glass, .18)).toBe('rgba(155,214,187,0.18)')
    expect(accentWash(glass, .25)).toBe('rgba(155,214,187,0.25)')
    expect(accentWash(glass, .35)).toBe('rgba(155,214,187,0.35)')
    expect(accentWash(glass, .45)).toBe('rgba(155,214,187,0.45)')
  })

  it('flips the wash polarity on Apple’s light sheet', () => {
    // A white 6% hairline is invisible on a white card; the dark wash is what
    // makes the same call site read as a separator there.
    expect(wash(glassSkin('apple', 'light'), .06)).toBe('rgba(0,0,0,0.06)')
    expect(accentWash(glassSkin('apple', 'light'), .35)).toBe('rgba(0,122,255,0.35)')
    expect(wash(glassSkin('apple', 'dark'), .06)).toBe('rgba(255,255,255,0.06)')
    expect(accentWash(glassSkin('apple', 'dark'), .35)).toBe('rgba(10,132,255,0.35)')
  })

  it('keeps the shipped glass dark in light mode too', () => {
    // The classic bar has always been a single dark material; light mode never
    // repainted it, and a pack refactor must not start doing so.
    expect(glassSkin('classic', 'light')).toEqual(glassSkin('classic', 'dark'))
  })

  it('gives Apple a white sheet in light mode and dark glass in dark mode', () => {
    expect(glassSkin('apple', 'light').surface).toContain('255,255,255')
    expect(glassSkin('apple', 'light').text).toBe('#1d1d1f')
    expect(glassSkin('apple', 'light').font).toContain('-apple-system')
    expect(glassSkin('apple', 'dark').surface).toContain('44,44,46')
    expect(glassSkin('apple', 'dark').text).toBe('#f5f5f7')
    expect(glassSkin('apple', 'dark').accent).toBe('#0a84ff')
  })

  it('gives brutalism an opaque block, a 2 px rule and a hard shadow', () => {
    const light = glassSkin('brutal', 'light')
    expect(light.surface).toBe('#fffdf7')
    expect(light.border).toBe('#101010')
    expect(light.borderWidth).toBe(2)
    expect(light.radius).toBe(0)
    expect(light.radiusPanel).toBe(0)
    expect(light.radiusSm).toBe(0)
    // No glass pretence: the capsule is a solid block, not a blurred sheet.
    expect(light.frosted).toBe('none')
    expect(light.shadow).toBe('4px 4px 0 #101010')
    expect(light.shadowPanel).toBe('6px 6px 0 #101010')
    expect(light.accentRgb).toBe('255,77,0')

    const dark = glassSkin('brutal', 'dark')
    expect(dark.surface).toBe('#1b1a17')
    expect(dark.border).toBe('#f2efe6')
    expect(dark.text).toBe('#f2efe6')
    expect(dark.shadow).toBe('4px 4px 0 #000000')
    expect(dark.borderWidth).toBe(2)
  })
})
