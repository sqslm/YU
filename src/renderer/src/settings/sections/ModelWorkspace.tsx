import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'

/** Shared geometry for model connections and TTS providers. */
export function ModelWorkspace({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }): JSX.Element {
  return <Box data-model-workspace sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '208px minmax(0, 1fr)' }, gap: 1.5, alignItems: 'start', minWidth: 0 }}>
    <Box component="aside" sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', minWidth: 0, overflow: 'hidden' }}>{sidebar}</Box>
    <Box data-model-detail sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', minWidth: 0, overflow: 'hidden', minHeight: 440 }}>{children}</Box>
  </Box>
}

export const modelFieldSx = { '& .MuiOutlinedInput-root': { bgcolor: 'background.default' } } as const
export const modelSelectedBackground = (theme: Theme): string => alpha(theme.palette.primary.main, 0.12)

export function ModelAvatar({ name, active = false }: { name: string; active?: boolean }): JSX.Element {
  return <Box component="span" aria-hidden sx={{ width: 32, height: 32, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: '8px', fontSize: 14, fontWeight: 600, bgcolor: active ? 'primary.main' : 'action.hover', color: active ? 'primary.contrastText' : 'text.secondary' }}>{Array.from(name.trim())[0]?.toUpperCase() || 'M'}</Box>
}
