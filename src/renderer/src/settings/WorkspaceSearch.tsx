import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, IconButton, List, ListItemButton, Stack, TextField, Tooltip, Typography } from '@mui/material'
import SearchRounded from '@mui/icons-material/SearchRounded'
import type { LocalRecord } from '@shared/workspace'
import { useTranslation } from 'react-i18next'

const KINDS = { chat: '聊天', note: '随记', history: '历史记录', reminder: '提醒与待办', event: '日程' }
export function WorkspaceSearch({ onOpen }: { onOpen(record: LocalRecord): Promise<void> }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [items, setItems] = useState<LocalRecord[]>([])
  const [busy, setBusy] = useState(false), [more, setMore] = useState(false), [error, setError] = useState('')
  const ticket = useRef(0)
  const messageOf = (error: unknown): string => t((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  useEffect(() => {
    const request = ++ticket.current
    setItems([]); setMore(false); setError('')
    if (!open || !query.trim()) { setBusy(false); return }
    setBusy(true)
    const timer = setTimeout(() => {
      void window.api.workspace.search(query).then(page => { if (request === ticket.current) { setItems(page.items); setMore(page.hasMore) } })
        .catch(error => { if (request === ticket.current) setError(messageOf(error)) }).finally(() => { if (request === ticket.current) setBusy(false) })
    }, 200)
    return () => clearTimeout(timer)
  }, [open, query])
  const next = async (): Promise<void> => {
    const request = ticket.current; setBusy(true)
    try { const page = await window.api.workspace.search(query, items.length); if (request === ticket.current) { setItems(previous => [...previous, ...page.items]); setMore(page.hasMore) } }
    catch (error) { if (request === ticket.current) setError(messageOf(error)) }
    finally { if (request === ticket.current) setBusy(false) }
  }
  return <>
    <Tooltip title={t('搜索全部内容')}><IconButton aria-label={t('搜索全部内容')} onClick={() => setOpen(true)}><SearchRounded fontSize="small" /></IconButton></Tooltip>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
      <DialogTitle>{t('搜索全部内容')}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth size="small" label={t('搜索聊天、附件、随记和历史')} value={query} onChange={event => setQuery(event.target.value)} inputProps={{ maxLength: 200 }} sx={{ mt: 1 }} />
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        <List>{items.map(record => <ListItemButton key={`${record.kind}:${record.id}`} onClick={() => { void onOpen(record).then(() => setOpen(false)).catch(error => setError(messageOf(error))) }} sx={{ borderBottom: 1, borderColor: 'divider', alignItems: 'flex-start', py: 1.5 }}>
          <Box sx={{ minWidth: 0, width: '100%' }}><Stack direction="row" justifyContent="space-between" gap={2}><Typography fontSize={13} fontWeight={600}>{record.title || t(KINDS[record.kind])}</Typography><Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{t(KINDS[record.kind])}</Typography></Stack><Typography fontSize={12} color="text.secondary" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mt: .5 }}>{record.text}</Typography></Box>
        </ListItemButton>)}</List>
        {!busy && query.trim() && !items.length && <Typography color="text.secondary">{t('没有找到匹配内容')}</Typography>}
        {busy && <Typography role="status" color="text.secondary">{t('搜索中…')}</Typography>}
        {more && <Button disabled={busy} onClick={() => void next()}>{t('加载更多')}</Button>}
      </DialogContent>
    </Dialog>
  </>
}
