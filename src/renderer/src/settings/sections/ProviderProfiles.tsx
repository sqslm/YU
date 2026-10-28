import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, Autocomplete, Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, Link, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import DragIndicator from '@mui/icons-material/DragIndicator'
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined'
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import DeleteOutline from '@mui/icons-material/DeleteOutline'
import type { ProviderKind, ProviderProfile, Settings } from '@shared/types'
import { MAX_PROFILES } from '@shared/defaults'
import { CUSTOM_PRESET_ID, findPreset, presetsFor, presetDraft, providerLinks, type ProviderPreset } from '@shared/providerPresets'
import { defaultVendorValues, missingVendorFields, presetVendorFields } from '@shared/providerFields'
import { moveProfile, newProfileId, uniqueProfileName, profilesOf, removeProfile, setProfileEnabled, upsertProfile } from '@shared/profiles'
import { isSameOrder, reorderIds } from './providerProfilesView'
import { SettingsNumber } from './General'
import { ModelAvatar, ModelWorkspace, modelFieldSx, modelSelectedBackground } from './ModelWorkspace'
import i18n from '../../i18n'

const KIND_USE: Record<ProviderKind, string> = { asr: '语音识别', llm: '文本处理', multimodal: '音频直达' }
type Patch = (delta: Partial<Settings>) => void

function ProviderInfo({ preset }: { preset?: ProviderPreset }): JSX.Element | null {
  const links = preset ? providerLinks(preset) : null
  if (!links) return null
  return <Stack direction="row" useFlexGap spacing={1.5} data-provider-links sx={{ flexWrap: 'wrap', fontSize: 11.5 }}>
    <Link href={links.website} target="_blank" rel="noopener noreferrer" data-provider-website>{i18n.t('官网 / 开发者平台')}</Link>
    {links.docs && <Link href={links.docs} target="_blank" rel="noopener noreferrer" data-provider-docs>{i18n.t('官方文档')}</Link>}
    {(links.key || !links.local && links.docs) && <Link href={links.key || links.docs} target="_blank" rel="noopener noreferrer" data-provider-key>{i18n.t(links.key ? '申请 API Key' : 'API Key 使用指南')}</Link>}
  </Stack>
}

/** The same connection fields are used for creation and for a saved connection. */
function ProfileFields({ profile, onChange, children }: { profile: ProviderProfile; onChange: (next: ProviderProfile) => void; children?: ReactNode }): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const request = useRef(0)
  const preset = profile.preset ? findPreset(profile.preset, profile.kind) : undefined
  const fields = presetVendorFields(profile.preset)
  useEffect(() => {
    request.current++; setModels([]); setNotice(null); setLoading(false)
    return () => { request.current++ }
  }, [profile.id, profile.baseUrl, profile.apiKey, profile.extraHeaders, profile.preset])
  const options = [...new Set([...models, ...(preset?.models ?? []), ...(profile.model ? [profile.model] : [])])]
  const fetchModels = async (): Promise<void> => {
    const token = ++request.current
    setLoading(true); setNotice(null)
    try {
      const result = await window.api.models.list({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, extraHeaders: profile.extraHeaders, refresh: true })
      if (token !== request.current) return
      setModels(result.models.map(model => model.id))
      setNotice({ error: Boolean(result.error), text: result.error || i18n.t('已获取 {{n}} 个模型，可选择或手动输入。', { n: result.models.length }) })
    } catch (error) {
      if (token === request.current) setNotice({ error: true, text: error instanceof Error ? error.message : String(error) })
    } finally { if (token === request.current) setLoading(false) }
  }
  const vendorField = (field: typeof fields[number]): JSX.Element => <TextField key={field.key} fullWidth size="small" label={field.label} required={field.required} value={profile.vendor?.[field.key] ?? ''}
    placeholder={field.placeholder} helperText={field.hint} error={field.required && !profile.vendor?.[field.key]?.trim()} sx={modelFieldSx}
    inputProps={{ 'data-vendor-field': field.key }} onChange={event => onChange({ ...profile, vendor: { ...profile.vendor, [field.key]: event.target.value } })} />
  return <Stack spacing={2}>
    <TextField fullWidth size="small" label={i18n.t('连接名称')} value={profile.name} sx={modelFieldSx} onChange={event => onChange({ ...profile, name: event.target.value })} />
    <TextField fullWidth size="small" label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" value={profile.apiKey} sx={modelFieldSx}
      placeholder={i18n.t('本机服务可留空')} onChange={event => onChange({ ...profile, apiKey: event.target.value })}
      InputProps={{ endAdornment: <InputAdornment position="end"><IconButton size="small" aria-label={i18n.t(showKey ? '隐藏密钥' : '显示密钥')} onClick={() => setShowKey(value => !value)}>{showKey ? <VisibilityOffOutlined sx={{ fontSize: 17 }} /> : <VisibilityOutlined sx={{ fontSize: 17 }} />}</IconButton></InputAdornment> }} />
    <TextField fullWidth size="small" label={i18n.t('接口地址')} value={profile.baseUrl} placeholder="https://api.example.com/v1" sx={modelFieldSx}
      onChange={event => onChange({ ...profile, baseUrl: event.target.value })} />
    <Box>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Autocomplete freeSolo fullWidth options={options} inputValue={profile.model} value={profile.model || null}
          onInputChange={(_event, value, reason) => { if (reason === 'input' || reason === 'clear') onChange({ ...profile, model: value }) }}
          onChange={(_event, value) => onChange({ ...profile, model: value ?? '' })}
          renderInput={params => <TextField {...params} size="small" label={i18n.t('模型 ID')} sx={modelFieldSx} />} />
        {(!preset || preset.protocol === 'openai') && <Button variant="outlined" size="small" sx={{ flexShrink: 0, minHeight: 40, px: 1.25 }} disabled={loading || !profile.baseUrl.trim()} onClick={() => void fetchModels()}>{i18n.t(loading ? '获取中…' : '获取模型')}</Button>}
      </Stack>
      {notice && <Typography role="status" sx={{ mt: 0.75, fontSize: 11.5, color: notice.error ? 'error.main' : 'text.secondary', overflowWrap: 'anywhere' }}>{notice.text}</Typography>}
    </Box>
    {fields.filter(field => field.required).map(vendorField)}
    <ProviderInfo preset={preset} />
    {children}
    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}>
      <Button color="inherit" size="small" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced} endIcon={<ExpandMoreRounded sx={{ transform: advanced ? 'rotate(180deg)' : 'none' }} />} sx={{ color: 'text.secondary', px: 0 }}>{i18n.t('高级设置')}</Button>
      {advanced && <Stack spacing={2} sx={{ pt: 1.5 }}>
        {profile.kind !== 'asr' && <TextField fullWidth size="small" label={i18n.t('请求路径（可选）')} value={profile.requestPath ?? ''} placeholder="chat/completions" sx={modelFieldSx} onChange={event => onChange({ ...profile, requestPath: event.target.value })} />}
        <TextField fullWidth size="small" multiline minRows={2} label={i18n.t('额外请求头')} helperText={i18n.t('每行一个 Name: Value，一般留空')} value={profile.extraHeaders ?? ''} sx={modelFieldSx} onChange={event => onChange({ ...profile, extraHeaders: event.target.value })} />
        {fields.filter(field => !field.required).map(vendorField)}
        {preset?.notes && <Typography sx={{ fontSize: 11.5, lineHeight: 1.65, color: 'text.secondary' }}>{preset.notes}</Typography>}
      </Stack>}
    </Box>
  </Stack>
}

function ProfileEditor({ profile, settings, patch, saving, saveError, onRemove }: { profile: ProviderProfile; settings: Settings; patch: Patch; saving: boolean; saveError: string; onRemove: () => void }): JSX.Element {
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text: string }>({ busy: false, text: '' })
  const request = useRef(0)
  useEffect(() => {
    request.current++; setTest({ busy: false, text: '' })
    return () => { request.current++ }
  }, [profile.id, profile.baseUrl, profile.apiKey, profile.model, profile.extraHeaders])
  const list = profilesOf(settings, profile.kind)
  const primary = list.find(item => item.enabled)?.id === profile.id
  const index = list.findIndex(item => item.id === profile.id)
  const apply = (next: Settings): void => patch({ profiles: next.profiles, chains: next.chains })
  const runTest = async (): Promise<void> => {
    const token = ++request.current
    setTest({ busy: true, text: '' })
    try {
      const result = profile.kind === 'multimodal'
        ? await window.api.net.probeMultimodal({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, extraHeaders: profile.extraHeaders })
        : await window.api.net.probe({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, extraHeaders: profile.extraHeaders })
      if (token !== request.current) return
      setTest({ busy: false, ok: result.ok, text: result.ok ? result.status ? i18n.t('连接正常 · HTTP {{status}}', { status: result.status }) : i18n.t('连接正常') : result.message })
    } catch (error) { if (token === request.current) setTest({ busy: false, ok: false, text: error instanceof Error ? error.message : String(error) }) }
  }
  const makePrimary = (): void => {
    const enabled = setProfileEnabled(settings, profile.id, true)
    patch({ profiles: enabled.profiles, chains: { ...settings.chains, [profile.kind]: [profile.id, ...list.filter(item => item.id !== profile.id).map(item => item.id)] } })
  }
  return <Box data-profile-editor={profile.id}>
    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <ModelAvatar name={profile.name} active />
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 16, fontWeight: 600 }} noWrap>{profile.name || i18n.t('未命名连接')}</Typography><Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25 }}>{i18n.t(KIND_USE[profile.kind])} · {i18n.t(!profile.enabled ? '未启用' : primary ? '首选连接' : '备用连接')}</Typography></Box>
      <Typography component="span" sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('启用')}</Typography>
      <Switch size="small" checked={profile.enabled} inputProps={{ 'aria-label': i18n.t('{{name}} 启用', { name: profile.name }) }} onChange={event => apply(setProfileEnabled(settings, profile.id, event.target.checked))} />
    </Stack>
    <Box sx={{ p: 2.25 }}>
      <ProfileFields key={profile.id} profile={profile} onChange={next => apply(upsertProfile(settings, next))}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button size="small" variant="contained" disableElevation disabled={test.busy || saving || Boolean(saveError) || !profile.baseUrl.trim()} onClick={() => void runTest()}>{i18n.t(test.busy ? '测试中…' : '测试连接')}</Button>
        <Button size="small" variant="outlined" disabled={primary} onClick={makePrimary}>{i18n.t('设为首选')}</Button>
      </Stack>
      {test.text && <Alert severity={test.ok ? 'success' : 'error'} data-profile-test-result={profile.id} sx={{ mt: 1.5, fontSize: 12, overflowWrap: 'anywhere' }}>{test.text}</Alert>}
      </ProfileFields>
      {profile.kind === 'multimodal' && <Box sx={{ mt: 2.25, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between"><Typography sx={{ fontSize: 12 }}>{i18n.t('音频时长上限')}</Typography><SettingsNumber label={i18n.t('音频时长上限')} value={settings.multimodal.maxSeconds} min={5} max={600} onChange={maxSeconds => patch({ multimodal: { ...settings.multimodal, maxSeconds } })} /></Stack>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>{i18n.t('直接理解录音并生成结果，供音频直达使用。')}</Typography>
      </Box>}
    </Box>
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ px: 2, py: 1.25, borderTop: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
      <Button size="small" color="inherit" disabled={index === 0} data-profile-move-up={profile.id} onClick={() => apply(moveProfile(settings, profile.id, -1))}>{i18n.t('上移')}</Button>
      <Button size="small" color="inherit" disabled={index === list.length - 1} data-profile-move-down={profile.id} onClick={() => apply(moveProfile(settings, profile.id, 1))}>{i18n.t('下移')}</Button>
      <Button size="small" color="error" startIcon={<DeleteOutline sx={{ fontSize: 16 }} />} data-profile-remove={profile.id} sx={{ ml: 'auto !important' }} onClick={onRemove}>{i18n.t('删除连接')}</Button>
    </Stack>
  </Box>
}

/** Master/detail navigation retains existing profile IDs, credentials and chain order. */
export function ProviderProfiles({ kind, settings, patch, saving, saveError, localModel }: { kind: 'asr' | 'llm'; settings: Settings; patch: Patch; saving: boolean; saveError: string; localModel?: ReactNode }): JSX.Element {
  const kinds: ProviderKind[] = kind === 'llm' ? ['llm', 'multimodal'] : ['asr']
  const list = kinds.flatMap(item => profilesOf(settings, item))
  const [selectedId, setSelectedId] = useState<string | null>(kind === 'asr' && settings.localAsr.enabled ? 'local' : list[0]?.id ?? null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ProviderProfile | null>(null)
  const [drag, setDrag] = useState<{ id: string; over: string; after: boolean } | null>(null)
  const selected = selectedId === 'local' && localModel ? undefined : list.find(profile => profile.id === selectedId) ?? list[0]
  const activeId = selectedId === 'local' && localModel ? 'local' : selected?.id
  const addingPresets = useMemo(() => presetsFor(draft?.kind ?? kind), [draft?.kind, kind])
  const draftPreset = draft?.preset ? findPreset(draft.preset, draft.kind) : undefined
  const full = (settings.profiles ?? []).length >= MAX_PROFILES
  const apply = (next: Settings): void => patch({ profiles: next.profiles, chains: next.chains })
  const openAdd = (type: ProviderKind = kind): void => setDraft({ id: 'new', kind: type, name: '', preset: '', baseUrl: '', apiKey: '', model: '', enabled: true })
  const choosePreset = (preset: ProviderPreset | null): void => {
    if (!draft || !preset) return
    const values = presetDraft(preset)
    setDraft({ ...draft, ...values, name: !draft.name || draft.name === draftPreset?.name ? preset.name : draft.name, preset: preset.id === CUSTOM_PRESET_ID ? '' : preset.id,
      apiKey: draft.preset === (preset.id === CUSTOM_PRESET_ID ? '' : preset.id) ? draft.apiKey : '', extraHeaders: values.extraHeaders ?? '', authHeader: values.authHeader, requestPath: values.requestPath ?? '', asrAdapter: preset.asrAdapter, vendor: defaultVendorValues(preset.id) })
  }
  const submit = (): void => {
    if (!draft) return
    const profile = { ...draft, id: newProfileId(draft.kind, settings.profiles ?? []), name: uniqueProfileName(draft.name.trim() || draftPreset?.name || i18n.t('我的服务'), settings.profiles ?? []), baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim() }
    apply(upsertProfile(settings, profile)); setQuery(''); setSelectedId(profile.id); setDraft(null)
  }
  const remove = (): void => {
    if (!selected) return
    const next = removeProfile(settings, selected.id)
    apply(next); setSelectedId(kinds.flatMap(item => profilesOf(next, item))[0]?.id ?? null)
  }
  const sidebar = <>
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{i18n.t('我的连接')}</Typography><Button size="small" startIcon={<AddRounded sx={{ fontSize: 16 }} />} disabled={full} data-profile-add={kind} onClick={() => openAdd()} sx={{ minWidth: 0, px: 0.5 }}>{i18n.t('添加')}</Button>
    </Stack>
    <Box sx={{ px: 1.25, pb: 1.25 }}><TextField fullWidth size="small" value={query} placeholder={i18n.t('搜索连接')} inputProps={{ 'aria-label': i18n.t('搜索连接') }} onChange={event => setQuery(event.target.value)} sx={modelFieldSx}
      InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded sx={{ fontSize: 16 }} /></InputAdornment> }} /></Box>
    <Box data-profile-list={kind} sx={{ maxHeight: { xs: 230, md: 470 }, overflowY: 'auto', px: 0.75, pb: 0.75 }}>
      {kinds.map(type => {
        const group = profilesOf(settings, type)
        const shown = group.filter(profile => `${profile.name} ${profile.model} ${profile.preset}`.toLowerCase().includes(query.trim().toLowerCase()))
        const primary = group.find(profile => profile.enabled)?.id
        if (query.trim() && !shown.length) return null
        return <Box key={type}>
          {kind === 'llm' && <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 0.75, pt: 0.75, pb: 0.5 }}><Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{i18n.t(KIND_USE[type])}</Typography>{type === 'multimodal' && <IconButton size="small" disabled={full} aria-label={i18n.t('添加音频直达连接')} onClick={() => openAdd('multimodal')}><AddRounded sx={{ fontSize: 15 }} /></IconButton>}</Stack>}
          {shown.map(profile => <Box key={profile.id} data-profile-row={profile.id}
            onDragOver={event => { if (!drag || list.find(item => item.id === drag.id)?.kind !== type || drag.id === profile.id) return; event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); setDrag({ ...drag, over: profile.id, after: event.clientY > bounds.top + bounds.height / 2 }) }}
            onDrop={event => { event.preventDefault(); if (drag && list.find(item => item.id === drag.id)?.kind === type) { const order = group.map(item => item.id); const next = reorderIds(order, drag.id, profile.id, drag.after); if (!isSameOrder(order, next)) patch({ chains: { ...settings.chains, [type]: next } }) }; setDrag(null) }}
            sx={{ position: 'relative', borderTop: '2px solid transparent', borderBottom: '2px solid transparent', ...(drag?.over === profile.id && drag.id !== profile.id ? drag.after ? { borderBottomColor: 'primary.main' } : { borderTopColor: 'primary.main' } : {}), opacity: drag?.id === profile.id ? 0.5 : 1 }}>
            <ButtonBase data-profile-toggle={profile.id} aria-pressed={activeId === profile.id} onClick={() => setSelectedId(profile.id)} sx={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start', gap: 1, p: 1, borderRadius: '7px', bgcolor: activeId === profile.id ? modelSelectedBackground : 'transparent', border: 1, borderColor: activeId === profile.id ? 'primary.main' : 'transparent', '&:hover': { bgcolor: activeId === profile.id ? modelSelectedBackground : 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
              <ModelAvatar name={profile.name} active={activeId === profile.id} />
              <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 13, fontWeight: 500, color: profile.enabled ? 'text.primary' : 'text.secondary' }} noWrap>{profile.name}</Typography><Typography sx={{ fontSize: 11.5, mt: 0.25, color: 'text.secondary' }} noWrap>{profile.enabled ? primary === profile.id ? i18n.t('首选') : i18n.t('备用') : i18n.t('未启用')} · {profile.model || i18n.t('未选模型')}</Typography></Box>
              <Box component="span" data-profile-drag={profile.id} draggable={!query} onClick={event => event.stopPropagation()} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-typeless-profile', profile.id); setDrag({ id: profile.id, over: profile.id, after: false }) }} onDragEnd={() => setDrag(null)} title={i18n.t('拖动调整顺序')} sx={{ display: 'flex', cursor: 'grab', color: 'text.disabled' }}><DragIndicator sx={{ fontSize: 14 }} /></Box>
            </ButtonBase>
          </Box>)}
        </Box>
      })}
      {!list.some(profile => `${profile.name} ${profile.model} ${profile.preset}`.toLowerCase().includes(query.trim().toLowerCase())) && <Typography sx={{ px: 1, py: 2, color: 'text.secondary', fontSize: 11.5 }}>{i18n.t(list.length ? '没有匹配的连接' : '暂无云端连接')}</Typography>}
    </Box>
    {localModel && <Box sx={{ mx: 1.25, py: 1.25, borderTop: 1, borderColor: 'divider' }}><ButtonBase onClick={() => setSelectedId('local')} data-model-local-select aria-pressed={activeId === 'local'} sx={{ width: '100%', p: 1, borderRadius: '7px', textAlign: 'left', justifyContent: 'flex-start', bgcolor: activeId === 'local' ? modelSelectedBackground : 'transparent' }}><Box><Typography sx={{ fontSize: 12, fontWeight: 500 }}>{i18n.t('本地语音识别')}</Typography><Typography sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.25 }}>{i18n.t(settings.localAsr.enabled ? '本地优先，云端备用' : '离线使用，无需 API Key')}</Typography></Box></ButtonBase></Box>}
    <Typography sx={{ p: 1.5, fontSize: 10.5, color: 'text.secondary', lineHeight: 1.65, borderTop: 1, borderColor: 'divider' }}>{i18n.t('启用的连接按顺序调用，失败后使用下一条。')}</Typography>
  </>
  return <>
    <ModelWorkspace sidebar={sidebar}>
      {activeId === 'local' ? <Box data-model-local sx={{ '& > div': { border: 0, borderRadius: 0 } }}>{localModel}</Box> : selected ?
        <ProfileEditor key={selected.id} profile={selected} settings={settings} patch={patch} saving={saving} saveError={saveError} onRemove={remove} /> :
        <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ minHeight: 438, p: 3, textAlign: 'center' }}><Typography sx={{ fontSize: 16, fontWeight: 600 }}>{i18n.t('添加你的第一个模型连接')}</Typography><Typography sx={{ fontSize: 12, lineHeight: 1.8, color: 'text.secondary', maxWidth: 280 }}>{i18n.t('选择提供商，填写密钥和模型，即可开始使用。')}</Typography><Button variant="contained" size="small" disableElevation disabled={full} onClick={() => openAdd()}>{i18n.t('添加连接')}</Button>{localModel && <Button size="small" onClick={() => setSelectedId('local')}>{i18n.t('使用本地识别')}</Button>}</Stack>}
    </ModelWorkspace>
    <Dialog open={Boolean(draft)} onClose={() => setDraft(null)} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 17 }}>{i18n.t('添加模型连接')}</DialogTitle>
      {draft && <DialogContent><Stack spacing={2.5} sx={{ pt: 1 }}>
        {kind === 'llm' && <TextField select size="small" label={i18n.t('模型用途')} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as ProviderKind, preset: '', asrAdapter: undefined, vendor: {} })}><MenuItem value="llm">{i18n.t('文本处理')}</MenuItem><MenuItem value="multimodal">{i18n.t('音频直达')}</MenuItem></TextField>}
        <Autocomplete disableClearable options={addingPresets} value={addingPresets.find(preset => preset.id === (draft.preset || CUSTOM_PRESET_ID)) ?? addingPresets[0]} getOptionLabel={preset => preset.name} isOptionEqualToValue={(option, value) => option.id === value.id} onChange={(_event, preset) => choosePreset(preset)} renderInput={params => <TextField {...params} size="small" label={i18n.t('提供商模板')} />} />
        <ProfileFields key={draft.kind} profile={draft} onChange={setDraft} />
      </Stack></DialogContent>}
      <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setDraft(null)}>{i18n.t('取消')}</Button><Button variant="contained" disableElevation data-profile-submit={draft?.kind} onClick={submit} disabled={!draft?.baseUrl.trim() || !draft.model.trim() || full || missingVendorFields(draft?.preset, draft?.vendor).length > 0}>{i18n.t('添加连接')}</Button></DialogActions>
    </Dialog>
  </>
}
