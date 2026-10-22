import { Children, createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react'
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material'
import i18n from '../i18n'

export const PaginationSettings = createContext({ size: 30, change: (_size: number): void => {} })

export function Pager({ page, total, size, onPage, onSize, name = 'list' }: {
  page: number; total: number; size: number; onPage: (page: number) => void; onSize?: (size: number) => void; name?: string
}): JSX.Element {
  const pages = Math.max(1, Math.ceil(total / size))
  return <Box data-pagination={name} sx={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, py: 1 }}>
    {onSize && <TextField select fullWidth={false} size="small" value={size} onChange={event => onSize(Number(event.target.value))}
      inputProps={{ 'aria-label': i18n.t('每页条数') }} sx={{ mr: 'auto', width: 118, flexShrink: 0, '& .MuiSelect-select': { py: 0.5, fontSize: 11.5 } }}>
      {[10, 20, 30, 50, 100].map(value => <MenuItem key={value} value={value}>{i18n.t('每页 {{n}} 条', { n: value })}</MenuItem>)}
    </TextField>}
    <Button size="small" data-page-prev disabled={page <= 1} onClick={() => onPage(page - 1)} sx={{ fontSize: 11.5 }}>{i18n.t('上一页')}</Button>
    <Typography sx={{ fontSize: 11.5, color: 'text.secondary', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{i18n.t('第 {{page}} / {{total}} 页', { page, total: pages })}</Typography>
    <Button size="small" data-page-next disabled={page >= pages} onClick={() => onPage(page + 1)} sx={{ fontSize: 11.5 }}>{i18n.t('下一页')}</Button>
  </Box>
}

/** Paginate data rows only; callers retain filtering, ordering and batch actions. */
export function PagedList({ children, name, resetKey = '', revealKey }: { children: ReactNode; name: string; resetKey?: string; revealKey?: string | null }): JSX.Element {
  const { size, change } = useContext(PaginationSettings)
  const [page, setPage] = useState(1)
  const rows: ReactNode[] = []
  Children.forEach(children, child => { if (isValidElement(child)) rows.push(child) })
  const safe = Math.min(page, Math.max(1, Math.ceil(rows.length / size)))
  useEffect(() => setPage(1), [size, resetKey])
  const revealIndex = revealKey ? rows.findIndex(row => isValidElement(row) && row.key === revealKey) : -1
  useEffect(() => { if (page !== safe) setPage(safe) }, [page, safe])
  useEffect(() => {
    if (revealIndex >= 0) setPage(Math.floor(revealIndex / size) + 1)
  }, [revealKey, size, revealIndex])
  const controls = rows.length > size ? <Pager name={name} page={safe} total={rows.length} size={size} onPage={setPage} onSize={change} /> : null
  return <>{controls}{rows.slice((safe - 1) * size, safe * size)}{controls}</>
}
