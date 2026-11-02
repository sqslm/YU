import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, ButtonBase, Dialog, DialogContent, DialogTitle, IconButton, List, ListItemButton, Stack, TextField, Tooltip, Typography } from '@mui/material'
import SearchRounded from '@mui/icons-material/SearchRounded'
import type { LocalRecord } from '@shared/workspace'
import { useTranslation } from 'react-i18next'
import { searchErrorText } from './searchError'
import { groupRecords } from './workspaceSearchGroups'

const KINDS = { chat: '聊天', note: '随记', history: '历史记录', reminder: '提醒与待办', event: '日程' }

/**
 * The sidebar's search entry.
 *
 * It is a control that opens the dialog, so the whole thing is the control: a
 * field-shaped button the size of a search input. Only the magnifier used to be
 * clickable, which reads as "this is an icon, not a field" — people clicked the
 * label and nothing happened. In rail mode there is no room for a field, so the
 * icon stands alone.
 */
export function WorkspaceSearch({ rail = false, onOpen }: { rail?: boolean; onOpen(record: LocalRecord): Promise<void> }): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [items, setItems] = useState<LocalRecord[]>([])
  const [busy, setBusy] = useState(false), [more, setMore] = useState(false), [error, setError] = useState('')
  const ticket = useRef(0)
  const messageOf = (reason: unknown): string => searchErrorText(reason, t)
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
  const groups = groupRecords(items)
  return <>
    {rail
      ? <Tooltip title={t('搜索全部内容')} placement="right"><IconButton data-workspace-search aria-label={t('搜索全部内容')} onClick={() => setOpen(true)}><SearchRounded fontSize="small" /></IconButton></Tooltip>
      : <ButtonBase
          data-workspace-search
          aria-label={t('搜索全部内容')}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          sx={{
            width: '100%',
            height: 34,
            px: 1.25,
            gap: 1,
            borderRadius: 2,
            justifyContent: 'flex-start',
            color: 'text.secondary',
            border: 1,
            borderColor: 'divider',
            bgcolor: 'action.hover',
            transition: 'border-color .15s ease, background-color .15s ease, color .15s ease',
            '&:hover': { color: 'text.primary', borderColor: 'text.disabled', bgcolor: 'action.selected' },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
          }}
        >
          <SearchRounded sx={{ fontSize: 16, flexShrink: 0 }} />
          <Typography component="span" sx={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t('搜索全部内容')}</Typography>
        </ButtonBase>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
      <DialogTitle>{t('搜索全部内容')}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth size="small" label={t('搜索聊天、附件、随记和历史')} value={query} onChange={event => setQuery(event.target.value)} inputProps={{ maxLength: 200 }} sx={{ mt: 1 }} />
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        {groups.map((group, index) => <Box key={group.kind} data-workspace-group={group.kind} sx={{ mt: index ? 1.5 : 1 }}>
          {/* Sticky so the kind stays visible while scrolling its own results; the rule
              running to the right edge keeps the header from reading like a title. */}
          <Stack direction="row" alignItems="center" gap={1} sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', py: .75, pl: .25 }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: .5, color: 'text.secondary' }}>{t(KINDS[group.kind])}</Typography>
            <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>{group.rows.length}</Typography>
            <Box sx={{ flex: 1, height: 1, bgcolor: 'divider' }} />
          </Stack>
          <List dense disablePadding>{group.rows.map(record => <ListItemButton key={`${record.kind}:${record.id}`} data-workspace-hit onClick={() => { void onOpen(record).then(() => setOpen(false)).catch(error => setError(messageOf(error))) }} sx={{ borderRadius: 1.5, alignItems: 'flex-start', py: 1.25, px: 1 }}>
            <Box sx={{ minWidth: 0, width: '100%' }}>
              <Typography fontSize={13} fontWeight={600} noWrap>{record.title || t(KINDS[record.kind])}</Typography>
              {!!record.text && <Typography fontSize={12} color="text.secondary" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mt: .25, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{record.text}</Typography>}
            </Box>
          </ListItemButton>)}</List>
        </Box>)}
        {!busy && query.trim() && !items.length && !error && <Typography color="text.secondary">{t('没有找到匹配内容')}</Typography>}
        {busy && <Typography role="status" color="text.secondary">{t('搜索中…')}</Typography>}
        {more && <Button disabled={busy} onClick={() => void next()}>{t('加载更多')}</Button>}
      </DialogContent>
    </Dialog>
  </>
}
