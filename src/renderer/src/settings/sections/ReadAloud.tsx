import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, MenuItem, Stack, Switch, TextField } from '@mui/material'
import VolumeUpOutlined from '@mui/icons-material/VolumeUpOutlined'
import type { Settings } from '@shared/types'
import { TTS_PRESETS, type TtsProvider } from '@shared/speech'
import { SettingsGroup, SettingsHint, SettingsNumber, SettingsRow, controlSx } from './General'
import i18n from '../../i18n'

export function ReadAloudSection({ settings, patch, saving, saveError }: { settings: Settings; patch: (delta: Partial<Settings>) => void; saving: boolean; saveError: string }): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const alive = useRef(true)
  const tts = settings.tts, cloud = tts.provider !== 'windows'
  const update = (delta: Partial<Settings['tts']>): void => patch({ tts: { ...tts, ...delta } })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (cloud) return
    let active = true
    void window.api.life.voices().then(result => {
      if (active && result.ok && result.voices) setVoices(result.voices)
    }).catch(() => undefined)
    return () => { active = false }
  }, [cloud])
  const preview = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
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
    setNotice(null)
  }
  const stop = async (): Promise<void> => {
    try { await window.api.life.stopSpeaking() }
    catch (error) { setNotice({ error: true, text: String(error) }) }
  }

  return <Stack spacing={2}>
    {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)}>{notice.text}</Alert>}
    <SettingsGroup icon={<VolumeUpOutlined fontSize="small"/>} title={i18n.t('TTS模型')}>
      <SettingsRow label={i18n.t('启用朗读')}
        description={i18n.t('使用系统声音或你配置的 TTS 服务朗读内容。默认关闭。')}>
        <Switch size="small" checked={settings.tts.enabled}
          onChange={e => patch({ tts: { ...settings.tts, enabled: e.target.checked } })} />
      </SettingsRow>
      <SettingsRow label={i18n.t('朗读提供商')} description={i18n.t('各提供商的连接配置独立保存。云端朗读会将文本发送给所选服务。')}>
        <TextField select size="small" sx={controlSx} value={tts.provider} disabled={busy} inputProps={{ 'aria-label': i18n.t('朗读提供商') }} onChange={e => choose(e.target.value as TtsProvider)}>
          {Object.entries(TTS_PRESETS).map(([key, preset]) => <MenuItem key={key} value={key}>{i18n.t(preset.label)}</MenuItem>)}
        </TextField>
      </SettingsRow>
      {cloud ? <>
        <SettingsRow label={i18n.t('接口地址')} description={i18n.t(tts.provider === 'elevenlabs' ? '填写 /v1/text-to-speech 地址，音色 ID 会自动附加。' : '可修改为所在区域或代理的完整接口地址。')}>
          <TextField size="small" sx={controlSx} value={tts.baseUrl} disabled={busy} inputProps={{ 'aria-label': i18n.t('接口地址') }} onChange={e => update({ baseUrl: e.target.value })} />
        </SettingsRow>
        <SettingsRow label="API Key" description={i18n.t(tts.provider === 'volcengine' ? '使用新版豆包语音控制台的 API Key。' : '填写所选提供商的密钥；本地兼容服务可留空。')}>
          <TextField size="small" type="password" autoComplete="off" sx={controlSx} value={tts.apiKey} disabled={busy} inputProps={{ 'aria-label': 'TTS API Key' }} onChange={e => update({ apiKey: e.target.value })} />
        </SettingsRow>
        {tts.provider !== 'azure' && <SettingsRow label={i18n.t(tts.provider === 'volcengine' ? '资源 ID' : '模型')}>
          <TextField size="small" sx={controlSx} value={tts.model} disabled={busy} inputProps={{ 'aria-label': i18n.t(tts.provider === 'volcengine' ? '资源 ID' : '模型') }} onChange={e => update({ model: e.target.value })} />
        </SettingsRow>}
        <SettingsRow label={i18n.t('音色 ID')} description={i18n.t('按提供商文档填写，需与所选模型及账号权限匹配。')}>
          <TextField size="small" sx={controlSx} value={tts.apiVoice} disabled={busy} inputProps={{ 'aria-label': i18n.t('音色 ID') }} onChange={e => update({ apiVoice: e.target.value })} />
        </SettingsRow>
      </> : <>
      <SettingsRow label={i18n.t('声音')} description={voices.length ? i18n.t('来自本机的 Windows 语音。') : i18n.t('没有检测到可用的系统语音。')}>
        <TextField select size="small" sx={controlSx} value={voices.includes(tts.voice) ? tts.voice : ''} disabled={!voices.length || busy}
          onChange={e => patch({ tts: { ...settings.tts, voice: e.target.value } })}>
          <MenuItem value="">{i18n.t('系统默认')}</MenuItem>
          {voices.map(voice => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}
        </TextField>
      </SettingsRow>
      </>}
      <SettingsRow label={i18n.t('语速')} description={i18n.t(cloud ? '0.5–2 倍速，1 为正常速度。' : '0 为正常速度，负数更慢，正数更快。')}>
        <SettingsNumber key={tts.provider} value={cloud ? tts.speed : tts.rate} min={cloud ? 0.5 : -10} max={cloud ? 2 : 10} step={cloud ? 0.1 : 1} disabled={busy} label={i18n.t('语速')}
          onChange={value => update(cloud ? { speed: value } : { rate: value })} />
      </SettingsRow>
      <SettingsRow label={i18n.t('音量')}>
        <SettingsNumber value={tts.volume} min={0} max={100} disabled={busy} label={i18n.t('音量')} onChange={volume => update({ volume })} />
      </SettingsRow>
      <Box sx={{ px: 2, py: 1.5 }}>
        <Button size="small" variant="outlined" disabled={busy || !settings.tts.enabled || saving || !!saveError} onClick={() => void preview()}>{i18n.t(busy ? '正在试听…' : '试听')}</Button>
        {busy && <Button size="small" onClick={() => void stop()}>{i18n.t('停止朗读')}</Button>}
      </Box>
      <SettingsHint>{i18n.t('朗读失败时会如实告诉你，不会假装已经读过。')}</SettingsHint>
    </SettingsGroup>
  </Stack>
}
