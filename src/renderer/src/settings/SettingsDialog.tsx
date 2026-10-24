import { useState } from 'react'
import { Box, Button, Dialog, IconButton, Tab, Tabs, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { GeneralSection, SpeechSection, InputSection, StorageSection } from './sections/General'
import { ShortcutsSection } from './sections/Shortcuts'
import { ProvidersSection } from './sections/Providers'
import { PromptsSection } from './sections/Prompts'
import { RoutingSection } from './sections/Routing'
import { SearchSection } from './sections/Search'
import { ResourcesSection } from './sections/Resources'
import { AccountSection } from './sections/Account'
import { AboutSection, useAppVersion } from './sections/About'
import { GuidePage } from './pages/Guide'
import { useTranslation } from 'react-i18next'
import {
  IconClose,
  IconCpu,
  IconInfo,
  IconWaveMic,
  IconFolder,
  IconSliders,
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
  { id: 'general', labelKey: 'settings.nav.general', hintKey: 'settings.hint.general', icon: <IconSliders />, pages: ['general'] },
  { id: 'speech', labelKey: '语音与输入', hintKey: '录音、翻译、文本处理与快捷键', icon: <IconWaveMic />, pages: ['speech', 'input', 'shortcuts'] },
  { id: 'models', labelKey: 'AI 与模型', hintKey: '连接模型，管理提示词、自动路由与搜索', icon: <IconCpu />, pages: ['models', 'prompts', 'routing', 'search'] },
  { id: 'storage', labelKey: '数据与性能', hintKey: '本地数据、历史保留与资源使用', icon: <IconFolder />, pages: ['storage', 'resources'] },
  { id: 'account', labelKey: 'settings.nav.account', hintKey: 'settings.hint.account', icon: <IconUser />, pages: ['account'] },
  { id: 'about', labelKey: '帮助与关于', hintKey: '使用说明、版本信息与问题诊断', icon: <IconInfo />, pages: ['about', 'guide', 'diagnostics'] }
]
const PAGE_LABELS: Record<string, string> = {
  speech: 'settings.nav.speech', input: 'settings.nav.input', shortcuts: 'settings.nav.shortcuts',
  models: 'settings.nav.models', prompts: 'settings.nav.prompts', routing: 'settings.nav.routing', search: 'settings.nav.search',
  storage: 'settings.nav.storage', resources: 'settings.nav.resources', about: 'settings.nav.about', guide: 'settings.nav.guide', diagnostics: '诊断'
}

export function SettingsDialog({
  open,
  onClose,
  settings,
  patch,
  saving,
  saveError,
  onRetry
}: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState('general')
  const version = useAppVersion()
  const { t } = useTranslation()
  const active = SECTIONS.find((item) => item.pages.includes(section)) ?? SECTIONS[0]

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
        <Box component="nav" aria-label={t('settings.title')} sx={{ display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', minHeight: 0, pb: 1 }}>
          {SECTIONS.map((item) => {
            const selected = item.pages.includes(section)
            return (
              <Box
                component="button"
                type="button"
                key={item.id}
                data-section={item.id}
                aria-current={selected ? 'page' : undefined}
                onClick={() => setSection(item.pages[0])}
                sx={{
                  display: 'flex',
                  border: 0,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  alignItems: 'center',
                  gap: 1.25,
                  minHeight: 32,
                  flexShrink: 0,
                  px: 1.25,
                  borderRadius: '7px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: selected ? 'text.primary' : 'text.secondary',
                  fontWeight: selected ? 600 : 400,
                  bgcolor: selected ? 'rgba(127,127,127,.14)' : 'transparent',
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
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
        {active.pages.length > 1 && <Tabs value={section} onChange={(_e, page) => setSection(page)} variant="scrollable" scrollButtons="auto" sx={{ px: 2, mb: 1, minHeight: 38, borderBottom: 1, borderColor: 'divider' }}>
          {active.pages.map(page => <Tab key={page} value={page} data-settings-tab={page} label={t(PAGE_LABELS[page])} sx={{ minHeight: 38, minWidth: 68, fontSize: 12, px: 1.5 }} />)}
        </Tabs>}
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
          {section === 'speech' && <SpeechSection settings={settings} patch={patch} />}
          {section === 'input' && <InputSection settings={settings} patch={patch} />}
          {section === 'storage' && <StorageSection settings={settings} patch={patch} />}
          {section === 'shortcuts' && <ShortcutsSection settings={settings} patch={patch} />}
          {section === 'models' && <ProvidersSection settings={settings} patch={patch} />}
          {section === 'prompts' && <PromptsSection settings={settings} patch={patch} />}
          {section === 'routing' && <RoutingSection settings={settings} patch={patch} />}
          {section === 'search' && <SearchSection settings={settings} patch={patch} />}
          {section === 'resources' && <ResourcesSection settings={settings} patch={patch} />}
          {section === 'guide' && <GuidePage embedded />}
          {(section === 'about' || section === 'diagnostics') && <AboutSection diagnosticsOnly={section === 'diagnostics'} />}
        </Box>
      </Box>
    </Dialog>
  )
}
