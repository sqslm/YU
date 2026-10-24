import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { Briefing, BriefingRecord } from '@shared/briefing'
import { MAX_BRIEFING_HISTORY } from '@shared/briefing'
import { dayKeyOf } from './calendarView'
import { bodyLines, briefingHint, formatBriefingDay, formatGeneratedAt, groupHistory, isEmptyHistory, quietSummary } from './briefingView'
import i18n from '../../i18n'

/** Electron prefixes IPC rejections; the user only needs the sentence after it. */
function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(error)
}

/**
 * The hub's 简报 page: today's briefing, the delivered history, and a read-only
 * view of when it arrives.
 *
 * Read-only by design. Everything that changes when or whether a briefing is sent
 * lives in 设置 → 每日简报, and the assistant can already generate one on demand;
 * duplicating those switches here would give the user two places to look when a
 * briefing does not show up.
 */
export function BriefingPage({ settings, onOpenSettings }: { settings: Settings; onOpenSettings?: () => void }): JSX.Element {
  const language: 'zh' | 'en' = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  /** Recomputed per render: the page can sit open past midnight. */
  const today = dayKeyOf(Date.now())
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [records, setRecords] = useState<BriefingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [openDay, setOpenDay] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [current, history] = await Promise.all([window.api.life.briefing(), window.api.life.briefingHistory()])
      setBriefing(current)
      setRecords(history)
      setError('')
    } catch (failure) { setError(messageOf(failure)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * The scheduler pushes a briefing while this page is open. Adopt the delivered
   * copy and re-read the history instead of composing one here: the list has to
   * show what was actually sent, including the days that were skipped.
   */
  useEffect(() => window.api.life.onBriefing(next => {
    setBriefing(next)
    void window.api.life.briefingHistory().then(setRecords).catch(() => setRecords([]))
  }), [])

  const refresh = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const next = await window.api.life.refreshBriefing()
      setBriefing(next)
      setRecords(await window.api.life.briefingHistory())
      setError('')
    } catch (failure) { setError(messageOf(failure)) }
    finally { setBusy(false) }
  }

  const lines = useMemo(() => bodyLines(briefing?.body ?? ''), [briefing?.body])
  const days = useMemo(() => groupHistory(records, MAX_BRIEFING_HISTORY), [records])
  const empty = isEmptyHistory(records)

  return (
    <Box sx={{ p: 3, maxWidth: 820 }} data-briefing-page>
      <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 0.75 }}>
        <Typography variant="h6" sx={{ fontWeight: 650, mr: 1 }}>{formatBriefingDay(today, language)}</Typography>
        <Button size="small" variant="contained" disabled={busy} data-briefing-refresh onClick={() => void refresh()}>
          {busy ? i18n.t('正在生成…') : i18n.t('立即生成')}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 12, color: settings.briefing.enabled ? 'text.secondary' : 'warning.main' }}>
          {briefingHint(settings.briefing, language)}
        </Typography>
      </Stack>

      {/* Read-only summary of the two settings that decide whether a briefing
          arrives: the delivery clock and the silence window it has to wait out. */}
      <Box
        role={onOpenSettings ? 'button' : undefined}
        tabIndex={onOpenSettings ? 0 : undefined}
        data-briefing-summary
        onClick={onOpenSettings}
        onKeyDown={event => { if (onOpenSettings && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpenSettings() } }}
        sx={{
          mb: 1.5, display: 'inline-flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.5, borderRadius: '8px',
          fontSize: 12, color: 'text.secondary',
          cursor: onOpenSettings ? 'pointer' : 'default',
          '&:hover': onOpenSettings ? { bgcolor: 'action.hover', color: 'text.primary' } : undefined,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
        }}
      >
        {quietSummary(settings.briefing, language)}
        {onOpenSettings && <Box component="span" aria-hidden sx={{ opacity: 0.7 }}>›</Box>}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError('')}>{error}</Alert>}

      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', p: 1.75, mb: 2 }}>
        {loading && <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{i18n.t('读取中…')}</Typography>}
        {!loading && !briefing && <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{i18n.t('还没有今天的简报，点「立即生成」看看。')}</Typography>}
        {briefing && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 650, flex: 1, minWidth: 0 }}>{briefing.title}</Typography>
              {/* Narration may rewrite the wording; saying so keeps the reader from
                  treating a model sentence as a record of their calendar. */}
              {briefing.source === 'model' && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{i18n.t('由模型改写')}</Typography>}
            </Box>
            {lines.length === 0 && <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>{i18n.t('今天没有需要汇报的安排。')}</Typography>}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {lines.map((line, index) => line === ''
                ? <Box key={`gap-${index}`} sx={{ height: 6 }} />
                : <Typography key={`line-${index}`} sx={{ fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{line}</Typography>)}
            </Box>
            {briefing.empty && <Typography sx={{ mt: 1, fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('空简报不会被推送，除非你在这里手动生成。')}</Typography>}
          </>
        )}
      </Box>

      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', bgcolor: 'background.paper', p: 1.25 }} data-briefing-history>
        <Stack direction="row" alignItems="baseline" spacing={1} sx={{ px: 0.75, mb: 0.5 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 650, flex: 1 }}>{i18n.t('最近 14 份')}</Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('最多保留 {{n}} 份', { n: MAX_BRIEFING_HISTORY })}</Typography>
        </Stack>
        {empty && (
          <Typography sx={{ px: 0.75, py: 1, fontSize: 12, color: 'text.secondary' }}>
            {i18n.t('还没有生成过简报。开启每日简报到点后，每天会在这里留一份，方便回看。')}
          </Typography>
        )}
        {days.map(row => {
          const open = openDay === row.dayKey
          return (
            <Box key={row.dayKey} sx={{ px: 0.75, py: 0.25 }}>
              <Box
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => setOpenDay(open ? null : row.dayKey)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenDay(open ? null : row.dayKey) }
                }}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1, mx: -0.5, px: 0.5, py: 0.75, borderRadius: '8px', cursor: 'pointer',
                  transition: 'background-color 120ms', '&:hover': { bgcolor: 'action.hover' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
                }}
              >
                <Typography sx={{ fontSize: 12.5, fontWeight: 650, flex: '0 0 auto' }}>{formatBriefingDay(row.dayKey, language)}</Typography>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: '0 0 auto' }}>{formatGeneratedAt(row.createdAt, language)}</Typography>
                <Box component="span" aria-hidden sx={{ display: 'grid', placeItems: 'center', width: 16, height: 16, color: 'text.secondary', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}>▾</Box>
              </Box>
              {open && (
                <Box sx={{ mt: 0.5, mb: 0.75, px: 0.5, display: 'flex', flexDirection: 'column', gap: '2px' }} data-briefing-day-body>
                  {bodyLines(row.body).map((line, index) => line === ''
                    ? <Box key={`gap-${index}`} sx={{ height: 6 }} />
                    : <Typography key={`line-${index}`} sx={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'text.secondary' }}>{line}</Typography>)}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
