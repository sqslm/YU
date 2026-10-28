import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, ButtonBase, IconButton, InputAdornment, MenuItem, Stack, Switch, TextField, Typography, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material'
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined'
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined'
import VolumeUpOutlined from '@mui/icons-material/VolumeUpOutlined'
import { TTS_PRESETS, ttsProfiles, normalizeTtsSettings, patchTtsSettings, type TtsProvider } from '@shared/speech'
import type { Settings } from '@shared/types'
import { SettingsNumber } from './General'
import { ModelAvatar, ModelWorkspace, modelFieldSx, modelSelectedBackground } from './ModelWorkspace'
import i18n from '../../i18n'
import { registerGameModePreparation } from '../gameModePreparation'

export function ReadAloudSection({ settings, patch, saving, saveError }: { settings: Settings; patch: (delta: Partial<Settings>) => void; saving: boolean; saveError: string }): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const alive = useRef(true)
  const [adding, setAdding] = useState(false)
  const [template, setTemplate] = useState<TtsProvider>('openai')
  const [newName, setNewName] = useState('')
  const [search, setSearch] = useState('')
  const [removing, setRemoving] = useState(false)
  const tts = settings.tts, cloud = tts.provider !== 'windows'
  const profiles = ttsProfiles(tts)
  const activeId = tts.activeProfileId ?? (cloud ? `migrated-${tts.provider}` : 'windows')
  const active = profiles.find(profile => profile.id === activeId) ?? profiles[0]
  const update = (delta: Partial<Settings['tts']>): void => patch({ tts: normalizeTtsSettings({ ...patchTtsSettings({ ...tts, profiles, activeProfileId: activeId }, delta), connections: undefined }) })
  useEffect(() => adding ? registerGameModePreparation(async () => false) : undefined, [adding])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (cloud) return
    let active = true
    void window.api.life.voices().then(result => { if (active && result.ok && result.voices) setVoices(result.voices) }).catch(() => undefined)
    return () => { active = false }
  }, [cloud])
  const preview = async (): Promise<void> => {
    setBusy(true); setNotice(null)
    try {
      const result = await window.api.life.speak(i18n.t('这是一段试听。语会用这里选择的声音朗读简报和你要听的内容。'))
      if (alive.current) setNotice({ error: false, text: i18n.t(result.skipped ? '本次朗读已跳过或停止。' : '试听已完成。') })
    } catch (error) { if (alive.current) setNotice({ error: true, text: String(error) }) }
    finally { if (alive.current) setBusy(false) }
  }
  const choose = (id: string): void => {
    update({ activeProfileId: id })
    setShowKey(false); setNotice(null)
  }
  const add = (): void => {
    const preset = TTS_PRESETS[template]
    const baseName = newName.trim() || i18n.t(preset.label)
    let name = baseName, n = 2
    while (profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) name = `${baseName} ${n++}`
    const profile = { id: crypto.randomUUID(), name, provider: template, baseUrl: preset.baseUrl, apiKey: '', model: preset.model, apiVoice: preset.apiVoice, voice: '', rate: 0, speed: 1, volume: 100 }
    update({ profiles: [...profiles, profile], activeProfileId: profile.id })
    setSearch(''); setAdding(false); setNewName(''); setShowKey(false); setNotice(null)
  }
  const stop = async (): Promise<void> => {
    try { await window.api.life.stopSpeaking() }
    catch (error) { setNotice({ error: true, text: String(error) }) }
  }
  const sidebar = <>
    <Stack spacing={1} sx={{ p: 1.25 }}>
      <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{i18n.t('TTS 配置')}</Typography>
      <Button size="small" variant="outlined" disabled={busy || profiles.length >= 50} onClick={() => setAdding(true)}>{i18n.t('添加提供商')}</Button>
      <TextField size="small" placeholder={i18n.t('搜索已添加的配置')} value={search} onChange={event => setSearch(event.target.value)} inputProps={{ 'aria-label': i18n.t('搜索 TTS 配置') }} />
    </Stack>
    <Box sx={{ px: 0.75, pb: 0.75, maxHeight: { xs: 230, md: 530 }, overflowY: 'auto' }}>
      {profiles.filter(profile => `${profile.name} ${TTS_PRESETS[profile.provider].label}`.toLowerCase().includes(search.toLowerCase())).map(profile => <ButtonBase key={profile.id} aria-pressed={activeId === profile.id} disabled={busy} onClick={() => choose(profile.id)} data-tts-profile={profile.id}
        sx={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start', gap: 1, p: 1, mb: 0.5, border: 1, borderColor: activeId === profile.id ? 'primary.main' : 'transparent', borderRadius: '7px', bgcolor: activeId === profile.id ? modelSelectedBackground : 'transparent', '&:hover': { bgcolor: activeId === profile.id ? modelSelectedBackground : 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
        <ModelAvatar name={profile.name} active={activeId === profile.id} /><Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap>{profile.name}</Typography><Typography sx={{ fontSize: 11.5, mt: 0.25, color: 'text.secondary' }}>{activeId === profile.id ? i18n.t('当前使用') : i18n.t(TTS_PRESETS[profile.provider].label)}</Typography></Box>
      </ButtonBase>)}
      {!profiles.some(profile => `${profile.name} ${TTS_PRESETS[profile.provider].label}`.toLowerCase().includes(search.toLowerCase())) && <Typography sx={{ p: 1.5, fontSize: 12, color: 'text.secondary' }}>{i18n.t('没有匹配的配置')}</Typography>}
    </Box>
  </>
  return <><ModelWorkspace sidebar={sidebar}>
    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <ModelAvatar name={active.name} active />
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 16, fontWeight: 600 }} noWrap>{active.name}</Typography><Typography sx={{ fontSize: 11.5, mt: 0.25, color: 'text.secondary' }}>{i18n.t(cloud ? '云端语音合成' : '本机系统声音')}</Typography></Box>
      <Typography component="span" sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('启用朗读')}</Typography>
      <Switch size="small" checked={tts.enabled} inputProps={{ 'aria-label': i18n.t('启用朗读') }} onChange={event => update({ enabled: event.target.checked })} />
    </Stack>
    <Stack spacing={2.25} sx={{ p: 2.25 }}>
      <TextField key={active.id + '-name'} fullWidth size="small" label={i18n.t('配置名称')} defaultValue={active.name} disabled={busy} inputProps={{ maxLength: 80 }} sx={modelFieldSx}
        onBlur={event => { const name = event.target.value.trim(); if (name) update({ profiles: profiles.map(profile => profile.id === activeId ? { ...profile, name } : profile) }); else event.target.value = active.name }} />
      {cloud ? <>
        <TextField fullWidth size="small" label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" value={tts.apiKey} disabled={busy} inputProps={{ 'aria-label': 'TTS API Key' }} sx={modelFieldSx} onChange={event => update({ apiKey: event.target.value })}
          InputProps={{ endAdornment: <InputAdornment position="end"><IconButton size="small" aria-label={i18n.t(showKey ? '隐藏密钥' : '显示密钥')} onClick={() => setShowKey(value => !value)}>{showKey ? <VisibilityOffOutlined sx={{ fontSize: 17 }} /> : <VisibilityOutlined sx={{ fontSize: 17 }} />}</IconButton></InputAdornment> }} />
        <TextField fullWidth size="small" label={i18n.t('接口地址')} value={tts.baseUrl} disabled={busy} sx={modelFieldSx} inputProps={{ 'aria-label': i18n.t('接口地址') }} onChange={event => update({ baseUrl: event.target.value })}
          helperText={i18n.t(tts.provider === 'elevenlabs' ? '填写 /v1/text-to-speech 地址，音色 ID 会自动附加。' : '可修改为所在区域或代理的完整接口地址。')} />
        {tts.provider !== 'azure' && <TextField fullWidth size="small" label={i18n.t(tts.provider === 'volcengine' ? '资源 ID' : '模型 ID')} value={tts.model} disabled={busy} sx={modelFieldSx} inputProps={{ 'aria-label': i18n.t(tts.provider === 'volcengine' ? '资源 ID' : '模型 ID') }} onChange={event => update({ model: event.target.value })} />}
        <TextField fullWidth size="small" label={i18n.t('音色 ID')} value={tts.apiVoice} disabled={busy} sx={modelFieldSx} inputProps={{ 'aria-label': i18n.t('音色 ID') }} onChange={event => update({ apiVoice: event.target.value })} helperText={i18n.t('按提供商文档填写，需与所选模型及账号权限匹配。')} />
      </> : <TextField select fullWidth size="small" label={i18n.t('声音')} value={tts.voice} disabled={!voices.length || busy} sx={modelFieldSx} InputLabelProps={{ shrink: true }} SelectProps={{ displayEmpty: true }} inputProps={{ 'aria-label': i18n.t('声音') }} onChange={event => update({ voice: event.target.value })}
        helperText={i18n.t(voices.length ? '来自本机的 Windows 语音。' : '没有检测到可用的系统语音。')}>
        <MenuItem value="">{i18n.t('系统默认')}</MenuItem>
        {tts.voice && !voices.includes(tts.voice) && <MenuItem value={tts.voice}>{tts.voice} · {i18n.t('本机不可用')}</MenuItem>}
        {voices.map(voice => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}
      </TextField>}
      <Stack direction="row" spacing={1} alignItems="center"><Button size="small" variant="contained" disableElevation startIcon={<VolumeUpOutlined sx={{ fontSize: 17 }} />} disabled={busy || !tts.enabled || saving || Boolean(saveError)} onClick={() => void preview()}>{i18n.t(busy ? '正在试听…' : '试听')}</Button>{busy && <Button size="small" onClick={() => void stop()}>{i18n.t('停止朗读')}</Button>}</Stack>
      {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)} sx={{ fontSize: 12 }}>{notice.text}</Alert>}
      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.75 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 1.5 }}>{i18n.t('播放设置')}</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, '& .MuiFormControl-root': { width: '100%' } }}>
          <Stack spacing={0.75}><Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('语速')}</Typography><SettingsNumber key={active.id} value={cloud ? tts.speed : tts.rate} min={cloud ? 0.5 : -10} max={cloud ? 2 : 10} step={cloud ? 0.1 : 1} disabled={busy} label={i18n.t('语速')} onChange={value => update(cloud ? { speed: value } : { rate: value })} /></Stack>
          <Stack spacing={0.75}><Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('音量')}</Typography><SettingsNumber value={tts.volume} min={0} max={100} disabled={busy} label={i18n.t('音量')} onChange={volume => update({ volume })} /></Stack>
        </Box>
        <Typography sx={{ fontSize: 11, mt: 1, color: 'text.secondary' }}>{i18n.t(cloud ? '0.5–2 倍速，1 为正常速度。' : '0 为正常速度，负数更慢，正数更快。')}</Typography>
      </Box>

      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.7 }}>{i18n.t(!tts.enabled ? '先启用朗读，再试听所选声音。' : cloud ? '云端朗读会将文本发送给所选服务。' : '系统朗读在本机完成。')}</Typography>
    </Stack>
      {active.id !== 'windows' && <Button size="small" color="error" disabled={busy} sx={{ alignSelf: 'flex-start', m: 2, mt: 0 }} onClick={() => setRemoving(true)}>{i18n.t('删除配置')}</Button>}
  </ModelWorkspace>
  <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
    <DialogTitle>{i18n.t('添加 TTS 提供商')}</DialogTitle>
    <DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      <TextField select size="small" label={i18n.t('提供商模板')} value={template} onChange={event => setTemplate(event.target.value as TtsProvider)}>
        {(Object.keys(TTS_PRESETS) as TtsProvider[]).map(provider => <MenuItem key={provider} value={provider}>{i18n.t(TTS_PRESETS[provider].label)}</MenuItem>)}
      </TextField>
      <TextField autoFocus size="small" label={i18n.t('配置名称')} value={newName} placeholder={i18n.t(TTS_PRESETS[template].label)} inputProps={{ maxLength: 80 }} onChange={event => setNewName(event.target.value)} />
      <Typography variant="caption" color="text.secondary">{i18n.t('同一家提供商可以添加多套配置，分别保存地址、密钥、模型和音色。')}</Typography>
    </Stack></DialogContent>
    <DialogActions><Button onClick={() => setAdding(false)}>{i18n.t('取消')}</Button><Button variant="contained" onClick={add}>{i18n.t('添加')}</Button></DialogActions>
  </Dialog>
  <Dialog open={removing} onClose={() => setRemoving(false)}><DialogTitle>{i18n.t('删除配置')}</DialogTitle>
    <DialogContent>{i18n.t('删除“{{name}}”及其保存的连接信息？', { name: active.name })}</DialogContent>
    <DialogActions><Button onClick={() => setRemoving(false)}>{i18n.t('取消')}</Button><Button color="error" onClick={() => { const next = profiles.filter(profile => profile.id !== activeId); update({ profiles: next, activeProfileId: next[0]?.id ?? '' }); setRemoving(false); setShowKey(false); setNotice(null) }}>{i18n.t('删除')}</Button></DialogActions>
  </Dialog></>
}
