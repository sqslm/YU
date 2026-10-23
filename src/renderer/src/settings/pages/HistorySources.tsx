import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { SearchResult } from '@shared/types'
import { PagedList } from '../Pagination'
import { historySources } from './historyView'

export function HistorySources({ id, sources }: { id: string; sources: SearchResult[] }): JSX.Element | null {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const safe = historySources(sources)
  if (!safe.length) return null
  const links = (all ? safe : safe.slice(0, 4)).map(({ source, number }) => <Typography key={`${number}-${source.url}`} component="a"
    data-history-source={number} href={source.url} target="_blank" rel="noreferrer" title={`${source.title}\n${source.url}`}
    sx={{ display: 'block', fontSize: 11.5, color: 'primary.main', textDecoration: 'none', overflowWrap: 'anywhere', '&:hover': { textDecoration: 'underline' } }}>
    [{number}] {source.title || source.url}
  </Typography>)
  return <Box sx={{ mt: 1 }}>
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {all ? <PagedList name={`history-sources-${id}`}>{links}</PagedList> : links}
    </Box>
    {safe.length > 4 && <Button size="small" data-history-sources-toggle={id} aria-expanded={all} sx={{ p: 0, mt: 0.5, fontSize: 11.5 }}
      onClick={() => setAll(value => !value)}>{all ? t('收起来源') : t('查看全部来源（{{n}}）', { n: safe.length })}</Button>}
  </Box>
}
