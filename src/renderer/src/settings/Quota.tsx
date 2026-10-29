import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography, useTheme } from '@mui/material'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import type { Settings } from '@shared/types'
import { defaultQuotaTarget, quotaConnections, quotaKey, quotaRemainingRatio, type QuotaMetric, type QuotaResult, type QuotaTarget } from '@shared/quota'
import i18n from '../i18n'

export function QuotaRing({ result, loading, size = 28 }: { result?: QuotaResult; loading?: boolean; size?: number }): JSX.Element {
  const dark = useTheme().palette.mode === 'dark', ratio = quotaRemainingRatio(result)
  const track = dark ? '#101010' : '#d9dce1', remaining = dark ? '#ffffff' : '#242832'
  return <Box sx={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="14" fill="none" stroke={track} strokeWidth="4" />
      {ratio !== undefined && <circle data-quota-remaining cx="18" cy="18" r="14" fill="none" stroke={remaining} strokeWidth="4" pathLength="100" strokeDasharray={`${ratio * 100} 100`} transform="rotate(-90 18 18)" />}
    </svg>
    {loading ? <CircularProgress size={size - 6} thickness={2} sx={{ color: remaining, position: 'absolute', top: 3, left: 3 }} /> : ratio === undefined && <Typography component="span" aria-hidden sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 11, color: remaining }}>—</Typography>}
  </Box>
}

const display = (value: number, unit: string): string => ['CNY', 'USD'].includes(unit)
  ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency: unit, maximumFractionDigits: 6 }).format(value)
  : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(value)}${unit === 'characters' ? ` ${i18n.t('字符额度')}` : ` ${unit}`}`
const headline = (metric: QuotaMetric): string => metric.remaining !== undefined ? display(metric.remaining, metric.unit) : metric.used !== undefined ? display(metric.used, metric.unit) : '—'

interface QuotaContextValue { open(target?: QuotaTarget): void; selected?: QuotaTarget; result?: QuotaResult; loading: boolean; name: string }
const QuotaContext = createContext<QuotaContextValue | null>(null)

/** All queries use saved connection IDs. No keys, balances or billing payloads are persisted by this UI. */
export function QuotaProvider({ settings, saving, children }: { settings: Settings | null; saving: boolean; children: ReactNode }): JSX.Element {
  const connections = settings ? quotaConnections(settings) : []
  const [chosen, setChosen] = useState<QuotaTarget>(), [opened, setOpened] = useState(false), [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Record<string, QuotaResult>>({}), [loading, setLoading] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState('')
  const selected = connections.find(row => chosen && quotaKey(row) === quotaKey(chosen)) ?? (settings ? defaultQuotaTarget(settings) : undefined)
  const selectedKey = selected ? quotaKey(selected) : ''
  const generation = useRef(0), busyRef = useRef(false), openedRef = useRef(false)
  openedRef.current = opened
  // Credential changes invalidate displayed data too, not only the main-process cache.
  const revision = JSON.stringify([settings?.profiles, settings?.tts])
  const query = async (target: QuotaTarget, token: number): Promise<void> => {
    const key = quotaKey(target)
    setLoading(value => ({ ...value, [key]: true }))
    try {
      const result = await window.api.quota.query({ kind: target.kind, id: target.id })
      if (token === generation.current) setResults(value => ({ ...value, [key]: result }))
    } catch {
      if (token === generation.current) setResults(value => ({ ...value, [key]: { status: 'error', scope: 'none', message: '额度查询失败，请稍后重试', metrics: [], checkedAt: Date.now() } }))
    } finally { if (token === generation.current) setLoading(value => ({ ...value, [key]: false })) }
  }
  const batch = async (refresh: boolean): Promise<void> => {
    if (busyRef.current || saving || document.hidden) return
    busyRef.current = true; setBusy(true); setNotice('')
    const token = generation.current
    try {
      if (refresh) await window.api.quota.refresh()
      const ordered = [...connections].sort((a, b) => Number(quotaKey(b) === selectedKey) - Number(quotaKey(a) === selectedKey))
      let next = 0
      const worker = async (): Promise<void> => {
        while (token === generation.current && openedRef.current && !document.hidden && next < ordered.length) await query(ordered[next++], token)
      }
      await Promise.all([worker(), worker()])
    } catch { if (token === generation.current) setNotice('额度查询失败，请稍后重试') }
    finally { if (token === generation.current) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => {
    generation.current++; busyRef.current = false; setBusy(false); setResults({}); setLoading({})
    return () => { generation.current++ }
  }, [revision])
  useEffect(() => {
    if (saving) return
    if (opened) void batch(false)
    else if (selected && !document.hidden && !busyRef.current) void query(selected, generation.current)
  }, [opened, saving, revision, selectedKey])
  useEffect(() => {
    const visible = (): void => { if (!document.hidden && !saving) { if (opened) void batch(false); else if (selected && !busyRef.current) void query(selected, generation.current) } }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [opened, saving, revision, selectedKey])
  const result = results[selectedKey]
  return <QuotaContext.Provider value={{ open: target => { if (target) setChosen(target); setOpened(true) }, selected, result, loading: Boolean(loading[selectedKey]), name: connections.find(row => quotaKey(row) === selectedKey)?.name ?? '' }}>
    {children}
    <Dialog open={opened} onClose={() => setOpened(false)} fullWidth maxWidth="sm" aria-labelledby="quota-title">
      <DialogTitle id="quota-title">{i18n.t('模型额度')}<Typography sx={{ mt: 0.5, fontSize: 12, color: 'text.secondary' }}>{i18n.t('所有已保存的模型连接；共享余额不会重复相加。')}</Typography></DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {saving && <Alert severity="info">{i18n.t('配置尚未保存，保存后查询。')}</Alert>}
        {notice && <Alert severity="error">{i18n.t(notice)}</Alert>}
        {!connections.length && <Typography sx={{ p: 3, color: 'text.secondary' }}>{i18n.t('尚未添加模型连接，请先在模型设置中配置。')}</Typography>}
        {connections.map(connection => {
          const key = quotaKey(connection), row = results[key], checking = loading[key], ratio = quotaRemainingRatio(row)
          return <Box key={key} data-quota-row={key} sx={{ p: 2.5, borderBottom: 1, borderColor: 'divider', bgcolor: key === selectedKey ? 'action.selected' : undefined }}>
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <QuotaRing result={row} loading={checking} size={36} />
              <Box sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{connection.kind === 'local-asr' ? i18n.t(connection.name) : connection.name || i18n.t('未命名连接')}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary', overflowWrap: 'anywhere' }}>{connection.kind === 'multimodal' ? i18n.t('音频直达') : connection.kind === 'local-asr' ? i18n.t('本地 ASR') : connection.kind.toUpperCase()} · {connection.model || i18n.t(connection.kind === 'tts' ? '系统声音' : '未选模型')}{!connection.enabled ? ` · ${i18n.t('未启用')}` : ''}</Typography></Box>
              <Button size="small" disabled={key === selectedKey} onClick={() => setChosen(connection)}>{i18n.t(key === selectedKey ? '圆环当前显示' : '在圆环显示')}</Button>
            </Stack>
            <Box sx={{ pl: '48px', mt: 1.25 }}>
              {checking && <Typography role="status" sx={{ fontSize: 12, color: 'text.secondary' }}>{i18n.t('正在查询额度…')}</Typography>}
              {row?.metrics.map((metric, i) => <Box key={i} sx={{ mb: 0.75 }}><Typography sx={{ fontSize: 20, fontWeight: 600 }}>{headline(metric)}</Typography><Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{i18n.t(metric.label)}{metric.total !== undefined ? ` / ${display(metric.total, metric.unit)}` : ''}{metric.used !== undefined && metric.remaining !== undefined ? ` · ${i18n.t('已用')} ${display(metric.used, metric.unit)}` : ''}{ratio !== undefined ? ` · ${i18n.t('剩余')} ${Math.round(ratio * 100)}%` : ''}</Typography>{metric.resetsAt && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{i18n.t('下次重置')} · {new Date(metric.resetsAt).toLocaleString(i18n.language)}</Typography>}</Box>)}
              <Typography sx={{ fontSize: 11.5, color: row?.status === 'error' ? 'error.main' : 'text.secondary', lineHeight: 1.7 }}>{row ? i18n.t(row.message) : !checking ? i18n.t('等待查询') : ''}</Typography>
              {row?.status === 'ok' && ratio === undefined && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{i18n.t('缺少可计算的总额度，暂不显示比例。')}</Typography>}
              {row && <Stack direction="row" useFlexGap spacing={1.5} sx={{ flexWrap: 'wrap', mt: 0.5, alignItems: 'center' }}><Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>{i18n.t('查询时间')} · {new Date(row.checkedAt).toLocaleTimeString(i18n.language)}</Typography>{row.consoleUrl && <Button size="small" component="a" href={row.consoleUrl} target="_blank" rel="noopener noreferrer" sx={{ p: 0, minWidth: 0, fontSize: 11 }}>{i18n.t('前往提供商控制台')}</Button>}</Stack>}
            </Box>
          </Box>
        })}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}><Typography sx={{ mr: 'auto', fontSize: 11, color: 'text.secondary' }}>{i18n.t('按需查询，结果缓存 5 分钟。')}</Typography><Button startIcon={<RefreshRounded />} onClick={() => void batch(true)} disabled={busy || saving || !connections.length}>{i18n.t(busy ? '正在查询…' : '刷新额度')}</Button><Button onClick={() => setOpened(false)}>{i18n.t('关闭')}</Button></DialogActions>
    </Dialog>
  </QuotaContext.Provider>
}

export function QuotaSidebar(): JSX.Element | null {
  const quota = useContext(QuotaContext)
  if (!quota) return null
  const ratio = quotaRemainingRatio(quota.result)
  const title = [i18n.t('查看所有模型额度'), quota.name, quota.result?.metrics.map(headline).join(' / '), ratio !== undefined ? `${Math.round(ratio * 100)}%` : '', quota.result ? i18n.t(quota.result.message) : ''].filter(Boolean).join(' · ')
  return <Tooltip title={title}><IconButton data-quota-entry aria-label={i18n.t('查看所有模型额度')} onClick={() => quota.open()} sx={{ ml: 'auto', p: 0.5, flexShrink: 0 }}><QuotaRing result={quota.result} loading={quota.loading} /></IconButton></Tooltip>
}
export function QuotaButton({ target, disabled }: { target: QuotaTarget; disabled?: boolean }): JSX.Element | null {
  const quota = useContext(QuotaContext)
  return quota ? <Button size="small" variant="outlined" disabled={disabled} onClick={() => quota.open(target)}>{i18n.t('查询额度')}</Button> : null
}
