import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Button, ButtonBase, Checkbox, IconButton, Skeleton, Tab, Tabs, Tooltip, Typography } from '@mui/material'
import ArrowForward from '@mui/icons-material/ArrowForward'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import KeyboardOutlined from '@mui/icons-material/KeyboardOutlined'
import WbSunnyOutlined from '@mui/icons-material/WbSunnyOutlined'
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
  onOpenPage: (page: 'notes' | 'reminders' | 'calendar' | 'briefing') => void
  onOpenNote: (id: string) => void
  onOpenSettings: (section: 'models' | 'shortcuts' | 'automation') => void
}

const SECTION_KEYS: Record<keyof HomeData, string> = {
  events: '日程', todos: '提醒与待办', briefing: '简报', notes: '随记',
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
  const panelSx = { border: '1px solid', borderColor: 'divider', borderRadius: '16px', bgcolor: 'background.paper', p: { xs: 2, lg: 2.75 }, minWidth: 0 }

  const complete = async (id: string): Promise<void> => {
    setCompleting(id); setActionError('')
    try { await window.api.reminders.action(id, 'complete'); await reload() }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
    finally { setCompleting(null) }
  }

  const empty = (section: keyof HomeData, text: string): ReactNode => loading
    ? <Box aria-label={t('读取中…')} role="status" sx={{ py: 1.5 }}><Skeleton width="72%" /><Skeleton width="48%" /></Box>
    : <Typography sx={{ color: 'text.secondary', fontSize: 12.5, lineHeight: 1.9, py: 2 }}>
        {data[section] === undefined ? t('暂时无法读取，请刷新重试') : text}
      </Typography>

  return (
    <Box component="main" data-home-workspace sx={{ px: { xs: 2.5, md: 4, lg: 5 }, pt: { xs: 1.5, md: 2.5 }, pb: 2, maxWidth: 1500, mx: 'auto', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2.5, overflow: 'hidden',
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

      <Box component="section" aria-label={t('使用统计')} sx={{ ...panelSx, flex: '0 0 182px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}><Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, color: 'text.secondary' }}><GraphicEqRounded sx={{ fontSize: 17, color: 'primary.main' }} /><Typography sx={{ fontSize: 12, fontWeight: 600 }}>{t('使用统计')}</Typography></Box>
        <Tabs value={statsTab} onChange={(_event, value) => setStatsTab(value)} aria-label={t('数据视图')} sx={{ minHeight: 28, bgcolor: 'action.hover', borderRadius: 2, p: .4, '& .MuiTabs-indicator': { display: 'none' }, '& .MuiTab-root': { minHeight: 25, p: '3px 12px', minWidth: 48, fontSize: 11.5, borderRadius: 1.5, '&.Mui-selected': { bgcolor: 'background.paper', boxShadow: '0 1px 4px rgba(0,0,0,.06)' } } }}><Tab id="home-today-tab" value="today" label={t('今日')} aria-controls="home-today-panel" /><Tab id="home-chart-tab" value="chart" label={t('图表')} aria-controls="home-chart-panel" /></Tabs></Box>
      {statsTab === 'today' ? <Box id="home-today-panel" role="tabpanel" aria-labelledby="home-today-tab" data-today-stats sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2.5, flex: 1, alignItems: 'center', overflowY: 'auto' }}>
        {[
          [
            { label: '今日字数', value: today ? today.chars.toLocaleString() : '—', hint: '中文按字、其他语言按词计数，不含标点；统计成功输出。' },
            { label: '今日总时长', value: today ? clock(today.spoken) : '—' },
            { label: '今日语速', value: today?.pace ? String(today.pace) : '—', unit: today?.pace ? t('字/分') : '', hint: '仅用原始转写与对应录音时长加权计算；旧数据不推测语速。' }
          ],
          [
            { label: '累计字数', value: totals ? totals.units.toLocaleString() : '—' },
            { label: '累计记录', value: totals ? totals.records.toLocaleString() : '—' },
            { label: '活跃天数', value: totals ? totals.days.toLocaleString() : '—' }
          ]
        ].map((group, index) => <Box key={index} sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 2, ...(index ? { borderLeftWidth: { xs: 0, md: 1 }, borderLeftStyle: 'solid', borderTopWidth: { xs: 1, md: 0 }, borderTopStyle: 'solid', borderColor: 'divider', pl: { md: 3 }, pt: { xs: 2, md: 0 } } : {}) }}>
          {group.map(item => <Tooltip key={item.label} title={'hint' in item ? t(item.hint!) : ''}><Box sx={{ minWidth: 0 }}>
            <Typography color="text.secondary" sx={{ fontSize: 11.5 }}>{t(item.label)}</Typography>
            {loading && !data.stats ? <Skeleton width="65%" height={42} /> : <Typography sx={{ fontSize: 'clamp(22px, 2.8vw, 34px)', fontWeight: 500, letterSpacing: -1, mt: .75, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', lineHeight: 1.3, color: index === 0 ? 'primary.main' : 'text.primary' }}>{item.value}{'unit' in item && item.unit && <Box component="span" sx={{ ml: .5, fontSize: 10.5, letterSpacing: 0, color: 'text.secondary', whiteSpace: 'nowrap' }}>{item.unit}</Box>}</Typography>}
          </Box></Tooltip>)}
        </Box>)}
      </Box> : <Box id="home-chart-panel" role="tabpanel" aria-labelledby="home-chart-tab" sx={{ flex: 1, minHeight: 0 }}>{data.stats ? <UsageInsights view="chart" settings={settings} mode={mode} stats={data.stats} entries={data.history} now={now} onOpenHistory={onOpenHistory} /> : empty('stats', '')}</Box>}
      </Box>

      <Box data-home-panels sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.4fr) minmax(240px, 1fr)' }, gap: 2.5, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Box component="section" aria-labelledby="home-today-title" sx={{ ...panelSx, overflowY: 'auto' }}>
          <SectionHeading id="home-today-title" title={t('今天，先做这些')} icon={<CheckCircle sx={{ fontSize: 19 }} />} />
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mt: 2, mb: 2.5, py: 1.5, px: 1.5, bgcolor: 'action.hover', borderRadius: 2.5 }}>
            {[
              { label: '日程', value: data.events ? agenda.length : '—', action: () => onOpenPage('calendar') },
              { label: '待处理', value: data.todos ? todos.length : '—', action: () => onOpenPage('reminders') },
              { label: '已逾期', value: data.todos ? overdue : '—', action: () => onOpenPage('reminders'), danger: overdue > 0 }
            ].map(item => <ButtonBase key={item.label} onClick={item.action} sx={{ gap: 1, py: .25, borderRadius: 1, color: item.danger ? 'error.main' : 'text.primary' }}>
              <Typography sx={{ fontSize: 23, lineHeight: 1.2, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{item.value}</Typography>
              <Typography sx={{ fontSize: 11.5, color: item.danger ? 'inherit' : 'text.secondary' }}>{t(item.label)}</Typography>
            </ButtonBase>)}
          </Box>
          <SectionHeading title={t('今天的日程')} icon={<CalendarMonth sx={{ fontSize: 16 }} />} action={t('查看日程')} onAction={() => onOpenPage('calendar')} />
          {agenda.length === 0 ? empty('events', t('今天没有安排，为重要的事留点时间。')) : <Box sx={{ mt: 1 }}>{agenda.slice(0, 3).map(event => <Box key={event.id} sx={{ display: 'flex', gap: 1.5, py: 1, minWidth: 0 }}>
            <Box sx={{ width: 3, borderRadius: 2, flexShrink: 0, bgcolor: event.end <= now ? 'divider' : 'primary.main' }} />
            <Box sx={{ minWidth: 0 }}><Typography sx={{ fontSize: 12.5, fontWeight: 500, color: event.end <= now ? 'text.secondary' : 'text.primary', overflowWrap: 'anywhere' }}>{event.title}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>{formatEventTime(event, language)}{event.location ? ` · ${event.location}` : ''}{event.end <= now ? ` · ${t('已结束')}` : ''}</Typography></Box>
          </Box>)}</Box>}
          <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <SectionHeading title={t('待办与提醒')} icon={<CheckCircle sx={{ fontSize: 16 }} />} action={t('查看全部')} onAction={() => onOpenPage('reminders')} />
            {todos.length === 0 ? empty('todos', t('没有待处理事项，随时可以记下新的计划。')) : <Box sx={{ mt: 0.75 }}>{todos.slice(0, 3).map(todo => <Box key={todo.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, py: 0.7 }}>
              <Checkbox size="small" checked={false} disabled={completing !== null} onChange={() => void complete(todo.id)} inputProps={{ 'aria-label': t('完成待办：{{title}}', { title: todo.title }) }} sx={{ p: 0.5, ml: -0.5 }} />
              <Box sx={{ minWidth: 0, pt: 0.35 }}><Typography sx={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{todo.title}</Typography><Typography sx={{ fontSize: 11, color: isOverdue(todo, now) ? 'error.main' : 'text.secondary', mt: 0.4 }}>
                {todoTime(todo, language) ?? t('未设置时间 · 待办')}{isOverdue(todo, now) ? ` · ${t('已逾期')}` : ''}{todo.priority === 'high' ? ` · ${t('高优先级')}` : ''}
              </Typography></Box>
            </Box>)}</Box>}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0, minHeight: 0 }}>
          <Box component="section" aria-labelledby="home-briefing-title" sx={{ ...panelSx, bgcolor: 'action.hover', flex: '0 1 auto', maxHeight: { md: '46%' }, minHeight: 0, overflowY: 'auto' }}>
            <SectionHeading id="home-briefing-title" title={t('今日简报')} icon={<WbSunnyOutlined sx={{ fontSize: 19 }} />} action={t('打开简报')} onAction={() => onOpenPage('briefing')} />
            {!data.briefing || data.briefing.empty ? empty('briefing', t('今天没有需要汇报的安排。')) : <Typography sx={{ mt: 1.5, fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-line', color: 'text.secondary', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{data.briefing.body}</Typography>}
            <Button size="small" onClick={() => onOpenPage('briefing')} sx={{ mt: .75, px: 0 }}>{t('生成或朗读简报')}<ArrowForward sx={{ fontSize: 14, ml: 0.75 }} /></Button>
          </Box>
          <Box component="section" aria-labelledby="home-activity-title" sx={{ ...panelSx, flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <SectionHeading id="home-activity-title" title={t('最近活动')} icon={<HistoryRounded sx={{ fontSize: 19 }} />} />
            {activity.length === 0 ? empty(data.history ? 'notes' : 'history', t('你的随记、问答和输入记录会出现在这里。')) : <Box sx={{ mt: 1 }}>{activity.map(item => <ButtonBase key={`${item.kind}-${item.id}`} onClick={() => item.kind === 'note' ? onOpenNote(item.id) : onOpenHistory(item.text)} sx={{ width: '100%', display: 'block', textAlign: 'left', py: 1.25, px: 0.5, borderRadius: 1, '& + &': { borderTop: 1, borderColor: 'divider' }, '&:hover': { bgcolor: 'action.hover' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}><Typography sx={{ fontSize: 10.5, color: item.failed ? 'error.main' : 'text.secondary' }}>{item.kind === 'note' ? t('随记') : modeLabel(item.kind)}{item.failed ? ` · ${t('失败')}` : ''}</Typography><Typography sx={{ ml: 'auto', fontSize: 10.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(item.at)}</Typography></Box>
              <Typography sx={{ fontSize: 12, ...clipSx }}>{item.text}</Typography>
            </ButtonBase>)}</Box>}
          </Box>
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
