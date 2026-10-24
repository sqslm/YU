import { Box } from '@mui/material'
import light from '../../../resources/brand/logo-light.png'
import dark from '../../../resources/brand/logo-dark.png'
import aboutLight from '../../../resources/brand/about-light.png'
import aboutDark from '../../../resources/brand/about-dark.png'
import { useTranslation } from 'react-i18next'
import { productName } from '@shared/brand'

export function BrandLogo({ mode, width = 150, full = false }: { mode: 'light' | 'dark'; width?: number; full?: boolean }): JSX.Element {
  const { i18n } = useTranslation()
  return <Box component="img" src={full ? mode === 'dark' ? aboutDark : aboutLight : mode === 'dark' ? dark : light} alt={productName(i18n.language)} sx={{ width, maxWidth: '100%', height: 'auto', objectFit: 'contain', display: 'block' }} />
}
