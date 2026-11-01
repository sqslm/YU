import { Box, Typography } from '@mui/material'
import CheckRounded from '@mui/icons-material/CheckRounded'
import { alpha } from '@mui/material/styles'
import { useTranslation } from 'react-i18next'
import type { ThemePack } from '@shared/types'
import { skinFor, THEME_PACKS } from './theme'

/**
 * The theme pack picker.
 *
 * Two cards, not a dropdown: a pack is a whole look, and a look has to be seen.
 * Each card carries a miniature of the hub — rail, card, accent, secondary copy —
 * rendered from that pack's *own* tokens in both appearances, so the choice is
 * legible before it is applied and light/dark is visibly part of both packs.
 *
 * Implemented as a real radio group (roving `tabIndex`, arrow keys, Home/End)
 * rather than a row of divs: the settings dialog is keyboard-first, and a
 * pointer-only picker would be the one control in it that a keyboard cannot use.
 */
export function ThemePackPicker({ value, onChange, label, disabled = false }: {
  value: ThemePack
  onChange: (pack: ThemePack) => void
  /** Accessible group name, from the surrounding row's label. */
  label: string
  disabled?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const ids = THEME_PACKS.map((pack) => pack.id)

  /** Moves the selection by `delta`, wrapping, and hands focus to the new card. */
  const step = (from: number, delta: number): void => {
    const nextId = ids[(from + delta + ids.length) % ids.length]!
    onChange(nextId)
    const group = document.querySelector('[data-theme-pack-picker]')
    const card = group?.querySelector<HTMLElement>(`[data-theme-pack="${nextId}"]`)
    card?.focus()
  }

  return (
    <Box
      role="radiogroup"
      aria-label={label}
      data-theme-pack-picker
      data-theme-pack-value={value}
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'stretch', justifyContent: 'flex-end', maxWidth: 620 }}
    >
      {THEME_PACKS.map((pack, index) => {
        const selected = pack.id === value
        return (
          <Box
            key={pack.id}
            component="button"
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(pack.name)}
            data-theme-pack={pack.id}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(pack.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); step(index, 1) }
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); step(index, -1) }
              else if (event.key === 'Home') { event.preventDefault(); step(0, 0) }
              else if (event.key === 'End') { event.preventDefault(); step(ids.length - 1, 0) }
              else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); onChange(pack.id) }
            }}
            sx={(theme) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              minWidth: 176,
              maxWidth: 196,
              p: '8px',
              textAlign: 'left',
              font: 'inherit',
              color: 'text.primary',
              cursor: 'pointer',
              backgroundColor: selected ? alpha(theme.palette.primary.main, 0.06) : 'transparent',
              border: '1px solid',
              borderColor: selected ? 'primary.main' : 'divider',
              borderRadius: 2,
              boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.14)}` : 'none',
              transition: 'border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
              '&:hover': { borderColor: selected ? 'primary.main' : alpha(theme.palette.text.primary, 0.28) },
              '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
              '&.Mui-disabled': { opacity: 0.55, cursor: 'default' }
            })}
          >
            <PackMiniature pack={pack.id} />
            <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography component="span" sx={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
                  {t(pack.name)}
                </Typography>
                {selected && <CheckRounded sx={{ fontSize: 14, color: 'primary.main' }} aria-hidden />}
              </Box>
              <Typography
                component="span"
                sx={{
                  fontSize: 10.5,
                  lineHeight: 1.45,
                  color: 'text.secondary',
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 3,
                  overflow: 'hidden'
                }}
              >
                {t(pack.hint)}
              </Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * A 76×44 miniature of the hub in both appearances: dark on the left, light on
 * the right. Everything in it is drawn from the pack's tokens — no literals —
 * so adding a pack cannot produce a preview that lies about it.
 */
function PackMiniature({ pack }: { pack: ThemePack }): JSX.Element {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: 'flex',
        width: 76,
        height: 44,
        flex: '0 0 auto',
        borderRadius: '6px',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider'
      }}
    >
      {(['dark', 'light'] as const).map((mode) => {
        const skin = skinFor(pack, mode)
        return (
          <Box
            key={mode}
            component="span"
            data-pack-preview={`${pack}-${mode}`}
            sx={{ position: 'relative', flex: 1, display: 'block', background: skin.canvas }}
          >
            {/* rail */}
            <Box component="span" sx={{ position: 'absolute', inset: '0 auto 0 0', width: 13, background: skin.sidebar, borderRight: `1px solid ${skin.line}` }} />
            {/* content card */}
            <Box component="span" sx={{ position: 'absolute', left: 18, top: 7, right: 6, height: 10, borderRadius: '2px', background: skin.surface, border: `1px solid ${skin.line}` }} />
            {/* accent row */}
            <Box component="span" sx={{ position: 'absolute', left: 18, top: 22, width: 20, height: 4, borderRadius: 99, background: skin.accent }} />
            {/* secondary copy */}
            <Box component="span" sx={{ position: 'absolute', left: 18, top: 31, width: 30, height: 3, borderRadius: 99, background: skin.textFaint, opacity: 0.55 }} />
          </Box>
        )
      })}
    </Box>
  )
}
