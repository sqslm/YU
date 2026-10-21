import { Box } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

/** Turns a hotkey token ("RightAlt", "LeftCtrl", "F5") into a display label. */
export function keyLabel(token: string): string {
  const map: Record<string, string> = {
    LeftCtrl: 'Left Ctrl',
    RightCtrl: 'Right Ctrl',
    LeftAlt: 'Left Alt',
    RightAlt: 'Right Alt',
    LeftShift: 'Left Shift',
    RightShift: 'Right Shift',
    LeftWin: 'Left Win',
    RightWin: 'Right Win',
    Space: 'Space',
    Enter: 'Enter',
    Esc: 'Esc',
    Tab: 'Tab',
    Backspace: 'Backspace'
  }
  return map[token] ?? token.replace(/^Key/, '').replace(/^Digit/, '')
}

/** A row of keycaps, matching the reference app's keyboard-chord styling. */
export function Keycaps({ keys, size = 'md' }: { keys: string[]; size?: 'sm' | 'md' }): JSX.Element {
  const theme = useTheme()
  const height = size === 'sm' ? 20 : 24

  // Light palette: light-grey cap with dark text and a one-step brighter bottom
  // bevel. Dark palette: translucent white cap with a faint white bevel.
  const bevel =
    theme.palette.mode === 'dark'
      ? alpha(theme.palette.common.white, 0.18)
      : theme.palette.background.paper

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {keys.map((token, index) => (
        <Box key={`${token}-${index}`} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {index > 0 && (
            <Box sx={{ color: 'text.disabled', fontSize: 11, lineHeight: 1 }}>+</Box>
          )}
          <Box
            sx={{
              height,
              minWidth: height,
              px: size === 'sm' ? 0.75 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: size === 'sm' ? 10.5 : 11.5,
              color: 'text.primary',
              bgcolor: 'action.selected',
              border: 1,
              borderColor: 'divider',
              borderBottom: `2px solid ${bevel}`,
              borderRadius: '6px',
              whiteSpace: 'nowrap'
            }}
          >
            {keyLabel(token)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}
