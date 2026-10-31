import { useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, IconButton, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import SearchRounded from '@mui/icons-material/SearchRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded'
import SettingsOutlined from '@mui/icons-material/SettingsOutlined'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
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
import { BriefingDeliverySection } from './sections/BriefingDelivery'
import { WorkflowsSection } from './sections/Workflows'
import { MemorySection } from './sections/Memory'
import { AccountSection } from './sections/Account'
import { AboutSection, useAppVersion } from './sections/About'
import { SETTINGS_GROUPS, SETTINGS_PAGES, searchSettings, settingsPageFor, type SettingsPageId } from './settingsNavigation'
import { useTranslation } from 'react-i18next'

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

export function SettingsDialog({ open, onClose, settings, patch, saving, saveError, onRetry, initialSection = 'general' }: SettingsDialogProps): JSX.Element {
  const [section, setSection] = useState(() => settingsPageFor(initialSection).id)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const version = useAppVersion()
  const { t } = useTranslation()
  const active = settingsPageFor(section)
  const group = SETTINGS_GROUPS.find(group => group.id === active.group)!
  const matches = searchSettings(query, key => t(key))
  const searching = query.trim().length > 0
  const choose = (id: SettingsPageId): void => { setSection(id); setQuery('') }
  const common = { settings, patch }

  const content = (): JSX.Element => {
    switch (section) {
      case 'general': return <GeneralSection {...common} />
      case 'shortcuts': return <ShortcutsSection {...common} />
      case 'speech': return <SpeechSection {...common} />
      case 'wake': return <WakeWordSection {...common} saving={saving} />
      case 'commands': return <VoiceCommandsSection {...common} />
      case 'input': return <InputSection {...common} />
      case 'entities': return <EntityEnhancement {...common} />
      case 'models': return <ProvidersSection {...common} saving={saving} saveError={saveError} service="llm" />
      case 'asr': return <ProvidersSection {...common} saving={saving} saveError={saveError} service="asr" />
      case 'tts': return <ProvidersSection {...common} saving={saving} saveError={saveError} service="tts" />
      case 'prompts': return <PromptsSection {...common} />
      case 'routing': return <RoutingSection {...common} />
      case 'search': return <SearchSection {...common} />
      case 'memory': return <MemorySection {...common} />
      case 'assistant': return <AssistantSettingsSection {...common} />
      case 'automation': return <WorkflowsSection />
      case 'life': return <LifeSection {...common} view="calendar" />
      case 'briefing': return <LifeSection {...common} view="briefing" />
      case 'delivery': return <BriefingDeliverySection {...common} saving={saving} saveError={saveError} />
      case 'reminders': return <ReminderSettingsSection {...common} />
      case 'storage': return <StorageSection {...common} />
      case 'resources': return <ResourcesSection {...common} />
      case 'account': return <AccountSection {...common} />
      case 'about': return <AboutSection />
      default: return <GeneralSection {...common} />
    }
  }

  return <Dialog open={open} onClose={onClose} aria-labelledby="settings-heading" maxWidth={false}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select()
      }
    }}
    slotProps={{ paper: { sx: {
      width: 1240, maxWidth: 'calc(100vw - 32px)', height: 840, maxHeight: 'calc(100vh - 64px)',
      m: 0, borderRadius: '18px', overflow: 'hidden', display: 'flex', flexDirection: 'row', bgcolor: 'background.default'
    } } }}>
    <Box component="aside" sx={{ width: { xs: 205, lg: 248 }, flexShrink: 0, bgcolor: 'background.paper', borderRight: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ px: 2.5, pt: 3, pb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2.5 }}>
          <SettingsOutlined sx={{ color: 'primary.main', fontSize: 21 }} />
          <Typography sx={{ fontSize: 18, fontWeight: 650, letterSpacing: -.4 }}>{t('settings.title')}</Typography>
          <Typography sx={{ ml: 'auto !important', color: 'text.secondary', fontSize: 10.5 }}>YU</Typography>
        </Stack>
        <TextField inputRef={searchInput} value={query} onChange={event => setQuery(event.target.value)}
          placeholder={t('搜索设置页面')} inputProps={{ 'aria-label': t('搜索设置页面'), 'aria-keyshortcuts': 'Control+K Meta+K' }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 17 }} /></InputAdornment>,
            endAdornment: <InputAdornment position="end">{query ? <IconButton size="small" aria-label={t('清除搜索')} onClick={() => { setQuery(''); searchInput.current?.focus() }}><CloseRounded sx={{ fontSize: 15 }} /></IconButton> : <Typography component="kbd" sx={{ fontFamily: 'inherit', fontSize: 9, color: 'text.secondary', pr: .75 }}>Ctrl K</Typography>}</InputAdornment> }}
          sx={{ '& input': { fontSize: 12, py: 1.1 }, '& .MuiOutlinedInput-root': { pr: .5 } }} />
      </Box>
      <Box component="nav" aria-label={t('settings.title')} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, px: 1.5, pb: 2 }}>
        {searching ? <>
          <Typography role="status" sx={{ px: 1, mb: 1, fontSize: 11, color: 'text.secondary' }}>{t('找到 {{count}} 个设置页面', { count: matches.length })}</Typography>
          {matches.length === 0 && <Box sx={{ px: 1, py: 3 }}><Typography sx={{ fontSize: 13, mb: 1 }}>{t('没有找到相关设置')}</Typography><Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.8 }}>{t('试试“麦克风”“模型”或“同步”。')}</Typography></Box>}
          {matches.map(page => <Button key={page.id} data-settings-result={page.id} onClick={() => choose(page.id)} fullWidth sx={{ justifyContent: 'flex-start', textAlign: 'left', px: 1.25, py: 1.25, mb: .5, color: 'text.primary' }}>
            <Box><Typography component="span" sx={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t(page.label)}</Typography><Typography component="span" sx={{ display: 'block', fontSize: 10.5, color: 'text.secondary', mt: .5 }}>{t(SETTINGS_GROUPS.find(group => group.id === page.group)!.label)}</Typography></Box>
          </Button>)}
        </> : SETTINGS_GROUPS.map(item => {
          const expanded = item.id === active.group
          const pages = SETTINGS_PAGES.filter(page => page.group === item.id)
          return <Box key={item.id} sx={{ mb: .75 }}>
            <Button data-section={item.id} aria-expanded={expanded} aria-controls={`settings-group-${item.id}`} onClick={() => choose(pages[0]!.id)} fullWidth
              sx={{ px: 1.25, py: 1.1, minHeight: 38, justifyContent: 'space-between', color: expanded ? 'text.primary' : 'text.secondary', fontWeight: expanded ? 650 : 500, fontSize: 12.5 }}>
              {t(item.label)}<ChevronRightRounded sx={{ fontSize: 16, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .16s ease' }} />
            </Button>
            <Box id={`settings-group-${item.id}`} hidden={!expanded} sx={{ ml: 1.25, pl: 1, my: .5, borderLeft: 1, borderColor: 'divider' }}>
              {pages.map(page => <Button key={page.id} data-settings-tab={page.id} aria-current={section === page.id ? 'page' : undefined} onClick={() => choose(page.id)} fullWidth
                sx={{ justifyContent: 'flex-start', px: 1.5, py: .8, minHeight: 34, mb: .25, borderRadius: '8px', fontSize: 12, fontWeight: section === page.id ? 650 : 400,
                  bgcolor: section === page.id ? 'action.selected' : 'transparent', color: section === page.id ? 'primary.main' : 'text.secondary' }}>{t(page.label)}</Button>)}
            </Box>
          </Box>
        })}
      </Box>
      <Box sx={{ borderTop: 1, borderColor: 'divider', px: 2.75, py: 1.75 }}><Typography sx={{ color: 'text.secondary', fontSize: 10.5 }}>{version}</Typography></Box>
    </Box>

    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Stack direction="row" alignItems="center" sx={{ px: { xs: 2.5, lg: 4 }, py: 1.5, gap: 1, borderBottom: 1, borderColor: 'divider', minHeight: 56 }}>
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{t('settings.title')}</Typography><ChevronRightRounded sx={{ fontSize: 13, color: 'text.secondary' }} />
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1 }}>{t(group.label)}</Typography>
        <Typography component="kbd" sx={{ fontFamily: 'inherit', fontSize: 10, color: 'text.secondary', border: 1, borderColor: 'divider', borderRadius: 1, px: .6 }}>Esc</Typography>
        <IconButton size="small" aria-label={t('关闭设置')} data-close onClick={onClose}><CloseRounded sx={{ fontSize: 18 }} /></IconButton>
      </Stack>
      {saveError && <Alert severity="error" sx={{ mx: 3, mt: 2 }} action={<Button color="inherit" size="small" onClick={onRetry}>{t('settings.retrySave')}</Button>}>{t('settings.saveFailed')} · {saveError}</Alert>}
      <Box key={section} data-settings-content={section} sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, px: { xs: 2.5, lg: 4 }, py: 3,
        '& .MuiInputBase-input': { fontSize: 13 }, '& .MuiFormHelperText-root': { fontSize: 11.5 }, '& .MuiButton-root': { fontSize: 12 } }}>
        <Box sx={{ maxWidth: 960, mx: 'auto', containerType: 'inline-size' }}>
          <Box component="header" sx={{ mb: 3 }}><Typography component="h2" id="settings-heading" sx={{ fontSize: 28, fontWeight: 650, letterSpacing: -.8, lineHeight: 1.4 }}>{t(active.label)}</Typography></Box>
          {content()}
        </Box>
      </Box>
      <Stack direction="row" spacing={.75} alignItems="center" role="status" aria-live="polite" sx={{ px: { xs: 2.5, lg: 4 }, py: 1.4, minHeight: 44, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper', color: saveError ? 'error.main' : 'text.secondary' }}>
        {saveError ? <ErrorOutlineRounded sx={{ fontSize: 14 }} /> : saving ? <CircularProgress size={12} color="inherit" /> : <CheckCircleOutlineRounded sx={{ fontSize: 14, color: 'primary.main' }} />}
        <Typography sx={{ fontSize: 11 }}>{saveError ? t('settings.saveFailed') : saving ? t('settings.saving') : section === 'delivery' ? t('投递配置需点击“保存”后生效。') : t('settings.autosave')}</Typography>
      </Stack>
    </Box>
  </Dialog>
}
