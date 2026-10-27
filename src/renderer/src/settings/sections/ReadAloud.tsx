import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, ButtonBase, IconButton, InputAdornment, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined'
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined'
import VolumeUpOutlined from '@mui/icons-material/VolumeUpOutlined'
import { TTS_PRESETS, type TtsProvider } from '@shared/speech'
import type { Settings } from '@shared/types'
import { SettingsNumber } from './General'
import { ModelAvatar, ModelWorkspace, modelFieldSx, modelSelectedBackground } from './ModelWorkspace'
import i18n from '../../i18n'

export function ReadAloudSection({ settings, patch, saving, saveError }: { settings: Settings; patch: (delta: Partial<Settings>) => void; saving: boolean; saveError: string }): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const alive = useRef(true)
  const tts = settings.tts, cloud = tts.provider !== 'windows'
  const update = (delta: Partial<Settings['tts']>): void => patch({ tts: { ...tts, ...delta } })
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
  const choose = (provider: TtsProvider): void => {
    const connections = { ...tts.connections }
    if (cloud) connections[tts.provider] = { baseUrl: tts.baseUrl, apiKey: tts.apiKey, model: tts.model, apiVoice: tts.apiVoice }
    const preset = TTS_PRESETS[provider]
    update({ provider, connections, ...(provider === 'windows' ? {} : connections[provider] ?? { baseUrl: preset.baseUrl, model: preset.model, apiVoice: preset.apiVoice, apiKey: '' }) })
    setShowKey(false); setNotice(null)
  }
  const stop = async (): Promise<void> => {
    try { await window.api.life.stopSpeaking() }
    catch (error) { setNotice({ error: true, text: String(error) }) }
  }
  const sidebar = <>
    <Typography sx={{ px: 1.5, pt: 1.5, pb: 0.5, fontSize: 12.5, fontWeight: 600 }}>{i18n.t('朗读提供商')}</Typography>
    <Typography sx={{ px: 1.5, pb: 1, fontSize: 10.5, color: 'text.secondary' }}>{i18n.t('选中后用于朗读，配置分别保留。')}</Typography>
    <Box sx={{ px: 0.75, pb: 0.75, maxHeight: { xs: 230, md: 530 }, overflowY: 'auto' }}>
      {(Object.entries(TTS_PRESETS) as Array<[TtsProvider, typeof TTS_PRESETS[TtsProvider]]>).map(([provider, preset]) => <ButtonBase key={provider} aria-pressed={tts.provider === provider} disabled={busy} onClick={() => choose(provider)} data-tts-provider={provider}
        sx={{ width: '100%', textAlign: 'left', justifyContent: 'flex-start', gap: 1, p: 1, mb: 0.5, border: 1, borderColor: tts.provider === provider ? 'primary.main' : 'transparent', borderRadius: '7px', bgcolor: tts.provider === provider ? modelSelectedBackground : 'transparent', '&:hover': { bgcolor: tts.provider === provider ? modelSelectedBackground : 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
        <ModelAvatar name={preset.label} active={tts.provider === provider} /><Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 13, fontWeight: 500 }} noWrap>{i18n.t(preset.label)}</Typography><Typography sx={{ fontSize: 11.5, mt: 0.25, color: 'text.secondary' }}>{i18n.t(provider === 'windows' ? '系统声音' : tts.connections?.[provider] ? '已保存配置' : '云端 API')}</Typography></Box>
      </ButtonBase>)}
    </Box>
  </>
  return <ModelWorkspace sidebar={sidebar}>
    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
      <ModelAvatar name={TTS_PRESETS[tts.provider].label} active />
      <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontSize: 16, fontWeight: 600 }} noWrap>{i18n.t(TTS_PRESETS[tts.provider].label)}</Typography><Typography sx={{ fontSize: 11.5, mt: 0.25, color: 'text.secondary' }}>{i18n.t(cloud ? '云端语音合成' : '本机系统声音')}</Typography></Box>
      <Typography component="span" sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('启用朗读')}</Typography>
      <Switch size="small" checked={tts.enabled} inputProps={{ 'aria-label': i18n.t('启用朗读') }} onChange={event => update({ enabled: event.target.checked })} />
    </Stack>
    <Stack spacing={2.25} sx={{ p: 2.25 }}>
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
          <Stack spacing={0.75}><Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('语速')}</Typography><SettingsNumber key={tts.provider} value={cloud ? tts.speed : tts.rate} min={cloud ? 0.5 : -10} max={cloud ? 2 : 10} step={cloud ? 0.1 : 1} disabled={busy} label={i18n.t('语速')} onChange={value => update(cloud ? { speed: value } : { rate: value })} /></Stack>
          <Stack spacing={0.75}><Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('音量')}</Typography><SettingsNumber value={tts.volume} min={0} max={100} disabled={busy} label={i18n.t('音量')} onChange={volume => update({ volume })} /></Stack>
        </Box>
        <Typography sx={{ fontSize: 11, mt: 1, color: 'text.secondary' }}>{i18n.t(cloud ? '0.5–2 倍速，1 为正常速度。' : '0 为正常速度，负数更慢，正数更快。')}</Typography>
      </Box>

      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.7 }}>{i18n.t(!tts.enabled ? '先启用朗读，再试听所选声音。' : cloud ? '云端朗读会将文本发送给所选服务。' : '系统朗读在本机完成。')}</Typography>
    </Stack>
  </ModelWorkspace>
}
