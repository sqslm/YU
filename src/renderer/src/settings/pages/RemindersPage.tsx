import { useEffect, useState } from 'react'
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { Reminder, ReminderAction, ReminderDraft, ReminderInput, ReminderView } from '@shared/reminders'
import { localDateTime } from '@shared/reminders'
import { PagedList } from '../Pagination'
import { ReminderDateTime } from './ReminderDateTime'
import { SnoozeButton } from '../../reminder/SnoozeButton'

interface Form { title: string; description: string; timeExpression: string; date: string; level: 'normal' | 'strong'; repeat: 'none' | 'daily' | 'weekly'; weekday: number }
const empty = (): Form => ({ title: '', description: '', timeExpression: '', date: '', level: 'normal', repeat: 'none', weekday: 1 })
const fromReminder = (row: Reminder): Form => ({ title: row.title, description: row.description ?? '', timeExpression: row.timeExpression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.recurrence?.frequency ?? 'none', weekday: row.recurrence?.weekdays?.[0] ?? 1 })
const fromDraft = (row: ReminderDraft): Form => ({ title: row.title, description: row.description ?? '', timeExpression: row.time_expression ?? '', date: localDateTime(row.dueAt), level: row.level,
  repeat: row.rule?.frequency ?? row.recurrence ?? 'none', weekday: row.rule?.weekdays?.[0] ?? -1 })

function input(form: Form, source: ReminderInput['source'], noteId?: string, original?: Reminder): ReminderInput {
  const sameDate = original && form.date === localDateTime(original.dueAt)
  const dueAt = sameDate ? original.dueAt : form.date ? new Date(form.date).getTime() : null
  if (!form.title.trim()) throw new Error('请输入提醒事项')
  if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt <= Date.now() && !(sameDate && original.status !== 'pending'))) throw new Error('请选择将来的提醒时间')
  if (form.repeat !== 'none' && dueAt === null) throw new Error('重复提醒需要具体时刻')
  if (form.repeat === 'weekly' && form.weekday < 0) throw new Error('请选择每周的星期')
  const date = new Date(dueAt ?? Date.now())
  return { title: form.title, description: form.description, timeExpression: form.timeExpression || undefined, dueAt, level: form.level, source, noteId,
    recurrence: sameDate && form.repeat === (original.recurrence?.frequency ?? 'none') && form.weekday === (original.recurrence?.weekdays?.[0] ?? 1) ? original.recurrence : form.repeat === 'none' ? null : { frequency: form.repeat, hour: date.getHours(), minute: date.getMinutes(),
      ...(form.repeat === 'weekly' ? { weekdays: [form.weekday] } : {}) } }
}

function Fields({ form, change }: { form: Form; change: (form: Form) => void }): JSX.Element {
  const { t } = useTranslation()
  return <Stack spacing={1.5}>
    <TextField label={t('提醒事项')} size="small" value={form.title} onChange={e => change({ ...form, title: e.target.value })} inputProps={{ maxLength: 300 }} />
    <TextField label={t('提醒备注（可选）')} size="small" multiline minRows={2} maxRows={4} value={form.description}
      onChange={e => change({ ...form, description: e.target.value })} inputProps={{ maxLength: 4000 }} />
    <ReminderDateTime value={form.date} onChange={date => change({ ...form, date,
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
    </Stack>
  </Stack>
}

export function RemindersPage({ view, onOpenNote, onViewConsumed }: { view: ReminderView | null; onOpenNote: (id: string) => void; onViewConsumed: () => void }): JSX.Element {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<Reminder[]>([]), [error, setError] = useState(''), [query, setQuery] = useState('')
  const [filter, setFilter] = useState('active'), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ id?: string; form: Form; source: ReminderInput['source']; noteId?: string; duplicate?: boolean } | null>(null)
  const [review, setReview] = useState<{ drafts: ReminderDraft[]; forms: Form[]; selected: boolean[]; noteId?: string } | null>(null)
  const [deleting, setDeleting] = useState<Reminder | null>(null)
  const [highlightId, setHighlightId] = useState<string | undefined>()
  const reload = (): void => { void window.api.reminders.list().then(setRows).catch(e => setError(String(e.message ?? e))) }
  useEffect(() => { reload(); return window.api.reminders.onChanged(reload) }, [])
  useEffect(() => {
    if (!view) return
    setHighlightId(view.id)
    if (view?.id) { setQuery(''); setFilter('all') }
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
      if (ok && action === 'restore') { setFilter('active'); setQuery(''); setHighlightId(id) }
    })
  }
  const format = (stamp: number | null): string => stamp === null ? t('未设置时间 · 待办') : new Date(stamp).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')
  const sourceLabel = { manual: '手动', voice: '语音快捷键', note: '随记' }
  const statusLabel = { pending: '待处理', due: '已到期', completed: '已完成', cancelled: '已取消' }
  const filtered = rows.filter(row => (filter === 'all' || filter === 'active' && ['pending', 'due'].includes(row.status) || filter === 'upcoming' && row.status === 'pending' && row.dueAt !== null || row.status === filter) && `${row.title}\n${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <Box sx={{ p: 3 }} data-reminders-page>
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
      <Typography variant="h6" sx={{ fontWeight: 650 }}>{t('提醒')}</Typography>
      <Button variant="contained" size="small" onClick={() => { setError(''); setEditor({ form: empty(), source: 'manual' }) }} data-reminder-new>{t('新建提醒')}</Button>
    </Stack>
    <Typography color="text.secondary" sx={{ fontSize: 12, mb: 2 }}>{t('本地提醒，无需登录。软件完全退出或电脑关机时不触发，重新启动后检查逾期事项。')}</Typography>
    {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
    <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 1, mb: 2 }}>
      {[['active', '待处理'], ['upcoming', '即将到期'], ['due', '已到期'], ['completed', '已完成'], ['cancelled', '已取消'], ['all', '全部']].map(([value, label]) =>
        <Chip key={value} size="small" label={t(label!)} variant={filter === value ? 'filled' : 'outlined'} onClick={() => setFilter(value!)} />)}
    </Stack>
    <TextField size="small" placeholder={t('搜索提醒事项')} value={query} onChange={e => setQuery(e.target.value)} sx={{ mb: 2, maxWidth: 360 }} />
    {!filtered.length && <Typography color="text.secondary" sx={{ py: 4, fontSize: 13 }}>{t('没有符合条件的提醒')}</Typography>}
    <Stack spacing={1}>
      <PagedList name="reminders" resetKey={`${filter}/${query}`} revealKey={highlightId}>
        {filtered.map(row => <Box key={row.id} data-reminder-row={row.id} sx={{ p: 1.75, border: 1, borderColor: highlightId === row.id ? 'primary.main' : 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1, overflowWrap: 'anywhere' }}>{row.title}</Typography>
            <Chip size="small" color={row.level === 'strong' ? 'warning' : 'default'} variant="outlined" label={t(row.level === 'strong' ? '强提醒' : '普通提醒')} />
            <Chip size="small" label={t(statusLabel[row.status])} />
          </Stack>
          {row.description && <Typography data-reminder-description title={row.description} sx={{ mt: 0.75, fontSize: 12, color: 'text.secondary', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>{row.description}</Typography>}
          {row.dueAt === null && row.timeExpression && <Typography sx={{ mt: 0.75, fontSize: 12, color: 'text.secondary' }}>{t('原始时间表达：{{text}}', { text: row.timeExpression })}</Typography>}
          <Typography sx={{ fontSize: 12, color: row.status === 'due' ? 'warning.main' : 'text.secondary', mt: 0.75 }}>{format(row.dueAt)}</Typography>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{t(sourceLabel[row.source])} · {t(row.recurrence?.frequency === 'daily' ? '每天' : row.recurrence ? '每周' : '不重复')}{row.recurrence?.weekdays?.map(day => ` ${t(['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][day]!)}`)}</Typography>
            {row.noteId && <Button size="small" onClick={() => onOpenNote(row.noteId!)}>{t('查看原始随记')}</Button>}
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
            {['pending', 'due'].includes(row.status) && <><Button size="small" disabled={busy} onClick={() => act(row.id, 'complete')}>{t('确认完成')}</Button>
              <SnoozeButton label={t('稍后提醒')} disabled={busy} onSnooze={minutes => act(row.id, 'snooze', minutes)} />
              <Button size="small" disabled={busy} onClick={() => act(row.id, 'cancel')}>{t('取消提醒')}</Button></>}
            {['completed', 'cancelled'].includes(row.status) && <Button size="small" disabled={busy}
              title={t('未来的提醒保留时间；过期事项恢复为待办，重复提醒安排下一次。')} onClick={() => act(row.id, 'restore')}>{t('恢复为待处理')}</Button>}
            <Button size="small" disabled={busy} onClick={() => setEditor({ id: row.id, form: fromReminder(row), source: row.source, noteId: row.noteId })}>{t('编辑')}</Button>
            <Button size="small" disabled={busy} onClick={() => {
              const form = fromReminder(row)
              if (form.date && new Date(form.date).getTime() <= Date.now()) form.date = ''
              setError(''); setEditor({ form, source: 'manual', noteId: row.noteId, duplicate: true })
            }}>{t('复制提醒')}</Button>
            <Button size="small" color="inherit" disabled={busy} onClick={() => setDeleting(row)}>{t('删除')}</Button>
          </Stack>
        </Box>)}
      </PagedList>
    </Stack>
    <Dialog open={Boolean(editor)} onClose={() => !busy && setEditor(null)} fullWidth maxWidth="sm">
      <DialogTitle>{t(editor?.id ? '编辑提醒' : editor?.duplicate ? '复制提醒' : '新建提醒')}</DialogTitle>
      <DialogContent sx={{ pt: '12px !important' }}>{error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {editor?.duplicate && <Alert severity="info" sx={{ mb: 2 }}>{t('复制不会自动创建，请确认时间后保存。')}</Alert>}
        {editor && <Fields form={editor.form} change={form => setEditor({ ...editor, form })} />}</DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setEditor(null)}>{t('取消')}</Button><Button disabled={busy} variant="contained" onClick={() => {
        if (editor) void perform(async () => {
          const row = await window.api.reminders.save(input(editor.form, editor.source, editor.noteId, rows.find(row => row.id === editor.id)), editor.id)
          setFilter(['pending', 'due'].includes(row.status) ? 'active' : row.status); setQuery(''); setHighlightId(row.id)
        }).then(ok => { if (ok) setEditor(null) })
      }}>{t(editor?.form.date ? '保存提醒' : '保存为待办')}</Button></DialogActions>
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
          setFilter('active'); setQuery(''); setHighlightId(saved[0]?.id)
        }).then(ok => { if (ok) setReview(null) })
      }}>{t('保存所选事项')}</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(deleting)} onClose={() => !busy && setDeleting(null)} fullWidth maxWidth="xs"
      PaperProps={{ sx: { minWidth: 320 } }}><DialogTitle>{t('删除这条提醒？')}</DialogTitle><DialogContent sx={{ overflowWrap: 'anywhere' }}>{deleting?.title}</DialogContent>
      <DialogActions><Button onClick={() => setDeleting(null)}>{t('取消')}</Button><Button color="error" disabled={busy} onClick={() => deleting && void perform(() => window.api.reminders.remove(deleting.id)).then(ok => { if (ok) setDeleting(null) })}>{t('删除')}</Button></DialogActions>
    </Dialog>
  </Box>
}
