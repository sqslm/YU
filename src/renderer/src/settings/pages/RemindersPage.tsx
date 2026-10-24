import { useEffect, useState } from 'react'
import { Alert, Box, Button, ButtonGroup, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Menu, MenuItem, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material'
import { Add, ArrowDropDown, CheckCircleOutline, MoreHoriz, RadioButtonUnchecked } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import type { Reminder, ReminderAction, ReminderDraft, ReminderInput, ReminderView } from '@shared/reminders'
import { localDateTime } from '@shared/reminders'
import { PagedList } from '../Pagination'
import { ReminderDateTime } from './ReminderDateTime'
import { SnoozeButton } from '../../reminder/SnoozeButton'
import { reminderDateBounds, reminderView, type ReminderKind, type ReminderPeriod } from './reminderView'

interface Form { kind: 'reminder' | 'todo'; title: string; description: string; timeExpression: string; date: string; level: 'normal' | 'strong'; repeat: 'none' | 'daily' | 'weekly'; weekday: number }
const empty = (kind: Form['kind'] = 'reminder'): Form => ({ kind, title: '', description: '', timeExpression: '', date: '', level: 'normal', repeat: 'none', weekday: 1 })
const fromReminder = (row: Reminder): Form => ({ kind: row.dueAt === null ? 'todo' : 'reminder', title: row.title, description: row.description ?? '', timeExpression: row.timeExpression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.recurrence?.frequency ?? 'none', weekday: row.recurrence?.weekdays?.[0] ?? 1 })
const fromDraft = (row: ReminderDraft): Form => ({ kind: row.dueAt === null ? 'todo' : 'reminder', title: row.title, description: row.description ?? '', timeExpression: row.time_expression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.dueAt === null ? 'none' : row.rule?.frequency ?? row.recurrence ?? 'none', weekday: row.rule?.weekdays?.[0] ?? -1 })

function input(form: Form, source: ReminderInput['source'], noteId?: string, original?: Reminder): ReminderInput {
  const sameDate = original && form.date === localDateTime(original.dueAt)
  const dueAt = form.kind === 'todo' ? null : sameDate ? original.dueAt : form.date ? new Date(form.date).getTime() : null
  if (form.kind === 'reminder' && dueAt === null) throw new Error('请选择提醒时间')
  if (!form.title.trim()) throw new Error('请输入提醒事项')
  if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt <= Date.now() && !(sameDate && original.status !== 'pending'))) throw new Error('请选择将来的提醒时间')
  if (form.repeat !== 'none' && dueAt === null) throw new Error('重复提醒需要具体时刻')
  if (form.repeat === 'weekly' && form.weekday < 0) throw new Error('请选择每周的星期')
  const date = new Date(dueAt ?? Date.now())
  return { title: form.title, description: form.description, timeExpression: form.timeExpression || undefined, dueAt, level: form.kind === 'todo' ? 'normal' : form.level, source, noteId,
    recurrence: sameDate && form.repeat === (original.recurrence?.frequency ?? 'none') && form.weekday === (original.recurrence?.weekdays?.[0] ?? 1) ? original.recurrence : form.repeat === 'none' ? null : { frequency: form.repeat, hour: date.getHours(), minute: date.getMinutes(),
      ...(form.repeat === 'weekly' ? { weekdays: [form.weekday] } : {}) } }
}

function Fields({ form, change }: { form: Form; change: (form: Form) => void }): JSX.Element {
  const { t } = useTranslation()
  return <Stack spacing={1.5}>
    <TextField select label={t('事项类型')} size="small" value={form.kind} onChange={e => change({ ...form, kind: e.target.value as Form['kind'], ...(e.target.value === 'todo' ? { date: '', repeat: 'none' } : {}) })}>
      <MenuItem value="reminder">{t('提醒')}</MenuItem><MenuItem value="todo">{t('待办')}</MenuItem>
    </TextField>
    <TextField label={t(form.kind === 'todo' ? '待办事项' : '提醒事项')} size="small" value={form.title} onChange={e => change({ ...form, title: e.target.value })} inputProps={{ maxLength: 300 }} />
    <TextField label={t('提醒备注（可选）')} size="small" multiline minRows={2} maxRows={4} value={form.description}
      onChange={e => change({ ...form, description: e.target.value })} inputProps={{ maxLength: 4000 }} />
    {form.kind === 'reminder' && <><ReminderDateTime required value={form.date} onChange={date => change({ ...form, date,
      weekday: form.repeat === 'weekly' && date ? new Date(date).getDay() : form.weekday })} />
    <Stack direction="row" spacing={1}>
      <TextField select label={t('提醒等级')} size="small" value={form.level} onChange={e => change({ ...form, level: e.target.value as Form['level'] })}>
        <MenuItem value="normal">{t('普通提醒')}</MenuItem><MenuItem value="strong">{t('强提醒')}</MenuItem>
      </TextField>
      <TextField select label={t('重复规则')} size="small" value={form.repeat} onChange={e => change({ ...form, repeat: e.target.value as Form['repeat'],
        weekday: e.target.value === 'weekly' && form.date ? new Date(form.date).getDay() : form.weekday })}>
        <MenuItem value="none">{t('不重复')}</MenuItem><MenuItem value="daily">{t('每天')}</MenuItem><MenuItem value="weekly">{t('每周')}</MenuItem>
      </TextField>
      {form.repeat === 'weekly' && <TextField select label={t('星期')} size="small" value={form.weekday} onChange={e => {
        const weekday = Number(e.target.value), date = form.date ? new Date(form.date) : null
        if (date) date.setDate(date.getDate() + (weekday - date.getDay() + 7) % 7)
        change({ ...form, weekday, date: date ? localDateTime(date.getTime()) : '' })
      }}>
        <MenuItem value={-1} disabled>{t('请选择每周的星期')}</MenuItem>
        {['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'].map((day, i) => <MenuItem key={day} value={i}>{t(day)}</MenuItem>)}
      </TextField>}
    </Stack></>}
  </Stack>
}

export function RemindersPage({ view, onOpenNote, onViewConsumed }: { view: ReminderView | null; onOpenNote: (id: string) => void; onViewConsumed: () => void }): JSX.Element {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<Reminder[]>([]), [error, setError] = useState(''), [query, setQuery] = useState('')
  const [filter, setFilter] = useState('active'), [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<ReminderKind>('all'), [period, setPeriod] = useState<ReminderPeriod>('all')
  const [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [editor, setEditor] = useState<{ id?: string; form: Form; source: ReminderInput['source']; noteId?: string; duplicate?: boolean } | null>(null)
  const [review, setReview] = useState<{ drafts: ReminderDraft[]; forms: Form[]; selected: boolean[]; noteId?: string } | null>(null)
  const [deleting, setDeleting] = useState<Reminder | null>(null)
  const [createMenu, setCreateMenu] = useState<HTMLElement | null>(null)
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; row: Reminder } | null>(null)
  const [highlightId, setHighlightId] = useState<string | undefined>()
  const reload = (): void => { void window.api.reminders.list().then(setRows).catch(e => setError(String(e.message ?? e))) }
  useEffect(() => { reload(); return window.api.reminders.onChanged(reload) }, [])
  useEffect(() => {
    if (!view) return
    setHighlightId(view.id)
    if (view?.id) { setQuery(''); setFilter('all'); setKind('all'); setPeriod('all') }
    if (view?.drafts?.length) {
      setFilter('active'); setQuery('')
      setReview({ drafts: view.drafts, forms: view.drafts.map(fromDraft),
        selected: view.drafts.map(item => item.intent !== 'possible'), noteId: view.noteId })
    }
    onViewConsumed()
  }, [view])
  const perform = async (work: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setError('')
    try { await work(); reload(); return true } catch (e) { setError(t(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e))); return false }
    finally { setBusy(false) }
  }
  const act = (id: string, action: ReminderAction, minutes?: number): void => {
    void perform(() => window.api.reminders.action(id, action, minutes)).then(ok => {
      if (ok && action === 'restore') { setKind('all'); setPeriod('all'); setFilter('active'); setQuery(''); setHighlightId(id) }
    })
  }
  const format = (stamp: number | null): string => stamp === null ? t('未设置时间 · 待办') : new Date(stamp).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')
  const sourceLabel = { manual: '手动', voice: '语音快捷键', note: '随记' }
  const statusLabel = { pending: '待处理', due: '已到期', completed: '已完成', cancelled: '已取消' }
  const bounds = reminderDateBounds(period, from, to)
  const filtered = reminderView(rows, { status: filter, kind, query, bounds })
  const create = (type: Form['kind']): void => { setCreateMenu(null); setError(''); setEditor({ form: empty(type), source: 'manual' }) }
  const edit = (row: Reminder): void => { setRowMenu(null); setError(''); setEditor({ id: row.id, form: fromReminder(row), source: row.source, noteId: row.noteId }) }
  const duplicate = (row: Reminder): void => {
    const form = fromReminder(row)
    if (form.date && new Date(form.date).getTime() <= Date.now()) form.date = ''
    setRowMenu(null); setError(''); setEditor({ form, source: 'manual', noteId: row.noteId, duplicate: true })
  }
  return <Box sx={{ p: 3 }} data-reminders-page>
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
      <Typography variant="h6" sx={{ fontWeight: 650 }}>{t('提醒与待办')}</Typography>
      <ButtonGroup variant="contained" size="small" disableElevation>
        <Button startIcon={<Add />} data-reminder-new onClick={() => create('todo')}>{t('新建')}</Button>
        <Button data-reminder-create-menu aria-label={t('选择新建类型')} aria-haspopup="menu" aria-expanded={Boolean(createMenu)} onClick={e => setCreateMenu(e.currentTarget)} sx={{ px: .5, minWidth: '30px !important' }}><ArrowDropDown fontSize="small" /></Button>
      </ButtonGroup>
    </Stack>
    <Tooltip title={t('本地提醒，无需登录。软件完全退出或电脑关机时不触发，重新启动后检查逾期事项。')}>
      <Typography color="text.secondary" sx={{ fontSize: 12, mb: 2 }}>{t('共 {{n}} 项待处理', { n: rows.filter(row => ['pending', 'due'].includes(row.status)).length })}</Typography>
    </Tooltip>
    <Menu anchorEl={createMenu} open={Boolean(createMenu)} onClose={() => setCreateMenu(null)}>
      <MenuItem data-todo-new onClick={() => create('todo')}>{t('待办')}</MenuItem>
      <MenuItem data-reminder-create-reminder onClick={() => create('reminder')}>{t('提醒')}</MenuItem>
    </Menu>
    {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
    <Tabs value={kind} onChange={(_e, value) => setKind(value)} sx={{ minHeight: 40, borderBottom: 1, borderColor: 'divider', mb: 2 }}>
      {([['all', '全部事项'], ['todo', '待办'], ['reminder', '提醒']] as const).map(([value, label]) => <Tab key={value} data-reminder-kind={value} value={value} label={t(label)} sx={{ minHeight: 40, minWidth: 80, fontSize: 13 }} />)}
    </Tabs>
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
      <TextField size="small" placeholder={t('搜索事项')} value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: '1 1 200px' }} />
      <TextField select size="small" label={t('状态')} value={filter} onChange={e => setFilter(e.target.value)} sx={{ width: 130 }} inputProps={{ 'data-reminder-status-filter': true }}>
        {[['active', '待处理'], ['upcoming', '即将到期'], ['due', '已到期'], ['completed', '已完成'], ['cancelled', '已取消'], ['all', '全部']].map(([value, label]) => <MenuItem key={value} value={value}>{t(label!)}</MenuItem>)}
      </TextField>
        <TextField select size="small" label={t('时间')} value={period} onChange={e => setPeriod(e.target.value as ReminderPeriod)} sx={{ width: 145 }} inputProps={{ 'data-reminder-period-filter': true }}>
          {([['all', '全部时间'], ['today', '今日'], ['week', '近一周'], ['nextWeek', '未来一周'], ['custom', '自定义']] as const).map(([value, label]) => <MenuItem key={value} value={value}>{t(label)}</MenuItem>)}
        </TextField>
    </Stack>
    {period === 'custom' && <Stack direction="row" spacing={1} sx={{ mb: 2 }} data-reminder-time-filter>
        <TextField type="date" size="small" label={t('开始日期')} value={from} onChange={e => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ 'data-reminder-date': 'from' }} sx={{ width: 170, colorScheme: theme => theme.palette.mode }} />
        <TextField type="date" size="small" label={t('结束日期')} value={to} onChange={e => setTo(e.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ 'data-reminder-date': 'to' }} sx={{ width: 170, colorScheme: theme => theme.palette.mode }} />
    </Stack>}
    {bounds.error && <Alert severity="warning" sx={{ mb: 2 }}>{t(bounds.error)}</Alert>}
    {!filtered.length && <Typography color="text.secondary" sx={{ py: 4, fontSize: 13 }}>{t('没有符合条件的事项')}</Typography>}
    <Stack spacing={1}>
      <PagedList name="reminders" resetKey={`${filter}/${kind}/${period}/${from}/${to}/${query}`} revealKey={highlightId}>
        {filtered.map(row => <Box key={row.id} data-reminder-row={row.id} sx={{ p: 1.5, border: 1, borderColor: highlightId === row.id ? 'primary.main' : 'divider', borderRadius: 2, bgcolor: 'background.paper', display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Tooltip title={t(['pending', 'due'].includes(row.status) ? '确认完成' : '恢复为待处理')}>
            <IconButton size="small" disabled={busy} aria-label={t(['pending', 'due'].includes(row.status) ? '确认完成' : '恢复为待处理')} onClick={() => act(row.id, ['pending', 'due'].includes(row.status) ? 'complete' : 'restore')} sx={{ mt: -.25 }}>
              {row.status === 'completed' ? <CheckCircleOutline fontSize="small" color="primary" /> : <RadioButtonUnchecked fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography component="button" disabled={busy} onClick={() => edit(row)} sx={{ fontFamily: 'inherit', background: 'none', border: 0, p: 0, color: 'text.primary', textAlign: 'left', cursor: 'pointer', fontSize: 14, fontWeight: 600, flex: 1, overflowWrap: 'anywhere', textDecoration: row.status === 'completed' ? 'line-through' : 'none' }}>{row.title}</Typography>
            {row.level === 'strong' && <Chip size="small" color="warning" variant="outlined" label={t('强提醒')} />}
            {row.status !== 'pending' && <Chip size="small" label={t(statusLabel[row.status])} />}
          </Stack>
          {row.description && <Typography data-reminder-description title={row.description} sx={{ mt: 0.75, fontSize: 12, color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>{row.description}</Typography>}
          {row.dueAt === null && row.timeExpression && <Typography sx={{ mt: 0.75, fontSize: 12, color: 'text.secondary' }}>{t('原始时间表达：{{text}}', { text: row.timeExpression })}</Typography>}
          <Typography sx={{ fontSize: 12, color: row.status === 'due' ? 'warning.main' : 'text.secondary', mt: 0.75 }}>{row.dueAt === null ? t('待办') : `${t('提醒')} · ${format(row.dueAt)}`}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{row.dueAt === null ? t('创建于 {{date}}', { date: format(row.createdAt) }) : row.recurrence ? `${t(row.recurrence.frequency === 'daily' ? '每天' : '每周')}${row.recurrence.weekdays?.map(day => ` ${t(['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][day]!)}`).join('') ?? ''}` : t(sourceLabel[row.source])}</Typography>
            {row.noteId && <Button size="small" onClick={() => onOpenNote(row.noteId!)}>{t('查看原始随记')}</Button>}
          </Stack>
          </Box>
          {['pending', 'due'].includes(row.status) && row.dueAt !== null && <SnoozeButton label={t('稍后提醒')} disabled={busy} onSnooze={minutes => act(row.id, 'snooze', minutes)} />}
          <IconButton size="small" data-reminder-more={row.id} aria-label={t('更多操作')} onClick={e => setRowMenu({ anchor: e.currentTarget, row })}><MoreHoriz fontSize="small" /></IconButton>
        </Box>)}
      </PagedList>
    </Stack>
    <Menu anchorEl={rowMenu?.anchor} open={Boolean(rowMenu)} onClose={() => setRowMenu(null)}>
      <MenuItem disabled={busy} onClick={() => rowMenu && edit(rowMenu.row)}>{t('编辑')}</MenuItem>
      <MenuItem disabled={busy} onClick={() => rowMenu && duplicate(rowMenu.row)}>{t('复制')}</MenuItem>
      {rowMenu && ['pending', 'due'].includes(rowMenu.row.status) && <MenuItem disabled={busy} onClick={() => { act(rowMenu.row.id, 'cancel'); setRowMenu(null) }}>{t(rowMenu.row.dueAt === null ? '取消待办' : '取消提醒')}</MenuItem>}
      <MenuItem disabled={busy} sx={{ color: 'error.main' }} onClick={() => { if (rowMenu) setDeleting(rowMenu.row); setRowMenu(null) }}>{t('删除')}</MenuItem>
    </Menu>
    <Dialog open={Boolean(editor)} onClose={() => !busy && setEditor(null)} fullWidth maxWidth="sm">
      <DialogTitle>{t(editor?.form.kind === 'todo' ? editor.id ? '编辑待办' : editor.duplicate ? '复制待办' : '新建待办' : editor?.id ? '编辑提醒' : editor?.duplicate ? '复制提醒' : '新建提醒')}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {editor?.duplicate && <Alert severity="info" sx={{ mb: 2 }}>{t('复制不会自动创建，请确认时间后保存。')}</Alert>}
        {editor && <Fields form={editor.form} change={form => setEditor({ ...editor, form })} />}</DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setEditor(null)}>{t('取消')}</Button><Button disabled={busy} variant="contained" onClick={() => {
        if (editor) void perform(async () => {
          const row = await window.api.reminders.save(input(editor.form, editor.source, editor.noteId, rows.find(row => row.id === editor.id)), editor.id)
          setKind(row.dueAt === null ? 'todo' : 'reminder'); setPeriod('all'); setFilter(['pending', 'due'].includes(row.status) ? 'active' : row.status); setQuery(''); setHighlightId(row.id)
        }).then(ok => { if (ok) setEditor(null) })
      }}>{t(editor?.form.kind === 'reminder' ? '保存提醒' : '保存为待办')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(review)} onClose={() => !busy && setReview(null)} fullWidth maxWidth="sm">
      <DialogTitle>{t('确认待办与提醒')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 2 }}>{t('选择要保存的事项，核对时间。没有精确时间的事项可保存为待办。')}</Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {review && <Stack spacing={2}><PagedList name="reminder-drafts">{review.drafts.map((draft, i) => <Box key={String(i)} sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 2 }}>
          <FormControlLabel control={<Checkbox checked={review.selected[i]} onChange={e => setReview({ ...review, selected: review.selected.map((v, n) => n === i ? e.target.checked : v) })} />}
            label={t(draft.intent === 'possible' ? '可能的计划 · 默认不选' : '保存此事项')} />
          {(draft.time_expression || draft.issue) && <Typography sx={{ fontSize: 12, color: 'warning.main', mb: 1 }}>{draft.time_expression} {draft.issue && t(draft.issue)}</Typography>}
          <Fields form={review.forms[i]!} change={form => setReview({ ...review, forms: review.forms.map((v, n) => n === i ? form : v) })} />
        </Box>)}</PagedList></Stack>}
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setReview(null)}>{t('取消')}</Button><Button variant="contained" disabled={busy || !review?.selected.some(Boolean)} onClick={() => {
        if (review) void perform(async () => {
          const saved = await window.api.reminders.saveMany(review.forms.filter((_v, n) => review.selected[n]).map(form => input(form, review.noteId ? 'note' : 'voice', review.noteId)))
          setKind('all'); setPeriod('all'); setFilter('active'); setQuery(''); setHighlightId(saved[0]?.id)
        }).then(ok => { if (ok) setReview(null) })
      }}>{t('保存所选事项')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(deleting)} onClose={() => !busy && setDeleting(null)} fullWidth maxWidth="xs"
      PaperProps={{ sx: { minWidth: 320 } }}><DialogTitle>{t(deleting?.dueAt === null ? '删除这条待办？' : '删除这条提醒？')}</DialogTitle><DialogContent sx={{ overflowWrap: 'anywhere' }}>{deleting?.title}</DialogContent>
      <DialogActions><Button onClick={() => setDeleting(null)}>{t('取消')}</Button><Button color="error" disabled={busy} onClick={() => deleting && void perform(() => window.api.reminders.remove(deleting.id)).then(ok => { if (ok) setDeleting(null) })}>{t('删除')}</Button></DialogActions>
    </Dialog>
  </Box>
}
