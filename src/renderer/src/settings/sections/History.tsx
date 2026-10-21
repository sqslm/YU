import { useCallback, useEffect, useState } from 'react'
import { Box, Button, IconButton, Paper, Stack, TextField, Typography } from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import type { HistoryEntry } from '@shared/types'
import { IconHistory } from './General'
import i18n from '../../i18n'

const MODE_LABEL: Record<string, string> = {
  dictation: '听写',
  translate: '翻译',
  ask: '问答'
}

const MODE_TINT: Record<string, string> = {
  dictation: 'text.secondary',
  translate: 'primary.main',
  ask: 'secondary.main'
}

export function HistorySection(): JSX.Element {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (search: string) => {
    setLoading(true)
    const list = await window.api.history.list(search)
    setItems(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    const id = setTimeout(() => void refresh(query), 150)
    return () => clearTimeout(id)
  }, [query, refresh])

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <TextField
          placeholder={i18n.t(i18n.t('搜索转写内容、应用名…'))}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          variant="outlined"
          color="error"
          onClick={async () => {
            await window.api.history.clear()
            await refresh(query)
          }}
        >
          {i18n.t('清空')}
        </Button>
      </Box>

      {loading && <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t(i18n.t('加载中…'))}</Typography>}
      {!loading && items.length === 0 && (
        <Box
          sx={{
            py: 6,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1,
            color: 'text.disabled'
          }}
        >
          <IconHistory size={22} />
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            {i18n.t('还没有记录。按住 Right Alt 说一句话试试。')}
          </Typography>
        </Box>
      )}

      <Stack spacing={1}>
        {items.map((item) => (
          <Paper key={item.id} sx={{ p: 1.75 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
              <Box
                sx={{
                  px: 0.75,
                  height: 18,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '5px',
                  bgcolor: 'action.hover',
                  border: 1,
                  borderColor: 'divider',
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: MODE_TINT[item.mode] ?? 'text.secondary'
                }}
              >
                {i18n.t(MODE_LABEL[item.mode] ?? item.mode)}
              </Box>
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                {new Date(item.createdAt).toLocaleString()} · {(item.durationMs / 1000).toFixed(1)}s
                {item.app ? ` · ${item.app}` : ''}
              </Typography>
              <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5 }}>
                <IconButton
                  size="small"
                  aria-label={i18n.t(i18n.t('复制'))}
                  sx={{
                    color: 'text.secondary',
                    '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
                  }}
                  onClick={() => void navigator.clipboard.writeText(item.final || item.transcript)}
                >
                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label={i18n.t(i18n.t('删除'))}
                  sx={{
                    color: 'text.secondary',
                    '&:hover': { color: 'error.main', bgcolor: 'action.hover' }
                  }}
                  onClick={async () => {
                    await window.api.history.remove(item.id)
                    await refresh(query)
                  }}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            </Box>
            <Typography
              sx={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'text.primary' }}
            >
              {item.final || item.transcript || item.error || i18n.t('（空）')}
            </Typography>
            {item.error && (
              <Typography sx={{ fontSize: 11, color: 'error.main', mt: 0.5 }}>{item.error}</Typography>
            )}
          </Paper>
        ))}
      </Stack>
    </Stack>
  )
}
