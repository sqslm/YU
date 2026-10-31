import { MemorySection } from './sections/Memory'
import { useState } from 'react'
import { Box, Button, Dialog, IconButton, Tab, Tabs, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { GeneralSection, SpeechSection, InputSection, StorageSection, ReminderSettingsSection, AssistantSettingsSection } from './sections/General'
import { WakeWordSection } from './sections/WakeWordSection'
import { EntityEnhancement } from './sections/EntityEnhancement'
import { VoiceCommandsSection } from './sections/VoiceCommands'
import { ShortcutsSection } from './sections/Shortcuts'
import { ProvidersSection } from './sections/Providers'
import { PromptsSection } from './sections/Prompts'
import { RoutingSection } from './sections/Routing'
import { SearchSection } from './sections/Search'
import { ResourcesSection } from './sections/Resources'
import { LifeSection } from './sections/Life'
import { WorkflowsSection } from './sections/Workflows'
import { AccountSection } from './sections/Account'
import { AboutSection, useAppVersion } from './sections/About'
import { useTranslation } from 'react-i18next'
import {
  IconClose,
  IconCpu,
  IconInfo,
  IconWaveMic,
  IconFolder,
  IconBook,
  IconBolt,
  IconSliders,
  IconUser
} from './sections/General'
import LockOutlined from '@mui/icons-material/LockOutlined'
import i18n from '../i18n'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  settings: Settings
  patch: (value: Partial<Settings>) => void
  saving: boolean
  saveError: string
  onRetry: () => void
  initialSection?: string
}

/**
 * Section rail. Labels and hints are i18n keys, not text: this sheet is where a
 * non-Chinese user first lands, and a nav rail that stays Chinese next to a
 * translated app looks broken rather than unfinished.
 */
const SECTIONS = [
  { id: 'general', labelKey: 'settings.nav.general', hintKey: 'settings.hint.general', icon: <IconSliders />, pages: ['general'] },
  { id: 'speech', labelKey: '语音与输入', hintKey: '录音、语言、唤醒、语音指令与文本输入', icon: <IconWaveMic />, pages: ['speech', 'wake', 'commands', 'input', 'shortcuts'] },
  { id: 'models', labelKey: 'AI 与模型', hintKey: '连接模型，管理提示词、自动路由与搜索', icon: <IconCpu />, pages: ['models', 'prompts', 'routing', 'search'] },
  { id: 'assistant', labelKey: '助手与权限', hintKey: '工具权限、文件访问范围与本地检索', icon: <LockOutlined sx={{ fontSize: 16 }} />, pages: ['assistant'] },
  { id: 'life', labelKey: '日程与提醒', hintKey: '待办提醒、日程与每日简报', icon: <IconBook />, pages: ['life', 'reminders'] },
  { id: 'automation', labelKey: 'settings.nav.automation', hintKey: 'settings.hint.automation', icon: <IconBolt />, pages: ['automation'] },
  { id: 'storage', labelKey: '数据与性能', hintKey: '本地数据、历史保留与资源使用', icon: <IconFolder />, pages: ['storage', 'resources'] },
  { id: 'account', labelKey: 'settings.nav.account', hintKey: 'settings.hint.account', icon: <IconUser />, pages: ['account'] },
  { id: 'about', labelKey: 'settings.nav.about', hintKey: '产品理念、版本与诊断', icon: <IconInfo />, pages: ['about'] }
]
const PAGE_LABELS: Record<string, string> = {
  speech: '录音与语言', wake: '语音唤醒', commands: '语音指令', input: '文本插入', shortcuts: 'settings.nav.shortcuts',
  models: 'settings.nav.models', prompts: 'settings.nav.prompts', routing: 'settings.nav.routing', search: 'settings.nav.search',
  storage: 'settings.nav.storage', resources: 'settings.nav.resources', about: 'settings.nav.about',
  life: 'settings.nav.life', reminders: '提醒与待办', automation: 'settings.nav.automation',
}

export function SettingsDialog({
  open,
  onClose,
  settings,
  patch,
  saving,
  saveError,
  onRetry,
  initialSection = 'general'
}: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState(initialSection)
  const version = useAppVersion()
  const { t } = useTranslation()
  const active = SECTIONS.find((item) => item.pages.includes(section)) ?? SECTIONS[0]

  return (
    <Dialog
      open={open}
      onClose={onClose}
      aria-labelledby="settings-heading"
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 1080,
            maxWidth: '94vw',
            height: 780,
            maxHeight: '90vh',
            m: 0,
            borderRadius: '18px',
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
          width: { xs: 156, md: 204 },
          flex: '0 0 auto',
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'action.hover',
          pt: 3,
          pb: 2.5,
          px: 1.5,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <Typography
          sx={{
            px: 1.25,
            pb: 2.5,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.8,
            color: 'text.secondary'
          }}
        >
          {t('settings.title')}
        </Typography>
        <Box component="nav" aria-label={t('settings.title')} sx={{ display: 'flex', flexDirection: 'column', gap: '5px', overflowY: 'auto', minHeight: 0, pb: 1 }}>
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
                  minHeight: 40,
                  flexShrink: 0,
                  px: 1.25,
                  borderRadius: '9px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: selected ? 'primary.main' : 'text.secondary',
                  fontWeight: selected ? 600 : 400,
                  bgcolor: selected ? 'action.selected' : 'transparent',
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                  '&:hover': {
                    bgcolor: selected ? 'action.selected' : 'action.hover',
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
        <Typography sx={{ mt: 'auto', px: 1.25, pt: 2, fontSize: 11, color: 'text.secondary' }}>
          {version}
        </Typography>
        <Typography role="status" sx={{ px: 1.25, pt: 0.5, fontSize: 10.5, color: saveError ? 'error.main' : 'text.secondary' }}>
          {saveError ? t('settings.saveFailed') : saving ? t('settings.saving') : t('settings.autosave')}
        </Typography>
        {saveError && <Button size="small" onClick={onRetry}>{t('settings.retrySave')}</Button>}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ px: { xs: 2.5, md: 4 }, pt: 3.5, pb: 2.5, flex: '0 0 auto', pr: 6 }}>
          <Typography component="h2" id="settings-heading" sx={{ fontSize: 25, fontWeight: 650, letterSpacing: -.7 }}>
            {t(active.labelKey)}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: .75, lineHeight: 1.7 }}>
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
            px: { xs: 2.5, md: 4 },
            pt: 1,
            pb: 4,
            // One place to keep every control in this sheet on the 8px grid.
            '& .MuiOutlinedInput-root': { borderRadius: '8px' },
            '& .MuiInputBase-input': { fontSize: 12.5 },
            '& .MuiFormHelperText-root': { fontSize: 11 },
            '& .MuiButton-root': { fontSize: 12 }
          }}
        >
          {section === 'account' && <AccountSection settings={settings} patch={patch} />}
          {section === 'general' && <GeneralSection settings={settings} patch={patch} />}
          {section === 'speech' && <><SpeechSection settings={settings} patch={patch} /><EntityEnhancement settings={settings} patch={patch} /></>}
          {section === 'wake' && <WakeWordSection settings={settings} patch={patch} saving={saving} />}
          {section === 'commands' && <VoiceCommandsSection settings={settings} patch={patch} />}
          {section === 'input' && <InputSection settings={settings} patch={patch} />}
          {section === 'storage' && <StorageSection settings={settings} patch={patch} />}
          {section === 'life' && <LifeSection settings={settings} patch={patch} />}
          {section === 'reminders' && <ReminderSettingsSection settings={settings} patch={patch} />}
          {section === 'assistant' && <><MemorySection settings={settings} patch={patch} /><AssistantSettingsSection settings={settings} patch={patch} /></>}
          {section === 'automation' && <WorkflowsSection />}
          {section === 'shortcuts' && <ShortcutsSection settings={settings} patch={patch} />}
          {section === 'models' && <ProvidersSection settings={settings} patch={patch} saving={saving} saveError={saveError} />}
          {section === 'prompts' && <PromptsSection settings={settings} patch={patch} />}
          {section === 'routing' && <RoutingSection settings={settings} patch={patch} />}
          {section === 'search' && <SearchSection settings={settings} patch={patch} />}
          {section === 'resources' && <ResourcesSection settings={settings} patch={patch} />}
          {section === 'about' && <AboutSection />}
        </Box>
      </Box>
    </Dialog>
  )
}
