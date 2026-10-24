import { useEffect, useState } from 'react'
import { Button, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { WakeWordStatus } from '@shared/wake-word'
import { SettingsGroup, SettingsRow } from './General'
import i18n from '../../i18n'

export function WakeWordSection({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const [draft, setDraft] = useState(settings.wakeWord.phrase)
  const [status, setStatus] = useState<WakeWordStatus>({ phase: 'off' })
  useEffect(() => setDraft(settings.wakeWord.phrase), [settings.wakeWord.phrase])
  useEffect(() => {
    let active = true
    const unsubscribe = window.api.wakeWord.onChanged(value => { if (active) setStatus(value) })
    void window.api.wakeWord.status().then(value => { if (active) setStatus(value) })
    return () => { active = false; unsubscribe() }
  }, [])
  const phrase = draft.trim().replace(/\s+/g, ' ')
  const invalid = phrase.length < 2 || phrase.length > 40
  const commit = (): void => {
    if (!invalid && phrase !== settings.wakeWord.phrase) patch({ wakeWord: { ...settings.wakeWord, phrase } })
  }
  const labels = { off: '已关闭', starting: '正在启动本地唤醒…', listening: '正在等待唤醒词', paused: '任务进行中，唤醒已暂停', error: '语音唤醒不可用' }
  const errors = { language: '请在 Windows 设置中安装唤醒词对应的中文或英文语音识别语言包。', microphone: '无法访问 Windows 默认麦克风，请检查系统麦克风权限和输入设备。', unavailable: 'Windows 本地语音识别启动失败，请重试。' }
  return <SettingsGroup title={i18n.t('语音唤醒')} collapsible defaultOpen={settings.wakeWord.enabled}>
    <SettingsRow label={i18n.t('启用语音唤醒')} description={i18n.t('使用 Windows 默认麦克风离线等待唤醒词，默认关闭；唤醒前不上传音频。')}>
      <Switch size="small" inputProps={{ 'aria-label': i18n.t('启用语音唤醒') }} checked={settings.wakeWord.enabled} onChange={event => patch({ wakeWord: { ...settings.wakeWord, enabled: event.target.checked } })} />
    </SettingsRow>
    <SettingsRow label={i18n.t('自定义唤醒词')} description={i18n.t('说出唤醒词，看到录音条后再说需求；停顿后自动提交，右 Alt 结束，Esc 取消。')}>
      <TextField size="small" sx={{ width: 220 }} value={draft} error={invalid} inputProps={{ maxLength: 40, 'aria-label': i18n.t('自定义唤醒词') }}
        onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit() }}
        helperText={invalid ? i18n.t('唤醒词需要 2–40 个字符') : undefined} />
    </SettingsRow>
    <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5 }}>
      <Typography sx={{ fontSize: 12, color: status.phase === 'error' ? 'error.main' : 'text.secondary' }} role="status">
        {i18n.t(labels[status.phase])}{status.error ? ` · ${i18n.t(errors[status.error])}` : ''}
      </Typography>
      {status.phase === 'error' && <Button size="small" onClick={() => void window.api.wakeWord.retry().then(setStatus)}>{i18n.t('重试')}</Button>}
    </Stack>
  </SettingsGroup>
}
