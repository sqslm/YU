import { useState } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Slider, Stack, Switch, TextField, Typography } from '@mui/material'
import type { SearchConnection, SearchProbeResult, SearchProvider, SearchProviderEntry, SearchSettings, Settings } from '@shared/types'
import {
  SEARCH_PROVIDER_CAVEAT,
  SEARCH_PROVIDER_ENDPOINT_HINT,
  SEARCH_PROVIDER_KEY_HINT,
  SEARCH_PROVIDER_KEY_PLACEHOLDER,
  SEARCH_PROVIDER_LABEL,
  SEARCH_PROVIDER_NEEDS_ENDPOINT,
  SEARCH_PROVIDER_NEEDS_KEY,
  SEARCH_PROVIDERS,
  activeSearchEntry
} from '@shared/searchProviders'
import {
  IconGlobe,
  IconMagnifier,
  IconSliders,
  SettingsField,
  SettingsGroup,
  SettingsHint,
  SettingsRow,
  controlSx,
} from './General'
import i18n from '../../i18n'

interface SectionProps {
  settings: Settings
  patch: (value: Partial<Settings>) => void
}

/**
 * Whether the API-key input is locked for a provider.
 *
 * "Optional" is a validation rule, not a write restriction: an optional
 * provider (SearXNG behind auth) still has to accept typing, otherwise the
 * value can never reach `providers[provider].apiKey`. The earlier build tied
 * this to `SEARCH_PROVIDER_NEEDS_KEY`, so the last provider in the menu became
 * read-only. Keep the rule keyed on *selectability* instead of required-ness;
 * exported so the regression stays testable without a DOM.
 */
export function keyFieldDisabled(provider: SearchProvider): boolean {
  return !SEARCH_PROVIDERS.includes(provider)
}

/** Empty required keys explain themselves in place instead of blocking input. */
export function apiKeyHelperText(provider: SearchProvider, apiKey: string): string | undefined {
  if (!SEARCH_PROVIDER_NEEDS_KEY[provider]) return undefined
  if (apiKey.trim().length > 0) return undefined
  return i18n.t('{{provider}} 需要 API Key，留空时无法检索', { provider: SEARCH_PROVIDER_LABEL[provider] })
}

/**
 * Inline complaint for a backend that cannot answer without an address.
 *
 * Worded for the whole menu, not just SearXNG: Google's Custom Search needs a
 * `cx` in this field too, and it is not an instance address.
 */
export function endpointHelperText(provider: SearchProvider, endpoint: string): string | undefined {
  if (!SEARCH_PROVIDER_NEEDS_ENDPOINT[provider]) return undefined
  if (endpoint.trim().length > 0) return undefined
  return i18n.t('必填：填好这一项后才能检索')
}

export function SearchSection({ settings, patch }: SectionProps): JSX.Element {
  const search = settings.search
  const [editing, setEditing] = useState<SearchConnection | null>(null)
  const [probe, setProbe] = useState<{ id: string; input: string; busy: boolean; result?: SearchProbeResult } | null>(null)
  const probeInput = (connection: SearchConnection): string => JSON.stringify([connection.provider, connection.apiKey, connection.endpoint])
  const testConnection = async (connection: SearchConnection): Promise<void> => {
    if (probe?.busy) return
    const input = probeInput(connection)
    setProbe({ id: connection.id, input, busy: true })
    let result: SearchProbeResult
    try { result = await window.api.net.probeSearch(connection) }
    catch (error) { result = { ok: false, count: 0, durationMs: 0, message: String(error) } }
    setProbe({ id: connection.id, input, busy: false, result })
  }
  const probeStatus = (connection: SearchConnection): JSX.Element | null => {
    if (probe?.id !== connection.id || probe.input !== probeInput(connection)) return null
    const result = probe.result
    return <Typography role="status" data-search-probe-result sx={{ px: 2, pb: 1.5, fontSize: 11.5, overflowWrap: 'anywhere', color: result && !result.ok ? 'error.main' : 'text.secondary' }}>
      {probe.busy ? i18n.t('正在测试连接…') : result?.ok
        ? i18n.t('连接正常 · {{count}} 条结果 · {{ms}} ms', { count: result.count, ms: result.durationMs })
        : i18n.t('测试失败：{{message}}', { message: result?.message })}
    </Typography>
  }

  /**
   * The flat `apiKey`/`endpoint`/`maxResults` fields are a mirror the main
   * process derives from the active provider. Reading them here is exactly what
   * made a switched provider show the previous backend's key, so every control
   * reads the per-provider slot instead.
   */
  const entry = activeSearchEntry(search)
  const singleConnection: SearchConnection = { ...entry, id: 'single', name: '', provider: search.provider, enabled: true }

  // `patch` shallow-merges into the top level of Settings, so the whole `search`
  // object has to travel with every change or sibling keys would be dropped.
  const update = (delta: Partial<SearchSettings>): void =>
    patch({ search: { ...search, ...delta } })

  const connections = search.connections ?? []
  const updateConnection = (id: string, delta: Partial<SearchConnection>): void =>
    update({ connections: connections.map(connection => connection.id === id ? { ...connection, ...delta } : connection) })
  const move = (index: number, direction: number): void => {
    const next = [...connections], target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    update({ connections: next })
  }

  /**
   * Writes only the active provider's slot. Spreading `providers` first keeps
   * every other backend's saved key/endpoint/count byte-identical.
   */
  const updateEntry = (delta: Partial<SearchProviderEntry>): void =>
    update({
      providers: {
        ...search.providers,
        [search.provider]: { ...entry, ...delta }
      }
    })

  const needsKey = SEARCH_PROVIDER_NEEDS_KEY[search.provider]
  const needsEndpoint = SEARCH_PROVIDER_NEEDS_ENDPOINT[search.provider]
  const keyErrorHint = apiKeyHelperText(search.provider, entry.apiKey)
  const endpointErrorHint = endpointHelperText(search.provider, entry.endpoint)
  /**
   * A setup note the fixed fields cannot express — Google's Custom Search also
   * wants a `cx`, which rides inside the address field. Every backend in this
   * menu has a working adapter, so nothing here ever means "this one will
   * silently query something else".
   */
  const providerCaveat = SEARCH_PROVIDER_CAVEAT[search.provider]

  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconGlobe />} title={i18n.t('网页检索')}>
        <SettingsRow
          label={i18n.t('允许联网检索')}
          description={i18n.t('问答会先取回网页摘要，再让模型带着来源回答')}
        >
          <Switch
            size="small"
            checked={search.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup icon={<IconSliders />} title={i18n.t('调用方式')}>
        <SettingsRow label={i18n.t('搜索调用方式')} description={i18n.t('顺序备用节省重复请求；合并来源会查询多个连接并合并结果。')}>
          <TextField select sx={controlSx} value={search.strategy ?? 'single'} data-search-strategy onChange={event => update({ strategy: event.target.value as SearchSettings['strategy'] })}>
            <MenuItem value="single">{i18n.t('单一服务')}</MenuItem>
            <MenuItem value="fallback">{i18n.t('顺序备用')}</MenuItem>
            <MenuItem value="aggregate">{i18n.t('合并来源')}</MenuItem>
          </TextField>
        </SettingsRow>
      </SettingsGroup>

      {search.strategy && search.strategy !== 'single' && <SettingsGroup icon={<IconMagnifier />} title={i18n.t('搜索连接')}>
        {connections.map((connection, index) => <Box key={connection.id} data-search-connection={connection.id} title={connection.name} sx={{ '& p': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }}><SettingsRow label={connection.name} description={SEARCH_PROVIDER_LABEL[connection.provider]}>
          <Switch size="small" checked={connection.enabled} inputProps={{ 'aria-label': i18n.t('启用 {{name}}', { name: connection.name }) }} onChange={(_, enabled) => updateConnection(connection.id, { enabled })} />
          <Button size="small" sx={{ minWidth: 40 }} data-search-test={connection.id} aria-label={i18n.t('测试 {{name}}', { name: connection.name })} disabled={probe?.busy} onClick={() => void testConnection(connection)}>{i18n.t('测试')}</Button>
          <Button size="small" sx={{ minWidth: 40 }} onClick={() => setEditing({ ...connection })}>{i18n.t('编辑')}</Button>
          <Button size="small" sx={{ minWidth: 28 }} aria-label={i18n.t('上移 {{name}}', { name: connection.name })} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
          <Button size="small" sx={{ minWidth: 28 }} aria-label={i18n.t('下移 {{name}}', { name: connection.name })} disabled={index === connections.length - 1} onClick={() => move(index, 1)}>↓</Button>
          <Button size="small" color="error" onClick={() => update({ connections: connections.filter(item => item.id !== connection.id) })}>{i18n.t('删除')}</Button>
        </SettingsRow>{probeStatus(connection)}</Box>)}
        {!connections.length && <SettingsHint>{i18n.t('添加已授权的搜索连接，可保存同一服务的多把密钥。')}</SettingsHint>}
        <Box sx={{ px: 2, py: 1.5 }}><Button variant="outlined" size="small" data-search-add onClick={() => setEditing({ id: crypto.randomUUID(), name: '', provider: 'tavily', apiKey: '', endpoint: '', maxResults: 5, enabled: true })}>{i18n.t('添加搜索连接')}</Button></Box>
        <SettingsHint>{i18n.t('测试会发送一次真实搜索请求，可能计入服务额度；不会切换到备用连接。')}</SettingsHint>
      </SettingsGroup>}

      {(!search.strategy || search.strategy === 'single') && <>
      <SettingsGroup icon={<IconMagnifier />} title={i18n.t('搜索服务')}>
        <SettingsRow label={i18n.t('搜索服务')} description={i18n.t('每个服务商各自保存密钥、地址与结果条数')}>
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={search.provider}
            // Selecting a provider only flips which slot is active; the main
            // process re-derives the flat mirror from that provider's entry.
            onChange={(event) => update({ provider: event.target.value as SearchProvider })}
          >
            {SEARCH_PROVIDERS.map((provider) => (
              <MenuItem key={provider} value={provider}>
                {SEARCH_PROVIDER_LABEL[provider]}
              </MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        {providerCaveat ? (
          <Typography sx={{ px: 2, pb: 1.25, fontSize: 11.5, color: 'text.secondary', lineHeight: 1.5 }}>
            {providerCaveat}
          </Typography>
        ) : null}
        {!keyFieldDisabled(search.provider) && (
          <SettingsRow label={i18n.t('API Key')} description={SEARCH_PROVIDER_KEY_HINT[search.provider]}>
            <TextField
              fullWidth={false}
              sx={controlSx}
              type="password"
              value={entry.apiKey}
              onChange={(event) => updateEntry({ apiKey: event.target.value })}
              placeholder={SEARCH_PROVIDER_KEY_PLACEHOLDER[search.provider]}
              // Optional providers stay editable; a missing *required* key only
              // surfaces as an inline hint, never as a locked input.
              disabled={keyFieldDisabled(search.provider)}
              required={needsKey}
              error={keyErrorHint !== undefined}
              helperText={keyErrorHint}
            />
          </SettingsRow>
        )}
        {search.provider !== 'duckduckgo' && (
          <SettingsField label={i18n.t('自定义地址')} description={SEARCH_PROVIDER_ENDPOINT_HINT[search.provider]}>
            <TextField
              fullWidth
              size="small"
              value={entry.endpoint}
              onChange={(event) => updateEntry({ endpoint: event.target.value })}
              placeholder={
                // Google's Custom Search takes its `cx` here rather than at a host,
                // so the placeholder names the id instead of an instance URL.
                search.provider === 'google-cse'
                  ? i18n.t('cx=… 或 https://www.googleapis.com/customsearch/v1?cx=…')
                  : needsEndpoint
                    ? 'http://127.0.0.1:8080'
                    : i18n.t('留空则用官方地址')
              }
              required={needsEndpoint}
              error={endpointErrorHint !== undefined}
              helperText={endpointErrorHint}
            />
          </SettingsField>
        )}
        <Box sx={{ px: 2, py: 1.5 }}><Button variant="outlined" size="small" data-search-test-single disabled={probe?.busy || !!keyErrorHint || !!endpointErrorHint} onClick={() => void testConnection(singleConnection)}>{i18n.t('测试连接')}</Button></Box>
        {probeStatus(singleConnection)}
        <SettingsHint>{i18n.t('测试会发送一次真实搜索请求，可能计入服务额度；不会切换到备用连接。')}</SettingsHint>
      </SettingsGroup>
      </>}

      <SettingsGroup icon={<IconSliders />} title={i18n.t('结果与判定')}>
        {(!search.strategy || search.strategy === 'single') && <SettingsRow label={i18n.t('单次搜索条数')} description={i18n.t('普通查询每次取回的网页数；新闻汇总会自动分主题扩展，不受此总数限制。')}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: controlSx.width, px: 0.5 }}>
            <Slider
              size="small"
              min={1}
              max={10}
              step={1}
              marks
              value={entry.maxResults}
              valueLabelDisplay="off"
              onChange={(_event, value) => updateEntry({ maxResults: value as number })}
            />
            <Typography
              sx={{
                fontSize: 11.5,
                color: 'text.secondary',
                width: 28,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {entry.maxResults}
            </Typography>
          </Box>
        </SettingsRow>}
        <SettingsRow
          label={i18n.t('先让模型判断是否需要检索')}
          description={i18n.t('关掉后每次提问都会检索；打开则闲聊与写作类问题直接回答，省一次请求')}
        >
          <Switch
            size="small"
            checked={search.decideWithModel}
            onChange={(event) => update({ decideWithModel: event.target.checked })}
          />
        </SettingsRow>
        <SettingsHint>
          {i18n.t('新闻汇总会合并多次检索并去重；来源区显示实际覆盖范围。检索失败会明确标注，不会当作已联网回答。')}
        </SettingsHint>
      </SettingsGroup>
      <Dialog open={editing !== null} onClose={() => setEditing(null)} fullWidth maxWidth="sm">
        <DialogTitle>{i18n.t('搜索连接')}</DialogTitle>
        {editing && <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
          <TextField size="small" label={i18n.t('名称')} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} inputProps={{ maxLength: 80 }} />
          <TextField select size="small" label={i18n.t('搜索服务')} value={editing.provider} onChange={event => setEditing({ ...editing, provider: event.target.value as SearchProvider, apiKey: '', endpoint: '' })}>
            {SEARCH_PROVIDERS.map(provider => <MenuItem key={provider} value={provider}>{SEARCH_PROVIDER_LABEL[provider]}</MenuItem>)}
          </TextField>
          {editing.provider !== 'duckduckgo' && <>
            <TextField size="small" label="API Key" type="password" value={editing.apiKey} autoComplete="off" onChange={event => setEditing({ ...editing, apiKey: event.target.value })} helperText={apiKeyHelperText(editing.provider, editing.apiKey)} />
            <TextField size="small" label={i18n.t('自定义地址')} value={editing.endpoint} onChange={event => setEditing({ ...editing, endpoint: event.target.value })} helperText={SEARCH_PROVIDER_ENDPOINT_HINT[editing.provider]} />
          </>}
          <TextField size="small" label={i18n.t('单次搜索条数')} type="number" inputProps={{ min: 1, max: 10 }} value={editing.maxResults} onChange={event => setEditing({ ...editing, maxResults: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })} />
        </Stack><Box sx={{ mt: 2 }}>{probeStatus(editing)}</Box></DialogContent>}
        <DialogActions><Button onClick={() => setEditing(null)}>{i18n.t('取消')}</Button>
          <Button data-search-test-draft disabled={!editing || probe?.busy || !!apiKeyHelperText(editing.provider, editing.apiKey) || !!endpointHelperText(editing.provider, editing.endpoint)} onClick={() => { if (editing) void testConnection(editing) }}>{i18n.t('测试连接')}</Button>
          <Button variant="contained" disabled={!editing || !!apiKeyHelperText(editing.provider, editing.apiKey) || !!endpointHelperText(editing.provider, editing.endpoint)} onClick={() => {
            if (!editing) return
            const saved = { ...editing, name: editing.name.trim() || SEARCH_PROVIDER_LABEL[editing.provider] }
            update({ connections: connections.some(connection => connection.id === saved.id) ? connections.map(connection => connection.id === saved.id ? saved : connection) : [...connections, saved] })
            setEditing(null)
          }}>{i18n.t('保存')}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
