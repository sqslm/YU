import { prepareForGameMode } from './gameModePreparation'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import {
  Box,
  CssBaseline,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ThemeProvider,
  Tooltip,
  Typography
} from '@mui/material'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { makeTheme, skinFor, onSystemThemeChange, resolveThemeMode } from './theme'
import type { ThemeMode, ThemePack } from '@shared/types'
import type { LocalRecord } from '@shared/workspace'
import { useSettings } from './useSettings'
import { SettingsDialog } from './SettingsDialog'
import { HomePage } from './pages/Home'
import { ChatPage } from './pages/ChatPage'
import { WorkspaceSearch } from './WorkspaceSearch'
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded'
import { HistoryPage } from './pages/HistoryPage'
import { NotesPage } from './pages/NotesPage'
import { RemindersPage } from './pages/RemindersPage'
import { CalendarPage } from './pages/CalendarPage'
import type { ReminderView } from '@shared/reminders'
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone'
import HubRounded from '@mui/icons-material/HubRounded'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import { DictionaryPage } from './pages/Dictionary'
import { IconBook, IconChart, IconClock, IconSettings } from './icons'
import { Onboarding } from './pages/Onboarding'
import StickyNote2Icon from '@mui/icons-material/StickyNote2'
import { useTranslation } from 'react-i18next'
import { PaginationSettings } from './Pagination'
import { applyUiLanguage } from '../i18n'
import i18n from '../i18n'
import { BrandLogo } from '../BrandLogo'
import { MissedReminders } from './MissedReminders'
import { UpdatePill } from './UpdatePill'
import { QuotaProvider, QuotaSidebar } from './Quota'

/** The library pulls in the force canvas, so it never enters the first-screen chunk. */
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then((module) => ({ default: module.KnowledgePage })))

type Page = 'chat' | 'home' | 'history' | 'knowledge' | 'notes' | 'dictionary' | 'reminders' | 'calendar'

/** Label keys resolve through i18next; the ids stay stable for routing. */
const NAV: Array<{ id: Page; labelKey: string; icon: JSX.Element }> = [
  { id: 'chat', labelKey: '语', icon: <ChatBubbleOutlineRounded sx={{ fontSize: 18 }} /> },
  { id: 'home', labelKey: 'nav.home', icon: <IconChart /> },
  { id: 'notes', labelKey: 'nav.notes', icon: <StickyNote2Icon sx={{ fontSize: 18 }} /> },
  { id: 'knowledge', labelKey: 'nav.knowledge', icon: <HubRounded sx={{ fontSize: 18 }} /> },
  { id: 'reminders', labelKey: '提醒与待办', icon: <NotificationsNoneIcon sx={{ fontSize: 18 }} /> },
  { id: 'calendar', labelKey: '日程', icon: <CalendarMonthIcon sx={{ fontSize: 18 }} /> },
  { id: 'history', labelKey: 'nav.history', icon: <IconClock /> },
  { id: 'dictionary', labelKey: 'nav.dictionary', icon: <IconBook /> }
]

export function App(): JSX.Element {
  const { settings, patch, saving, error, flush } = useSettings()
  useEffect(() => window.api.app.onPrepareForGameMode(prepareForGameMode), [])
  const [page, setPage] = useState<Page>('home')
  /**
   * The rail collapses the chrome to icons only, so chat and notes get the whole
   * window. `localStorage` (not settings) because it is a window preference, the
   * same reason the sidebar width is not synced to the cloud either.
   */
  const [rail, setRail] = useState<boolean>(() => { try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false } })
  const toggleRail = (): void => setRail((value) => {
    const next = !value
    try { localStorage.setItem(RAIL_KEY, next ? '1' : '0') } catch { /* a locked profile keeps the default */ }
    return next
  })
  const [chatVisited, setChatVisited] = useState(false)
  useEffect(() => { if (page === 'chat') setChatVisited(true) }, [page])
  const [reminderView, setReminderView] = useState<ReminderView | null>(null)
  const [noteToOpen, setNoteToOpen] = useState<{ id: string } | undefined>()
  useEffect(() => {
    const open = (view: ReminderView): void => { setReminderView(view); setSettingsOpen(false); setPage('reminders') }
    const takeView = (): void => { void window.api.reminders.view().then(view => { if (view) open(view) }) }
    const off = window.api.reminders.onOpen(takeView)
    takeView()
    return off
  }, [])
  /** Scene name the home page asked to look up; history seeds its search box with it. */
  const [historyQuery, setHistoryQuery] = useState<string | undefined>(undefined)
  const [historyId, setHistoryId] = useState<string | undefined>()
  const [eventToOpen, setEventToOpen] = useState<LocalRecord | undefined>()
  const [chatToOpen, setChatToOpen] = useState<LocalRecord | undefined>()
  const openRecord = async (input: LocalRecord): Promise<void> => {
    const record = await window.api.workspace.get(input)
    setSettingsOpen(false)
    if (record.kind === 'note') { setNoteToOpen({ id: record.id }); setPage('notes') }
    else if (record.kind === 'history') { setHistoryId(record.id); setHistoryQuery(''); setPage('history') }
    else if (record.kind === 'reminder') { setReminderView({ id: record.id }); setPage('reminders') }
    else if (record.kind === 'event') { setEventToOpen(record); setCalendarTab('schedule'); setPage('calendar') }
    else if (record.kind === 'chat') { setChatToOpen(record); setPage('chat') }
  }
  /**
   * 简报 lives inside 日程 now, so the calendar owns which of the two panes is
   * showing. It is held here because the assistant still navigates to the
   * briefing by name (`hubView().page === 'briefing'`).
   */
  const [calendarTab, setCalendarTab] = useState<'schedule' | 'briefing'>('schedule')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [replayTour, setReplayTour] = useState(false)
  const [settingsSection, setSettingsSection] = useState('general')
  useEffect(() => {
    const navigate = (): void => { void window.api.assistant.hubView().then(view => {
      if (!view) return
      if (view.page === 'settings') setSettingsSection('general')
      setSettingsOpen(view.page === 'settings')
      if (view.page === 'notes') setNoteToOpen(view.noteId ? { id: view.noteId } : undefined)
      // 简报 is a pane of 日程 now: the assistant's "打开简报" lands on it.
      if (view.page === 'briefing') setCalendarTab('briefing')
      if (view.page !== 'settings') setPage(view.page === 'overview' ? 'home' : view.page === 'corrections' ? 'dictionary' : view.page === 'briefing' ? 'calendar' : view.page)
    }) }
    const off = window.api.assistant.onNavigate(navigate)
    navigate()
    return off
  }, [])
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
  const tour = settings ? (!settings.onboarded || replayTour) && page === 'home' : false
  /** Any exit path (finish or skip) marks the tour done, so it never nags twice. */
  const dismissTour = async (): Promise<void> => {
    await flush()
    await window.api.settings.update({ onboarded: true })
    setReplayTour(false)
  }
  const { t: translate } = useTranslation()

  /**
   * `themeMode` is the stored preference; `mode` is what actually paints. The
   * third option is `'system'`, which is resolved here against the OS and
   * re-resolved whenever Windows flips — the choice lives in 设置 → 通用 → 外观 → 主题.
   *
   * `themePack` is the second, independent dial: it chooses the visual language
   * (shipped palette or Apple), while `mode` still chooses light or dark inside
   * that language. Both feed one `makeTheme` call and one skin lookup.
   */
  const themeMode: ThemeMode = settings?.themeMode ?? 'dark'
  const [systemMode, setSystemMode] = useState<'dark' | 'light'>(() => resolveThemeMode('system'))
  useEffect(() => onSystemThemeChange(() => setSystemMode(resolveThemeMode('system'))), [])
  const mode: 'dark' | 'light' = themeMode === 'system' ? systemMode : themeMode
  const pack: ThemePack = settings?.themePack ?? 'classic'
  const theme = useMemo(() => makeTheme(mode, pack), [mode, pack])
  const t = skinFor(pack, mode)

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
        setSettingsSection('general')
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
      return <HistoryPage key={historyId ?? 'all'} settings={settings} patch={patch} initialQuery={historyQuery} initialId={historyId} onClearFocus={() => setHistoryId(undefined)} />
    }
    if (page === 'notes') return <NotesPage settings={settings} patch={patch} recordTicket={recordTicket} openNote={noteToOpen} />
    if (page === 'knowledge') {
      return (
        <Suspense fallback={null}>
          <KnowledgePage settings={settings} patch={patch} openRecord={openRecord} />
        </Suspense>
      )
    }
    if (page === 'reminders') return <RemindersPage view={reminderView} onViewConsumed={() => setReminderView(null)} onOpenNote={id => { setNoteToOpen({ id }); setPage('notes') }} />
    if (page === 'calendar') return (
      <CalendarPage
        settings={settings}
        tab={calendarTab}
        focusEvent={eventToOpen}
        onTab={setCalendarTab}
        onOpenSettings={() => { setSettingsSection('life'); setSettingsOpen(true) }}
      />
    )
    if (page === 'dictionary') return <DictionaryPage settings={settings} patch={patch} />
    return (
      <HomePage
        onGuide={() => setReplayTour(true)}
        settings={settings}
        mode={mode}
        onOpenPage={(id) => { if (id === 'notes') setNoteToOpen(undefined); setPage(id) }}
        onOpenNote={(id) => { setNoteToOpen({ id }); setPage('notes') }}
        onOpenSettings={(section) => { setSettingsSection(section); setSettingsOpen(true) }}
        onOpenHistory={(query) => {
          setHistoryQuery(query)
          setPage('history')
        }}
      />
    )
  }

  return (
    <ThemeProvider theme={theme}>
    <PaginationSettings.Provider value={{ size: settings?.listPageSize ?? 30, change: size => patch({ listPageSize: size }) }}>
    <QuotaProvider settings={settings} saving={saving || Boolean(error)}>
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
          component="aside"
          data-app-sidebar
          data-rail={rail ? 'on' : 'off'}
          sx={{
            width: rail ? RAIL_WIDTH : 216,
            flex: '0 0 auto',
            bgcolor: t.sidebar,
            borderRight: `1px solid ${t.line}`,
            display: 'flex',
            flexDirection: 'column',
            pt: '40px',
            overflow: 'hidden',
            // Width, not `display`, so the page beside it slides instead of jumping.
            transition: 'width .24s cubic-bezier(.4,0,.2,1)',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' }
          }}
        >
          <Box sx={{ px: rail ? 0 : 2.75, pt: 1, pb: 3, display: 'flex', alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start', gap: 0.5, minHeight: 60 }}>
            <Box
              aria-hidden={rail}
              sx={{ minWidth: 0, overflow: 'hidden', flex: rail ? 0 : 1, opacity: rail ? 0 : 1, transition: 'opacity .16s ease' }}
            >
              <Box sx={{ filter: 'grayscale(1)' }}><BrandLogo mode={mode} width={112} /></Box>
            </Box>
            <Tooltip title={translate(rail ? '展开侧边栏' : '收起侧边栏')} placement="right">
              <IconButton
                size="small"
                data-sidebar-toggle
                aria-label={translate(rail ? '展开侧边栏' : '收起侧边栏')}
                aria-expanded={!rail}
                onClick={toggleRail}
                sx={{ flexShrink: 0, borderRadius: 2, color: t.textDim, '&:hover': { bgcolor: hoverSurface, color: t.text } }}
              >
                {rail ? <ChevronRightRounded sx={{ fontSize: 18 }} /> : <ChevronLeftRounded sx={{ fontSize: 18 }} />}
              </IconButton>
            </Tooltip>
          </Box>

          <List component="nav" aria-label={translate('工作空间')} dense sx={{ px: rail ? 1 : 1.5, py: 0, overflowY: 'auto', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: rail ? 'center' : 'flex-start', px: rail ? 0 : 1, mb: 1.5 }}><WorkspaceSearch rail={rail} onOpen={openRecord} /></Box>
            {NAV.map((item) => (
              <Box key={item.id}>
              {['chat', 'notes', 'history'].includes(item.id) && !rail && <Typography component="div" sx={{ px: 1.5, pt: item.id === 'chat' ? 0 : 2.5, pb: 1, fontSize: 10, letterSpacing: 1.2, color: t.textFaint, fontWeight: 600 }}>{translate(item.id === 'chat' ? '工作空间' : item.id === 'notes' ? '日常' : '资料库')}</Typography>}
              {rail && ['notes', 'history'].includes(item.id) && <Box sx={{ mx: 1, my: 1.5, borderTop: `1px solid ${t.line}` }} />}
              <Tooltip title={rail ? translate(item.labelKey) : ''} placement="right">
                <ListItemButton
                  aria-current={page === item.id ? 'page' : undefined}
                  selected={page === item.id}
                  onClick={() => setPage(item.id)}
                  sx={{
                    mb: 0.5,
                    py: 1,
                    px: rail ? 0 : 1.5,
                    minHeight: 40,
                    minWidth: 0,
                    position: 'relative',
                    '&.Mui-selected::before': { content: '""', position: 'absolute', left: 0, top: 13, bottom: 13, width: 3, bgcolor: t.accent, borderRadius: 2 },
                    justifyContent: rail ? 'center' : 'flex-start',
                    '& .MuiListItemIcon-root': { minWidth: rail ? 0 : 30, justifyContent: 'center' }
                  }}
                >
                  <ListItemIcon sx={{ color: 'inherit' }}>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={translate(item.labelKey)}
                    sx={{ display: rail ? 'none' : 'block', whiteSpace: 'nowrap' }}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: page === item.id ? 650 : 450, noWrap: true }}
                  />
                </ListItemButton>
              </Tooltip>
              </Box>
            ))}
          </List>

          {/* Settings, update availability and model allowance share the footer. */}
          <Box
            id="sidebar-footer"
            sx={{
              mt: 'auto',
              flex: '0 0 auto',
              minHeight: 64,
              px: rail ? 0 : 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: rail ? 'center' : 'flex-start',
              gap: 0.5,
              borderTop: `1px solid ${t.line}`,
              overflow: 'hidden'
            }}
          >
            <Tooltip title={rail ? translate('nav.settings') : ''} placement="right">
              <Box
                role="button"
                tabIndex={0}
                data-settings-entry
                aria-label={translate('nav.settings')}
                onClick={() => { setSettingsSection('general'); setSettingsOpen(true) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSettingsSection('general')
                    setSettingsOpen(true)
                  }
                }}
                sx={settingsEntrySx(t, rail)}
              >
                <IconSettings size={15} />
                {!rail && <Box component="span">{translate('nav.settings')}</Box>}
              </Box>
            </Tooltip>
            {/* Both badges need room for text, so the rail keeps only the gear. */}
            {!rail && <UpdatePill />}
            {!rail && <QuotaSidebar />}
          </Box>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ height: 40, flex: '0 0 auto' }} />
          <MissedReminders />
          {/* `scrollbarGutter: stable` reserves the bar's width even while the
              page is short. Without it a page that grows past the fold narrows
              its own content by 15px, and any element sized from that width —
              the history heat grid is one — resizes, changes the page height,
              and can toggle the very scrollbar that caused it: an endless
              layout loop that reads as the whole window shaking. */}
          <Box
            data-hub-scroll
            sx={{
              flex: 1,
              minHeight: 0,
              scrollbarGutter: 'stable',
              overflow: page === 'home' || page === 'chat' ? 'hidden' : 'auto'
            }}
          >
            {page !== 'chat' && body()}
            {(page === 'chat' || chatVisited) && <Box sx={{ display: page === 'chat' ? 'block' : 'none', height: '100%' }}><ChatPage focusRecord={chatToOpen} onOpenRecord={openRecord} onModels={() => { setSettingsSection('models'); setSettingsOpen(true) }} /></Box>}
          </Box>
        </Box>
      </Box>

      {settings && settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          initialSection={settingsSection}
          onClose={() => { void flush(); setSettingsOpen(false) }}
          saving={saving}
          saveError={error}
          onRetry={() => void flush()}
          settings={settings}
          patch={patch}
        />
      )}

      {tour && (
        <Onboarding settings={settings!} patch={patch} saving={saving} saveError={error} onRetry={() => void flush()}
          onDone={dismissTour}
        />
      )}
    </QuotaProvider>
    </PaginationSettings.Provider>
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

/** Persisted per machine: the rail is a window preference, not a synced setting. */
const RAIL_KEY = 'app.sidebar.rail'
const RAIL_WIDTH = 60

/** Gear + label. Collapsed to a square icon so the rail stays one icon wide. */
const settingsEntrySx = (t: FooterTokens, rail = false) =>
  ({
    display: 'flex',
    alignItems: 'center',
    gap: rail ? 0 : '7px',
    flexShrink: 0,
    justifyContent: rail ? 'center' : 'flex-start',
    whiteSpace: 'nowrap',
    height: 30,
    width: rail ? 30 : undefined,
    px: rail ? 0 : '7px',
    borderRadius: 2,
    color: t.textDim,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    userSelect: 'none',
    '&:hover': { bgcolor: hoverSurface, color: t.text },
    '&:focus-visible': { outline: `2px solid ${t.accent}`, outlineOffset: 1 }
  }) as const

