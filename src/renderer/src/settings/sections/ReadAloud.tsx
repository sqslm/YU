import { useEffect, useState } from 'react'
import { Alert, Box, Button, MenuItem, Stack, Switch, TextField } from '@mui/material'
import VolumeUpOutlined from '@mui/icons-material/VolumeUpOutlined'
import type { Settings } from '@shared/types'
import { SettingsGroup, SettingsHint, SettingsRow, controlSx, narrowControlSx } from './General'
import i18n from '../../i18n'

export function ReadAloudSection({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const [voices, setVoices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  useEffect(() => {
    let active = true
    void window.api.life.voices().then(result => {
      if (active && result.ok && result.voices) setVoices(result.voices)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.life.speak(i18n.t('这是一段试听。语会用这里选择的声音朗读简报和你要听的内容。'))
      setNotice({ error: false, text: result.skipped ? i18n.t('没有可朗读的内容。') : i18n.t('已开始朗读。') })
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }

  return <Stack spacing={2}>
    {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)}>{notice.text}</Alert>}
    <SettingsGroup icon={<VolumeUpOutlined fontSize="small"/>} title={i18n.t('朗读')}>
      <SettingsRow label={i18n.t('启用朗读')}
        description={i18n.t('用 Windows 自带语音朗读简报和你要听的内容。默认关闭，只在你明确要求时发声。')}>
        <Switch size="small" checked={settings.tts.enabled}
          onChange={e => patch({ tts: { ...settings.tts, enabled: e.target.checked } })} />
      </SettingsRow>
      <SettingsRow label={i18n.t('声音')} description={voices.length ? i18n.t('来自本机的 Windows 语音。') : i18n.t('没有检测到可用的系统语音。')}>
        <TextField select size="small" sx={controlSx} value={settings.tts.voice} disabled={!voices.length}
          onChange={e => patch({ tts: { ...settings.tts, voice: e.target.value } })}>
          <MenuItem value="">{i18n.t('系统默认')}</MenuItem>
          {voices.map(voice => <MenuItem key={voice} value={voice}>{voice}</MenuItem>)}
        </TextField>
      </SettingsRow>
      <SettingsRow label={i18n.t('语速')} description={i18n.t('0 为正常速度，负数更慢，正数更快。')}>
        <TextField size="small" type="number" sx={narrowControlSx} value={settings.tts.rate}
          onChange={e => patch({ tts: { ...settings.tts, rate: Math.max(-10, Math.min(10, Number(e.target.value) || 0)) } })} />
      </SettingsRow>
      <SettingsRow label={i18n.t('音量')}>
        <TextField size="small" type="number" sx={narrowControlSx} value={settings.tts.volume}
          onChange={e => patch({ tts: { ...settings.tts, volume: Math.max(0, Math.min(100, Number(e.target.value) || 0)) } })} />
      </SettingsRow>
      <Box sx={{ px: 2, py: 1.5 }}>
        <Button size="small" variant="outlined" disabled={busy || !settings.tts.enabled} onClick={() => void preview()}>{i18n.t('试听')}</Button>
      </Box>
      <SettingsHint>{i18n.t('朗读失败时会如实告诉你，不会假装已经读过。')}</SettingsHint>
    </SettingsGroup>
  </Stack>
}
