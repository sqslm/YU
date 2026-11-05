import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, InputBase, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { KnowledgeCard, KnowledgeCardSummary } from '@shared/knowledge'
import { IconSearch } from '../icons'
import { CARD_PAGE_SIZE, kindKey, mergePage, type CardList } from '../pages/knowledgeView'

/** The reason a failed bridge call shows; the backend's own message wins. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Picks one existing card. The search box goes through the backend
 * (`searchCards`), so the picker can reach a card that is not in the page behind
 * it; the parent gets the full card because merging needs its revision and body.
 */
export function KnowledgeCardPicker({ excludeIds, onPick }: { excludeIds?: readonly string[]; onPick: (card: KnowledgeCard) => void }): JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [list, setList] = useState<CardList>({ items: [], total: 0, nextOffset: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const gate = useRef(0)

  const load = (offset: number): void => {
    const ticket = (gate.current += 1)
    setLoading(true)
    setError('')
    const text = query.trim()
    const request = text
      ? window.api.knowledge.searchCards({ query: text, offset, limit: CARD_PAGE_SIZE })
      : window.api.knowledge.listCards({ offset, limit: CARD_PAGE_SIZE })
    void request
      .then((page) => {
        if (ticket !== gate.current) return
        setList((current) => mergePage(offset === 0 ? null : current, page))
      })
      .catch((err) => {
        if (ticket === gate.current) setError(messageOf(err))
      })
      .finally(() => {
        if (ticket === gate.current) setLoading(false)
      })
  }

  useEffect(() => {
    const timer = setTimeout(() => load(0), 150)
    return () => clearTimeout(timer)
    // `load` closes over the current query; a new query is the only reason to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const rows = list.items.filter((row) => !excludeIds?.includes(row.id))

  const pick = async (row: KnowledgeCardSummary): Promise<void> => {
    try {
      setError('')
      onPick(await window.api.knowledge.getCard(row.id))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <Stack spacing={1} sx={{ minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, border: 1, borderColor: 'divider', borderRadius: 2, px: 1.25, height: 36 }}>
        <IconSearch size={14} />
        <InputBase
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('knowledge.searchPlaceholder')}
          inputProps={{ 'aria-label': t('knowledge.searchPlaceholder'), maxLength: 200 }}
          sx={{ flex: 1, fontSize: 13 }}
        />
      </Box>
      {error && <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => load(0)}>{t('common.retry')}</Button>}>{error}</Alert>}
      <Box sx={{ maxHeight: 240, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 2 }}>
        {rows.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>{t(loading ? 'common.loading' : 'knowledge.emptyFilters')}</Typography>
        ) : (
          <List dense disablePadding>
            {rows.map((row) => (
              <ListItemButton key={row.id} onClick={() => void pick(row)}>
                <ListItemText
                  primary={row.title}
                  secondary={t(kindKey(row.kind))}
                  primaryTypographyProps={{ fontSize: 13, noWrap: true }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Box>
      {list.nextOffset !== null && (
        <Button size="small" disabled={loading} onClick={() => load(list.nextOffset ?? 0)}>{t('knowledge.loadMore')}</Button>
      )}
    </Stack>
  )
}
