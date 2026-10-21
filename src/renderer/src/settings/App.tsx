import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  CssBaseline,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ThemeProvider,
  Typography
} from '@mui/material'
import { makeTheme, palettes, onSystemThemeChange, resolveThemeMode } from './theme'
import type { ThemeMode } from '@shared/types'
import { useSettings } from './useSettings'
import { SettingsDialog } from './SettingsDialog'
import { HomePage } from './pages/Home'
import { HistoryPage } from './pages/HistoryPage'
import { NotesPage } from './pages/NotesPage'
import { DictionaryPage } from './pages/Dictionary'
import { IconBook, IconChart, IconClock, IconMic, IconSettings } from './icons'
import { Onboarding } from './pages/Onboarding'
import StickyNote2Icon from '@mui/icons-material/StickyNote2'
import { useTranslation } from 'react-i18next'
import { applyUiLanguage } from '../i18n'
import i18n from '../i18n'

type Page = 'home' | 'history' | 'notes' | 'dictionary'

/** Label keys resolve through i18next; the ids stay stable for routing. */
const NAV: Array<{ id: Page; labelKey: string; icon: JSX.Element }> = [
  { id: 'home', labelKey: 'nav.home', icon: <IconChart /> },
  { id: 'history', labelKey: 'nav.history', icon: <IconClock /> },
  { id: 'notes', labelKey: 'nav.notes', icon: <StickyNote2Icon sx={{ fontSize: 18 }} /> },
  { id: 'dictionary', labelKey: 'nav.dictionary', icon: <IconBook /> }
]

export function App(): JSX.Element {
  const { settings, patch, saving, error, flush } = useSettings()
  const [page, setPage] = useState<Page>('home')
  /** Scene name the home page asked to look up; history seeds its search box with it. */
  const [historyQuery, setHistoryQuery] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * Bumped every time the global 随记录音 chord fires. The notes page owns the
   * recorder, so the hub only has to switch pages and hand it a fresh ticket —
   * mounting the page and toggling in the same tick is what makes the shortcut
   * work from an app the user was typing in.
   */
  const [recordTicket, setRecordTicket] = useState(0)
  /**
   * The tour lives in settings, not in `localStorage`: clearing the cache must
   * not replay onboarding, and a tester can replay it by flipping one key.
   */
  const tour = settings ? !settings.onboarded && page === 'home' : false
  /** Any exit path (finish or skip) marks the tour done, so it never nags twice. */
  const dismissTour = (): void => {
    void patch({ onboarded: true })
  }
  const { t: translate } = useTranslation()

  /**
   * `themeMode` is the stored preference; `mode` is what actually paints. The
   * third option is `'system'`, which is resolved here against the OS and
   * re-resolved whenever Windows flips — the choice lives in 设置 → 通用 → 外观 → 主题.
   */
  const themeMode: ThemeMode = settings?.themeMode ?? 'dark'
  const [systemMode, setSystemMode] = useState<'dark' | 'light'>(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemMode(resolveThemeMode('system'))), [])
  const mode: 'dark' | 'light' = themeMode === 'system' ? systemMode : themeMode
  const theme = useMemo(() => makeTheme(mode), [mode])
  const t = palettes[mode]

  // The window buttons are drawn above the page, so the dialog that dims the
  // page has to tell main to dim them too.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.app?.setChromeDim) return
    void window.api.app.setChromeDim(settingsOpen)
  }, [settingsOpen])

  // `settings.uiLanguage` drives i18next; every `t()` consumer re-renders on flip.
  // It is not `settings.language` — that one is the recogniser hint, and sharing the
  // field meant picking a dictation language also translated the interface.
  const language = settings?.uiLanguage
  useEffect(() => {
    if (language) applyUiLanguage(language)
  }, [language])

  // Ctrl+, mirrors the reference app's shortcut for opening preferences.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The 随记录音 chord: show the notes page, then let it start (or stop) the take.
  useEffect(() => {
    return window.api.notes.onRecordHotkey(() => {
      setPage('notes')
      setRecordTicket((ticket) => ticket + 1)
    })
  }, [])

  const body = (): JSX.Element => {
    if (!settings) return <Typography color="text.secondary">{i18n.t(i18n.t('读取设置…'))}</Typography>
    if (page === 'history') {
      return <HistoryPage settings={settings} patch={patch} initialQuery={historyQuery} />
    }
    if (page === 'notes') return <NotesPage settings={settings} patch={patch} recordTicket={recordTicket} />
    if (page === 'dictionary') return <DictionaryPage settings={settings} patch={patch} />
    return (
      <HomePage
        settings={settings}
        mode={mode}
        onOpenHistory={(query) => {
          setHistoryQuery(query)
          setPage('history')
        }}
      />
    )
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          display: 'flex',
          height: '100vh',
          overflow: 'hidden',
          bgcolor: t.canvas,
          color: t.text,
          position: 'relative'
        }}
      >
        {/* Frameless window: this invisible strip drags the window like a title bar. */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 40,
            zIndex: 2,
            WebkitAppRegion: 'drag'
          }}
        />
        {/* The native title bar is gone; this strip is the window drag handle. */}
        <Box
          sx={{
            width: 208,
            flex: '0 0 auto',
            bgcolor: t.sidebar,
            borderRight: `1px solid ${t.line}`,
            display: 'flex',
            flexDirection: 'column',
            pt: '40px'
          }}
        >
          <Box sx={{ px: 2, pb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              sx={{
                width: 26,
                height: 26,
                borderRadius: '8px',
                display: 'grid',
                placeItems: 'center',
                background: 'linear-gradient(140deg,#4c8dff,#8f7cff)',
                color: '#fff'
              }}
            >
              <IconMic size={15} />
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>
                Typeless Rebuild
              </Typography>
              <Typography sx={{ fontSize: 10.5, color: t.textFaint, mt: 0.25 }}>
                {i18n.t('自建后端 · 本地')}
              </Typography>
            </Box>
          </Box>

          <List dense sx={{ px: 1, py: 1 }}>
            {NAV.map((item) => (
              <ListItemButton
                key={item.id}
                selected={page === item.id}
                onClick={() => setPage(item.id)}
                sx={{ mb: 0.25, py: 0.75 }}
              >
                <ListItemIcon sx={{ minWidth: 30, color: 'inherit' }}>{item.icon}</ListItemIcon>
                <ListItemText
                  primary={translate(item.labelKey)}
                  primaryTypographyProps={{ fontSize: 13, fontWeight: 500 }}
                />
              </ListItemButton>
            ))}
          </List>

          {/* The footer row carries both icons the user was mixing up: the settings
              entry (gear + label) on the left and the theme switch on the right.
              The version string moved into the settings sheet, so the hub window
              no longer shows any build text. */}
          <Box
            id="sidebar-footer"
            sx={{
              mt: 'auto',
              flex: '0 0 auto',
              height: 44,
              px: 1.5,
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <Box
              role="button"
              tabIndex={0}
              data-settings-entry
              aria-label={translate('nav.settings')}
              onClick={() => setSettingsOpen(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSettingsOpen(true)
                }
              }}
              sx={settingsEntrySx(t)}
            >
              <IconSettings size={15} />
              <Box component="span">{translate('nav.settings')}</Box>
            </Box>
          </Box>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ height: 40, flex: '0 0 auto' }} />
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{body()}</Box>
        </Box>
      </Box>

      {settings && settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => { void flush(); setSettingsOpen(false) }}
          saving={saving}
          saveError={error}
          onRetry={() => void flush()}
          settings={settings}
          patch={patch}
        />
      )}

      {tour && (
        <Onboarding
          onDone={dismissTour}
          server={settings?.syncServerUrl ?? ''}
          onServerChange={(value) => void patch({ syncServerUrl: value })}
        />
      )}
    </ThemeProvider>
  )
}

/** The footer's settings entry. */
interface FooterTokens {
  textDim: string
  text: string
  accent: string
}

const hoverSurface = 'rgba(127,127,127,.14)'

/** Gear + label. */
const settingsEntrySx = (t: FooterTokens) =>
  ({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    height: 30,
    px: '7px',
    borderRadius: 2,
    color: t.textDim,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    userSelect: 'none',
    '&:hover': { bgcolor: hoverSurface, color: t.text },
    '&:focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: 1 }
  }) as const

