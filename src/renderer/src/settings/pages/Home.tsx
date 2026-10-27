import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Button, ButtonBase, Checkbox, Skeleton, Typography } from '@mui/material'
import ArrowForward from '@mui/icons-material/ArrowForward'
import CalendarMonth from '@mui/icons-material/CalendarMonthOutlined'
import CheckCircle from '@mui/icons-material/CheckCircleOutline'
import ExpandMore from '@mui/icons-material/ExpandMore'
import StickyNote from '@mui/icons-material/StickyNote2Outlined'
import Screenshot from '@mui/icons-material/ScreenshotMonitorOutlined'
import AccountTree from '@mui/icons-material/AccountTreeOutlined'
import History from '@mui/icons-material/History'
import type { Settings } from '@shared/types'
import { formatEventTime } from '@shared/calendar'
import { isOverdue } from '@shared/reminders'
import { UsageInsights } from './UsageInsights'
import { loadHomeData, openTodos, recentActivity, todayAgenda, todoTime, type HomeData } from './homeView'
import { modeLabel } from './historyView'
import { useTranslation } from 'react-i18next'

interface HomeProps {
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

export function HomePage({ settings, mode, onOpenHistory, onOpenPage, onOpenNote, onOpenSettings }: HomeProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  const [data, setData] = useState<Partial<HomeData>>({})
  const [errors, setErrors] = useState<Awaited<ReturnType<typeof loadHomeData>>['errors']>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(Date.now)
  const [showUsage, setShowUsage] = useState(false)
  const [actionError, setActionError] = useState('')
  const [completing, setCompleting] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
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
  const workflowCount = data.workflows?.filter(row => !row.archivedAt).length
  const hasTextModel = settings.profiles.some(profile => profile.enabled && profile.kind === 'llm' && profile.model.trim() && profile.baseUrl.trim())
  const panelSx = { border: '1px solid', borderColor: 'divider', borderRadius: '14px', bgcolor: 'background.paper', p: 2.25, minWidth: 0 }

  const complete = async (id: string): Promise<void> => {
    setCompleting(id); setActionError('')
    try { await window.api.reminders.action(id, 'complete'); await reload() }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
    finally { setCompleting(null) }
  }

  const capture = async (): Promise<void> => {
    setCapturing(true); setActionError('')
    try { if (!await window.api.screenshot.open()) setActionError(t('截图未能打开，请稍后重试')) }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
    finally { setCapturing(false) }
  }

  const empty = (section: keyof HomeData, text: string): ReactNode => loading
    ? <Skeleton height={44} />
    : <Typography sx={{ color: 'text.secondary', fontSize: 12.5, lineHeight: 1.8, py: 1.5 }}>
        {data[section] === undefined ? t('暂时无法读取，请刷新重试') : text}
      </Typography>

  return (
    <Box component="main" data-home-workspace sx={{ px: { xs: 2, md: 3.5 }, pt: 1.5, pb: 3.5, maxWidth: 1440, mx: 'auto',
      '& .MuiButton-root': focusSx, '& .MuiButtonBase-root': { transition: 'background-color .16s ease', ...focusSx } }}>
      <Box component="header" sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h1" sx={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.7 }}>{t('语，与你常在')}</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.4 }}>
            {new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)}
            {' · '}{t('记录想法，安排事务，交给助手处理')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!hasTextModel && <Button size="small" variant="contained" onClick={() => onOpenSettings('models')}>{t('配置 AI 与模型')}</Button>}
          <Button size="small" onClick={() => onOpenSettings('shortcuts')} sx={{ color: 'text.secondary' }}>{t('查看快捷键')}</Button>
          <Button size="small" onClick={() => void reload()} sx={{ color: 'text.secondary' }}>{t('刷新状态')}</Button>
        </Box>
      </Box>

      {errors.length > 0 && <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => void reload()}>{t('重试')}</Button>}>
        {t('部分内容未能更新，已加载的内容仍可使用。请重试。')}
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>{errors.map(error => <li key={error.section}>{t(SECTION_KEYS[error.section])}：{error.message}</li>)}</Box>
      </Alert>}
      {actionError && <Alert severity="error" onClose={() => setActionError('')} sx={{ mb: 2 }}>{actionError}</Alert>}

        <Box component="section" aria-labelledby="home-tools-title" sx={{ ...panelSx, py: 1.75, mb: 2 }}>
          <Typography component="h2" id="home-tools-title" sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary', mb: 1 }}>{t('常用工具')}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
          {[
            { title: '随记', hint: '文字与录音，随手记录', icon: <StickyNote />, action: () => onOpenPage('notes') },
            { title: '截图工具', hint: '截图、识字与翻译', icon: <Screenshot />, action: () => void capture(), disabled: capturing },
            { title: '自动化', hint: workflowCount === undefined ? t('管理保存的工作流') : t('{{n}} 个可用工作流', { n: workflowCount }), icon: <AccountTree />, action: () => onOpenSettings('automation') },
            { title: '历史记录', hint: '找回输入、问答与翻译', icon: <History />, action: () => onOpenHistory() }
          ].map(tool => <ButtonBase key={tool.title} title={t(tool.hint)} disabled={tool.disabled} onClick={tool.action} sx={{ width: '100%', minWidth: 0, textAlign: 'left', py: 1, px: 0.5, borderRadius: 1.5, gap: 1.25, '&:hover': { bgcolor: 'action.hover' } }}>
            <Box sx={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 1.5, bgcolor: 'action.hover', color: 'text.secondary', '& svg': { fontSize: 18 } }}>{tool.icon}</Box>
            <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{t(tool.title)}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary', ...clipSx }}>{t(tool.hint)}</Typography></Box>
          </ButtonBase>)}
          </Box>
        </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.65fr) minmax(235px, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Box component="section" aria-labelledby="home-today-title" sx={panelSx}>
          <SectionHeading id="home-today-title" title={t('今天，先做这些')} />
          <Box sx={{ display: 'flex', gap: 2.5, my: 2, py: 1.5, borderTop: 1, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
            {[
              { label: '日程', value: data.events ? agenda.length : '—', action: () => onOpenPage('calendar') },
              { label: '待处理', value: data.todos ? todos.length : '—', action: () => onOpenPage('reminders') },
              { label: '已逾期', value: data.todos ? overdue : '—', action: () => onOpenPage('reminders'), danger: overdue > 0 }
            ].map(item => <ButtonBase key={item.label} onClick={item.action} sx={{ gap: 1, borderRadius: 1, color: item.danger ? 'error.main' : 'text.primary' }}>
              <Typography sx={{ fontSize: 25, lineHeight: 1.2, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{item.value}</Typography>
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

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <Box component="section" aria-labelledby="home-briefing-title" sx={panelSx}>
            <SectionHeading id="home-briefing-title" title={t('今日简报')} action={t('打开简报')} onAction={() => onOpenPage('briefing')} />
            {!data.briefing || data.briefing.empty ? empty('briefing', t('今天没有需要汇报的安排。')) : <Typography sx={{ mt: 1.5, fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-line', color: 'text.secondary', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{data.briefing.body}</Typography>}
            <Button size="small" onClick={() => onOpenPage('briefing')} sx={{ mt: 1.5, px: 0 }}>{t('生成或朗读简报')}<ArrowForward sx={{ fontSize: 14, ml: 0.75 }} /></Button>
          </Box>
          <Box component="section" aria-labelledby="home-activity-title" sx={panelSx}>
            <SectionHeading id="home-activity-title" title={t('最近活动')} />
            {activity.length === 0 ? empty(data.history ? 'notes' : 'history', t('你的随记、问答和输入记录会出现在这里。')) : <Box sx={{ mt: 1 }}>{activity.map(item => <ButtonBase key={`${item.kind}-${item.id}`} onClick={() => item.kind === 'note' ? onOpenNote(item.id) : onOpenHistory(item.text)} sx={{ width: '100%', display: 'block', textAlign: 'left', py: 1, px: 0.5, borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}><Typography sx={{ fontSize: 10.5, color: item.failed ? 'error.main' : 'text.secondary' }}>{item.kind === 'note' ? t('随记') : modeLabel(item.kind)}{item.failed ? ` · ${t('失败')}` : ''}</Typography><Typography sx={{ ml: 'auto', fontSize: 10.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(item.at)}</Typography></Box>
              <Typography sx={{ fontSize: 12, ...clipSx }}>{item.text}</Typography>
            </ButtonBase>)}</Box>}
          </Box>
        </Box>
      </Box>

      <Box sx={{ mt: 2.5, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
        <ButtonBase aria-expanded={showUsage} aria-controls="home-usage" onClick={() => setShowUsage(value => !value)} sx={{ width: '100%', justifyContent: 'space-between', gap: 2, py: 0.75, borderRadius: 1, textAlign: 'left' }}>
          <Box><Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{t('使用统计')}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>{t('输入趋势、累计用量与应用分布')}</Typography></Box>
          <ExpandMore sx={{ fontSize: 20, transform: showUsage ? 'rotate(180deg)' : 'none', transition: 'transform .16s ease' }} />
        </ButtonBase>
        <Box id="home-usage" hidden={!showUsage} sx={{ pt: showUsage ? 2 : 0 }}>
          {showUsage && (data.stats ? <UsageInsights settings={settings} mode={mode} stats={data.stats} entries={data.history} now={now} onOpenHistory={onOpenHistory} /> : empty('stats', ''))}
        </Box>
      </Box>
    </Box>
  )
}

function SectionHeading({ id, title, icon, action, onAction }: { id?: string; title: string; icon?: ReactNode; action?: string; onAction?: () => void }): JSX.Element {
  return <Box sx={{ display: 'flex', gap: 0.8, alignItems: 'center', minWidth: 0 }}>
    {icon && <Box sx={{ display: 'flex', color: 'text.secondary' }}>{icon}</Box>}
    <Typography component={id ? 'h2' : 'h3'} id={id} sx={{ fontSize: 13, fontWeight: 650, flex: 1 }}>{title}</Typography>
    {action && <Button size="small" onClick={onAction} sx={{ minWidth: 0, p: 0, fontSize: 11, color: 'text.secondary', flexShrink: 0 }}>{action}</Button>}
  </Box>
}
