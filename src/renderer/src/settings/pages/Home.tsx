import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Button, ButtonBase, Checkbox, IconButton, Skeleton, Tab, Tabs, Tooltip, Typography } from '@mui/material'
import ArrowForward from '@mui/icons-material/ArrowForward'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import KeyboardOutlined from '@mui/icons-material/KeyboardOutlined'
import HistoryRounded from '@mui/icons-material/HistoryRounded'
import GraphicEqRounded from '@mui/icons-material/GraphicEqRounded'
import CalendarMonth from '@mui/icons-material/CalendarMonthOutlined'
import CheckCircle from '@mui/icons-material/CheckCircleOutline'
import type { Settings } from '@shared/types'
import { formatEventTime } from '@shared/calendar'
import { isOverdue } from '@shared/reminders'
import { UsageInsights } from './UsageInsights'
import { todayFromStats, clock } from './overview'
import { loadHomeData, openTodos, recentActivity, todayAgenda, todoTime, type HomeData } from './homeView'
import { modeLabel } from './historyView'
import { useTranslation } from 'react-i18next'

interface HomeProps {
  onGuide?: () => void
  settings: Settings
  mode: 'dark' | 'light'
  onOpenHistory: (query?: string) => void
  /** The briefing is its own page, so this page no longer links to it. */
  onOpenPage: (page: 'notes' | 'reminders' | 'calendar') => void
  onOpenNote: (id: string) => void
  onOpenSettings: (section: 'models' | 'shortcuts' | 'automation') => void
}

const SECTION_KEYS: Record<keyof HomeData, string> = {
  events: '日程', todos: '提醒与待办', notes: '随记',
  history: '历史记录', workflows: '自动化', stats: '使用统计'
}
const focusSx = { '&:focus-visible, &.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3 } }
const clipSx = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

export function HomePage({ settings, mode, onOpenHistory, onOpenPage, onOpenNote, onOpenSettings, onGuide }: HomeProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  const [data, setData] = useState<Partial<HomeData>>({})
  const [errors, setErrors] = useState<Awaited<ReturnType<typeof loadHomeData>>['errors']>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now)
  const [statsTab, setStatsTab] = useState<'today' | 'chart'>('today')
  const [actionError, setActionError] = useState('')
  const [completing, setCompleting] = useState<string | null>(null)
  const request = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++request.current
    const at = Date.now()
    const result = await loadHomeData(window.api, at)
    if (request.current !== ticket) return
    setData(previous => ({ ...previous, ...result.data }))
    setErrors(result.errors)
    setNow(at)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
    const refresh = (): void => { if (document.visibilityState === 'visible') void reload() }
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const off = [window.api.life.onChanged(refresh), window.api.reminders.onChanged(refresh),
      window.api.notes.onChanged(refresh), window.api.workflow.onChanged(refresh), window.api.life.onBriefing(refresh)]
    return () => {
      ++request.current
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      off.forEach(unsubscribe => unsubscribe())
    }
  }, [reload])

  const agenda = todayAgenda(data.events ?? [], now)
  const todos = openTodos(data.todos ?? [], now)
  const overdue = todos.filter(row => isOverdue(row, now)).length
  const activity = recentActivity(data.history ?? [], data.notes ?? [])
  const today = data.stats ? todayFromStats(data.stats, now) : null
  const totals = data.stats ? Object.values(data.stats.days).reduce((sum, day) => ({ units: sum.units + day.units, records: sum.records + day.records, days: sum.days + Number(day.records > 0) }), { units: 0, records: 0, days: 0 }) : null
  const hasTextModel = settings.profiles.some(profile => profile.enabled && profile.kind === 'llm' && profile.model.trim() && profile.baseUrl.trim())
  /**
   * Panel chrome. Padding is deliberately one step tighter than the old
   * `2.75`: the columns are content-driven now, and 2.5 keeps the panel
   * rhythm while giving the rows back the space the fixed heights used to eat.
   */
  const panelSx = { border: '1px solid', borderColor: 'divider', borderRadius: '16px', bgcolor: 'background.paper', p: { xs: 2, lg: 2.5 }, minWidth: 0 }

  const complete = async (id: string): Promise<void> => {
    setCompleting(id); setActionError('')
    try { await window.api.reminders.action(id, 'complete'); await reload() }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
    finally { setCompleting(null) }
  }

  const empty = (section: keyof HomeData, text: string): ReactNode => loading
    ? <Box aria-label={t('读取中…')} role="status" sx={{ py: 1.25 }}><Skeleton width="72%" /><Skeleton width="48%" /></Box>
    : <Typography sx={{ color: 'text.secondary', fontSize: 12.5, lineHeight: 1.7, py: 1.25 }}>
        {data[section] === undefined ? t('暂时无法读取，请刷新重试') : text}
      </Typography>

  return (
    <Box component="main" data-home-workspace sx={{ px: { xs: 2.5, md: 4, lg: 5 }, pt: { xs: 1.5, md: 2.5 }, pb: 2, maxWidth: 1500, mx: 'auto', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2.5,
      // The chart needs room of its own, so in that tab the page scrolls instead
      // of squeezing the panels into half a card.
      overflow: statsTab === 'chart' ? 'auto' : 'hidden',
      '@media (max-height: 700px), (max-width: 900px)': { overflowY: 'auto', '& > [data-home-panels]': { flex: '0 0 auto', minHeight: 360 }, '& > [data-home-panels] > section': { overflowY: 'visible' } },
      '& .MuiButton-root': focusSx, '& .MuiButtonBase-root': { transition: 'background-color .16s ease', ...focusSx } }}>
      <Box component="header" sx={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: 11, fontWeight: 500, color: 'text.secondary', letterSpacing: .7, mb: 1 }}>
            {new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)}
          </Typography>
          <Typography component="h1" sx={{ fontSize: { xs: 26, lg: 32 }, lineHeight: 1.35, fontWeight: 650, letterSpacing: -1 }}>{t('语，与你常在')}<Box component="span" sx={{ color: 'primary.main' }}>.</Box></Typography>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: 1 }}>{t('记录想法，安排事务，交给助手处理')}</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!hasTextModel && <Button size="small" variant="contained" onClick={() => onOpenSettings('models')}>{t('配置 AI 与模型')}</Button>}
          {onGuide && <Button size="small" onClick={onGuide} sx={{ color: 'text.secondary' }}>{t('新手引导')}</Button>}
          <Button size="small" variant="outlined" startIcon={<KeyboardOutlined sx={{ fontSize: 16 }} />} onClick={() => onOpenSettings('shortcuts')}>{t('查看快捷键')}</Button>
          <Tooltip title={t('刷新状态')}><IconButton size="small" aria-label={t('刷新状态')} onClick={() => void reload()}><RefreshRounded sx={{ fontSize: 19 }} /></IconButton></Tooltip>
        </Box>
      </Box>

      {errors.length > 0 && <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => void reload()}>{t('重试')}</Button>}>
        {t('部分内容未能更新，已加载的内容仍可使用。请重试。')}
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>{errors.map(error => <li key={error.section}>{t(SECTION_KEYS[error.section])}：{error.message}</li>)}</Box>
      </Alert>}
      {actionError && <Alert severity="error" onClose={() => setActionError('')} sx={{ mb: 2 }}>{actionError}</Alert>}

      {/*
        A stats strip, not a stats card.
        The old block reserved a fixed 182 px for a single row of numbers, which
        read as an empty room above the panels while the columns below had to
        scroll. Height is content-driven now, the numbers are one step smaller,
        and the "today vs lifetime" split is carried by a rule plus a size step
        instead of two half-cards.
      */}
      <Box component="section" aria-label={t('使用统计')} data-home-stats
        sx={{ ...panelSx, flex: '0 0 auto', display: 'flex', flexDirection: 'column', py: { xs: 1.5, lg: 1.75 }, ...(statsTab === 'chart' ? { minHeight: 240 } : {}) }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: statsTab === 'chart' ? 1.5 : 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <GraphicEqRounded sx={{ fontSize: 17, color: 'primary.main' }} />
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary' }}>{t('使用统计')}</Typography>
          </Box>
          <Tabs value={statsTab} onChange={(_event, value) => setStatsTab(value)} aria-label={t('数据视图')} sx={{ ml: 'auto', minHeight: 26, bgcolor: 'action.hover', borderRadius: 2, p: .35, '& .MuiTabs-indicator': { display: 'none' }, '& .MuiTab-root': { minHeight: 24, p: '2px 11px', minWidth: 44, fontSize: 11.5, borderRadius: 1.5, '&.Mui-selected': { bgcolor: 'background.paper', boxShadow: '0 1px 4px rgba(0,0,0,.06)' } } }}><Tab id="home-today-tab" value="today" label={t('今日')} aria-controls="home-today-panel" /><Tab id="home-chart-tab" value="chart" label={t('图表')} aria-controls="home-chart-panel" /></Tabs>
        </Box>
        {statsTab === 'today'
          ? <Box id="home-today-panel" role="tabpanel" aria-labelledby="home-today-tab" data-today-stats sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, columnGap: 3, rowGap: 1.5, alignItems: 'center' }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 2 }}>
              <Metric label={t('今日字数')} value={today ? today.chars.toLocaleString() : '—'} hint={t('中文按字、其他语言按词计数，不含标点；统计成功输出。')} emphasis loading={loading && !data.stats} />
              <Metric label={t('今日总时长')} value={today ? clock(today.spoken) : '—'} loading={loading && !data.stats} />
              <Metric label={t('今日语速')} value={today?.pace ? String(today.pace) : '—'} unit={today?.pace ? t('字/分') : ''} hint={t('仅用原始转写与对应录音时长加权计算；旧数据不推测语速。')} loading={loading && !data.stats} />
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 2,
              borderLeftWidth: { xs: 0, md: 1 }, borderLeftStyle: 'solid', borderTopWidth: { xs: 1, md: 0 }, borderTopStyle: 'solid',
              borderColor: 'divider', pl: { md: 3 }, pt: { xs: 1.5, md: 0 } }}>
              <Metric label={t('累计字数')} value={totals ? totals.units.toLocaleString() : '—'} muted loading={loading && !data.stats} />
              <Metric label={t('累计记录')} value={totals ? totals.records.toLocaleString() : '—'} muted loading={loading && !data.stats} />
              <Metric label={t('活跃天数')} value={totals ? totals.days.toLocaleString() : '—'} muted loading={loading && !data.stats} />
            </Box>
          </Box>
          : <Box id="home-chart-panel" role="tabpanel" aria-labelledby="home-chart-tab" sx={{ flex: 1, minHeight: 0 }}>{data.stats ? <UsageInsights view="chart" settings={settings} mode={mode} stats={data.stats} entries={data.history} now={now} onOpenHistory={onOpenHistory} /> : empty('stats', '')}</Box>}
      </Box>

      <Box data-home-panels sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.2fr) minmax(320px, 1fr)' }, gap: 2.5,
        // In the chart tab the two columns keep a real minimum height and the
        // page scrolls, rather than each card being clipped to a sliver.
        flex: statsTab === 'chart' ? '0 0 auto' : 1, minHeight: statsTab === 'chart' ? 420 : 0, overflow: 'hidden' }}>
        <Box component="section" aria-labelledby="home-today-title" data-home-today sx={{ ...panelSx, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}><SectionHeading id="home-today-title" title={t('今天，先做这些')} icon={<CheckCircle sx={{ fontSize: 19 }} />} /></Box>
            {/* Counts sit inline with the title: the grey block they used to
                occupy cost ~56 px of a panel that is already height-bound, and
                that space is worth more as two extra list rows. */}
            <Box sx={{ display: 'flex', gap: .75 }}>
              {[
                { label: '日程', value: data.events ? agenda.length : '—', action: () => onOpenPage('calendar') },
                { label: '待处理', value: data.todos ? todos.length : '—', action: () => onOpenPage('reminders') },
                { label: '已逾期', value: data.todos ? overdue : '—', action: () => onOpenPage('reminders'), danger: overdue > 0 }
              ].map(item => <ButtonBase key={item.label} onClick={item.action}
                aria-label={t('{{label}}：{{value}}', { label: t(item.label), value: String(item.value) })}
                sx={{ gap: .6, px: 1, py: .4, borderRadius: 1.25, border: 1, borderColor: 'divider', color: item.danger ? 'error.main' : 'text.primary', '&:hover': { bgcolor: 'action.hover' } }}>
                <Typography sx={{ fontSize: 15, lineHeight: 1.2, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{item.value}</Typography>
                <Typography sx={{ fontSize: 10.5, lineHeight: 1.2, color: item.danger ? 'inherit' : 'text.secondary' }}>{t(item.label)}</Typography>
              </ButtonBase>)}
            </Box>
          </Box>

          <Box sx={{ mt: 1.5 }}><SectionHeading title={t('今天的日程')} icon={<CalendarMonth sx={{ fontSize: 16 }} />} action={t('查看日程')} onAction={() => onOpenPage('calendar')} /></Box>
          {agenda.length === 0 ? empty('events', t('今天没有安排，为重要的事留点时间。')) : <Box sx={{ mt: .5 }}>{agenda.slice(0, 3).map(event => <Box key={event.id} sx={{ display: 'flex', gap: 1.5, py: .6, minWidth: 0 }}>
            <Box sx={{ width: 3, borderRadius: 2, flexShrink: 0, bgcolor: event.end <= now ? 'divider' : 'primary.main' }} />
            <Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: 12.5, fontWeight: 500, color: event.end <= now ? 'text.secondary' : 'text.primary', overflowWrap: 'anywhere' }}>{event.title}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>{formatEventTime(event, language)}{event.location ? ` · ${event.location}` : ''}{event.end <= now ? ` · ${t('已结束')}` : ''}</Typography></Box>
          </Box>)}</Box>}
          <Box sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
            <SectionHeading title={t('待办与提醒')} icon={<CheckCircle sx={{ fontSize: 16 }} />} action={t('查看全部')} onAction={() => onOpenPage('reminders')} />
            {todos.length === 0 ? empty('todos', t('没有待处理事项，随时可以记下新的计划。')) : <Box sx={{ mt: .5 }}>{todos.slice(0, 4).map(todo => <Box key={todo.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: .75, py: .45 }}>
              <Checkbox size="small" checked={false} disabled={completing !== null} onChange={() => void complete(todo.id)} inputProps={{ 'aria-label': t('完成待办：{{title}}', { title: todo.title }) }} sx={{ p: 0.25, ml: -0.5, '& svg': { fontSize: 18 } }} />
              <Box sx={{ minWidth: 0, pt: 0.15 }}><Typography sx={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{todo.title}</Typography><Typography sx={{ fontSize: 11, color: isOverdue(todo, now) ? 'error.main' : 'text.secondary', mt: 0.25 }}>
                {todoTime(todo, language) ?? t('未设置时间 · 待办')}{isOverdue(todo, now) ? ` · ${t('已逾期')}` : ''}{todo.priority === 'high' ? ` · ${t('高优先级')}` : ''}
              </Typography></Box>
            </Box>)}</Box>}
          </Box>
        </Box>

        {/* The right column is the activity list, and nothing else: the briefing
            has its own page now, so the height it used to reserve belongs to the
            rows the user actually scans here. */}
        <Box component="section" aria-labelledby="home-activity-title" data-home-activity sx={{ ...panelSx, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}><SectionHeading id="home-activity-title" title={t('最近活动')} icon={<HistoryRounded sx={{ fontSize: 19 }} />} /></Box>
            <Button size="small" onClick={() => onOpenHistory()} sx={{ minWidth: 0, p: .25, fontSize: 10.5, color: 'text.secondary', flexShrink: 0, gap: .5 }}>{t('查看全部')}<ArrowForward sx={{ fontSize: 12 }} /></Button>
          </Box>
          {activity.length === 0 ? empty(data.history ? 'notes' : 'history', t('你的随记、问答和输入记录会出现在这里。')) : <Box sx={{ mt: .5 }}>{activity.slice(0, 8).map(item => <ButtonBase key={`${item.kind}-${item.id}`} onClick={() => item.kind === 'note' ? onOpenNote(item.id) : onOpenHistory(item.text)} sx={{ width: '100%', display: 'block', textAlign: 'left', py: .85, px: 0.5, borderRadius: 1, '& + &': { borderTop: 1, borderColor: 'divider' }, '&:hover': { bgcolor: 'action.hover' } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}><Typography sx={{ fontSize: 10.5, color: item.failed ? 'error.main' : 'text.secondary' }}>{item.kind === 'note' ? t('随记') : modeLabel(item.kind)}{item.failed ? ` · ${t('失败')}` : ''}</Typography><Typography sx={{ ml: 'auto', fontSize: 10.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(item.at)}</Typography></Box>
            <Typography sx={{ fontSize: 12, ...clipSx }}>{item.text}</Typography>
          </ButtonBase>)}</Box>}
        </Box>
      </Box>

      <Box component="footer" sx={{ flexShrink: 0, minHeight: 32, borderTop: 1, borderColor: 'divider', pt: 1 }}>
        {data.stats && <UsageInsights view="apps" settings={settings} mode={mode} stats={data.stats} entries={data.history} now={now} onOpenHistory={onOpenHistory} />}
      </Box>
    </Box>
  )
}

function SectionHeading({ id, title, icon, action, onAction }: { id?: string; title: string; icon?: ReactNode; action?: string; onAction?: () => void }): JSX.Element {
  return <Box sx={{ display: 'flex', gap: 0.8, alignItems: 'center', minWidth: 0 }}>
    {icon && <Box sx={{ display: 'flex', color: 'primary.main', mr: .25 }}>{icon}</Box>}
    <Typography component={id ? 'h2' : 'h3'} id={id} sx={{ fontSize: id ? 14 : 12, fontWeight: 650, flex: 1, letterSpacing: .1 }}>{title}</Typography>
    {action && <Button size="small" onClick={onAction} sx={{ minWidth: 0, p: .25, fontSize: 10.5, color: 'text.secondary', flexShrink: 0, gap: .5 }}>{action}<ArrowForward sx={{ fontSize: 12 }} /></Button>}
  </Box>
}

/**
 * One number in the stats strip.
 *
 * `muted` is the lifetime group: it is real information, but it should not
 * compete with today's figures, so it sits one size smaller. `emphasis` marks
 * the single number the page is actually about.
 */
function Metric({ label, value, unit, hint, emphasis = false, muted = false, loading = false }: {
  label: string
  value: string
  unit?: string
  hint?: string
  emphasis?: boolean
  muted?: boolean
  loading?: boolean
}): JSX.Element {
  const body = (
    <Box sx={{ minWidth: 0 }}>
      <Typography color="text.secondary" sx={{ fontSize: 11, lineHeight: 1.5 }}>{label}</Typography>
      {loading
        ? <Skeleton width="60%" height={muted ? 24 : 28} sx={{ mt: .25 }} />
        : <Typography sx={{ mt: .25, fontSize: muted ? { xs: 19, lg: 21 } : { xs: 21, lg: 24 }, fontWeight: 550, lineHeight: 1.25, letterSpacing: -.7, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', color: emphasis ? 'primary.main' : 'text.primary' }}>
            {value}{unit ? <Box component="span" sx={{ ml: .4, fontSize: 10.5, letterSpacing: 0, color: 'text.secondary', whiteSpace: 'nowrap' }}>{unit}</Box> : null}
          </Typography>}
    </Box>
  )
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body
}
