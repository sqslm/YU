import { Box, Chip, MenuItem, Slider, Stack, Switch, TextField, Typography } from '@mui/material'
import type { SearchProvider, SearchProviderEntry, SearchSettings, Settings } from '@shared/types'
import {
  SEARCH_PROVIDER_CAVEAT,
  SEARCH_PROVIDER_ENDPOINT_HINT,
  SEARCH_PROVIDER_HINT,
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
  wideControlSx
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

  /**
   * The flat `apiKey`/`endpoint`/`maxResults` fields are a mirror the main
   * process derives from the active provider. Reading them here is exactly what
   * made a switched provider show the previous backend's key, so every control
   * reads the per-provider slot instead.
   */
  const entry = activeSearchEntry(search)

  // `patch` shallow-merges into the top level of Settings, so the whole `search`
  // object has to travel with every change or sibling keys would be dropped.
  const update = (delta: Partial<SearchSettings>): void =>
    patch({ search: { ...search, ...delta } })

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
    <Stack spacing={2.5}>
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

      <SettingsGroup icon={<IconMagnifier />} title={i18n.t('搜索服务')}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, px: 2, py: 1.25 }}>
          <Typography sx={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'text.secondary', lineHeight: 1.5 }}>
            {SEARCH_PROVIDER_HINT[search.provider]}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={i18n.t('当前：{{name}}', { name: SEARCH_PROVIDER_LABEL[search.provider] })}
            sx={{
              flex: '0 0 auto',
              height: 22,
              fontSize: 11,
              color: 'text.secondary',
              borderColor: 'divider',
              bgcolor: 'action.hover',
              '& .MuiChip-label': { px: 1 }
            }}
          />
        </Box>
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
        <SettingsField label={i18n.t('自定义地址')} description={SEARCH_PROVIDER_ENDPOINT_HINT[search.provider]}>
          <TextField
            fullWidth={needsEndpoint}
            size="small"
            sx={needsEndpoint ? undefined : wideControlSx}
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
            // Tavily/Brave may legitimately leave it empty (= official host), so
            // only DuckDuckGo, which has no configurable host, is locked.
            disabled={search.provider === 'duckduckgo'}
            required={needsEndpoint}
            error={endpointErrorHint !== undefined}
            helperText={endpointErrorHint}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup icon={<IconSliders />} title={i18n.t('结果与判定')}>
        <SettingsRow label={i18n.t('结果条数')} description={i18n.t('每次检索最多取回的网页数量，按服务商分别保存')}>
          {/*
            The extra top padding is for the Slider's own value label: it floats
            26px above the track, and without room the bubble straddles the card's
            top edge (it used to be clipped outright). Padding inside this column
            moves the track down without moving the card.
          */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: 240, pt: 2.5 }}>
            <Slider
              size="small"
              min={1}
              max={10}
              step={1}
              marks
              value={entry.maxResults}
              valueLabelDisplay="auto"
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
        </SettingsRow>
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
          {i18n.t('检索结果会作为来源附在回答后面；断网或服务不可用时会自动退回到纯模型回答。')}
        </SettingsHint>
      </SettingsGroup>
    </Stack>
  )
}
