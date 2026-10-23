import { Box } from '@mui/material'
import light from '../../../resources/brand/logo-light.png'
import dark from '../../../resources/brand/logo-dark.png'

export function BrandLogo({ mode, width = 150 }: { mode: 'light' | 'dark'; width?: number }): JSX.Element {
  return <Box component="img" src={mode === 'dark' ? dark : light} alt="轻令（Qinly）" sx={{ width, maxWidth: '100%', aspectRatio: '2 / 1', objectFit: 'contain', display: 'block' }} />
}
