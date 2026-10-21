import { useState } from 'react'
import { Box, Button, Dialog, IconButton, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { GeneralSection } from './sections/General'
import { ShortcutsSection } from './sections/Shortcuts'
import { ProvidersSection } from './sections/Providers'
import { PromptsSection } from './sections/Prompts'
import { RoutingSection } from './sections/Routing'
import { SearchSection } from './sections/Search'
import { AccountSection } from './sections/Account'
import { AboutSection, useAppVersion } from './sections/About'
import { GuidePage } from './pages/Guide'
import { useTranslation } from 'react-i18next'
import {
  IconClose,
  IconCode,
  IconCpu,
  IconInfo,
  IconKeyboard,
  IconMagnifier,
  IconSliders,
  IconSparkle,
  IconUser
} from './sections/General'
import i18n from '../i18n'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  settings: Settings
  patch: (value: Partial<Settings>) => void
  saving: boolean
  saveError: string
  onRetry: () => void
}

/**
 * Section rail. Labels and hints are i18n keys, not text: this sheet is where a
 * non-Chinese user first lands, and a nav rail that stays Chinese next to a
 * translated app looks broken rather than unfinished.
 */
const SECTIONS = [
  {
    id: 'account',
    labelKey: 'settings.nav.account',
    hintKey: 'settings.hint.account',
    icon: <IconUser />
  },
  {
    id: 'general',
    labelKey: 'settings.nav.general',
    hintKey: 'settings.hint.general',
    icon: <IconSliders />
  },
  {
    id: 'shortcuts',
    labelKey: 'settings.nav.shortcuts',
    hintKey: 'settings.hint.shortcuts',
    icon: <IconKeyboard />
  },
  {
    id: 'models',
    labelKey: 'settings.nav.models',
    hintKey: 'settings.hint.models',
    icon: <IconCpu />
  },
  {
    id: 'prompts',
    labelKey: 'settings.nav.prompts',
    hintKey: 'settings.hint.prompts',
    icon: <IconSparkle />
  },
  {
    id: 'routing',
    labelKey: 'settings.nav.routing',
    hintKey: 'settings.hint.routing',
    icon: <IconCode />
  },
  {
    id: 'search',
    labelKey: 'settings.nav.search',
    hintKey: 'settings.hint.search',
    icon: <IconMagnifier />
  },
  {
    id: 'guide',
    labelKey: 'settings.nav.guide',
    hintKey: 'settings.hint.guide',
    icon: <IconSparkle />
  },
  {
    id: 'about',
    labelKey: 'settings.nav.about',
    hintKey: 'settings.hint.about',
    icon: <IconInfo />
  }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsDialog({
  open,
  onClose,
  settings,
  patch,
  saving,
  saveError,
  onRetry
}: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState<SectionId>('general')
  const version = useAppVersion()
  const { t } = useTranslation()
  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[1]

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 900,
            maxWidth: '92vw',
            height: 660,
            maxHeight: '88vh',
            m: 0,
            borderRadius: '12px',
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            flexDirection: 'row',
            bgcolor: 'background.default'
          }
        }
      }}
    >
      {/* Floats over the top-right corner of the whole sheet, per the reference. */}
      <IconButton
        size="small"
        aria-label={i18n.t('关闭设置')}
        data-close
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 3,
          width: 26,
          height: 26,
          borderRadius: '7px',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
        }}
      >
        <IconClose size={14} />
      </IconButton>

      <Box
        sx={{
          width: 200,
          flex: '0 0 auto',
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.default',
          pt: 1.5,
          pb: 1.5,
          px: 1,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <Typography
          sx={{
            px: 1.25,
            pb: 1.25,
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0.8,
            color: 'text.disabled'
          }}
        >
          {t('settings.title')}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>          {SECTIONS.map((item) => {
            const selected = item.id === section
            return (
              <Box
                component="button"
                type="button"
                key={item.id}
                data-section={item.id}
                aria-current={selected ? 'page' : undefined}
                onClick={() => setSection(item.id)}
                sx={{
                  display: 'flex',
                  border: 0,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  alignItems: 'center',
                  gap: 1.25,
                  height: 30,
                  px: 1.25,
                  borderRadius: '7px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: selected ? 'text.primary' : 'text.secondary',
                  fontWeight: selected ? 600 : 400,
                  bgcolor: selected ? 'rgba(127,127,127,.14)' : 'transparent',
                  '&:hover': {
                    bgcolor: selected ? 'rgba(127,127,127,.14)' : 'rgba(127,127,127,.08)',
                    color: 'text.primary'
                  }
                }}
              >
                <Box sx={{ display: 'grid', placeItems: 'center', color: 'inherit' }}>
                  {item.icon}
                </Box>
                <Box component="span">{t(item.labelKey)}</Box>
              </Box>
            )
          })}
        </Box>
        {/* The version now lives only inside the sheet: pinned to the bottom of
            this nav column so it is visible from every section. */}
        <Typography sx={{ mt: 'auto', px: 1.25, fontSize: 11, color: 'text.disabled' }}>
          {version}
        </Typography>
        <Typography role="status" sx={{ px: 1.25, pt: 0.5, fontSize: 10.5, color: saveError ? 'error.main' : 'text.disabled' }}>
          {saveError ? t('settings.saveFailed') : saving ? t('settings.saving') : t('settings.autosave')}
        </Typography>
        {saveError && <Button size="small" onClick={onRetry}>{t('settings.retrySave')}</Button>}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ px: 3, pt: 2.25, pb: 1.5, flex: '0 0 auto', pr: 6 }}>
          <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.2 }}>
            {t(active.labelKey)}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5, lineHeight: 1.5 }}>
            {t(active.hintKey)}
          </Typography>
        </Box>
        <Box
          key={section}
          data-settings-content
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            px: 3,
            pb: 3,
            // One place to keep every control in this sheet on the 8px grid.
            '& .MuiOutlinedInput-root': { borderRadius: '8px' },
            '& .MuiInputBase-input': { fontSize: 12.5 },
            '& .MuiFormHelperText-root': { fontSize: 11 },
            '& .MuiButton-root': { fontSize: 12 }
          }}
        >
          {section === 'account' && <AccountSection settings={settings} patch={patch} />}
          {section === 'general' && <GeneralSection settings={settings} patch={patch} />}
          {section === 'shortcuts' && <ShortcutsSection settings={settings} patch={patch} />}
          {section === 'models' && <ProvidersSection settings={settings} patch={patch} />}
          {section === 'prompts' && <PromptsSection settings={settings} patch={patch} />}
          {section === 'routing' && <RoutingSection settings={settings} patch={patch} />}
          {section === 'search' && <SearchSection settings={settings} patch={patch} />}
          {section === 'guide' && <GuidePage embedded />}
          {section === 'about' && <AboutSection settings={settings} />}
        </Box>
      </Box>
    </Dialog>
  )
}
