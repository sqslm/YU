import { useEffect, useState } from 'react'
import { Switch, TextField } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { Settings, VoiceCommandMode, VoiceCommandsSettings } from '@shared/types'
import { VOICE_COMMAND_MODES, voiceCommandConflict } from '@shared/voiceCommands'
import { IconSparkle, SettingsGroup, SettingsHint, SettingsRow } from './General'

const labels: Record<VoiceCommandMode, string> = { dictation: '听写', translate: '翻译', ask: '问答', reminder: '快速提醒', notes: '随记' }

function KeywordRow({ mode, settings, save }: { mode: VoiceCommandMode; settings: VoiceCommandsSettings; save: (keywords: string[]) => void }): JSX.Element {
  const { t } = useTranslation()
  const stored = settings.keywords[mode].join('; ')
  const [draft, setDraft] = useState(stored), [error, setError] = useState(false)
  useEffect(() => { setDraft(stored); setError(false) }, [stored])
  const commit = (): void => {
    const keywords = [...new Set(draft.split(/[;；\n]/u).map(value => value.trim()).filter(Boolean))]
    if (voiceCommandConflict(mode, keywords, settings)) { setError(true); return }
    setError(false)
    if (keywords.join('; ') !== stored) save(keywords)
  }
  return <SettingsRow label={t(labels[mode])}>
    <TextField size="small" multiline minRows={1} maxRows={3} value={draft} error={error}
      inputProps={{ 'aria-label': t('{{mode}}激活关键词', { mode: t(labels[mode]) }) }} data-voice-keywords={mode}
      sx={{ width: 340, maxWidth: '100%' }} onChange={event => { setDraft(event.target.value); setError(false) }} onBlur={commit}
      helperText={error ? t('关键词已用于另一模式，请换一个。') : undefined} />
  </SettingsRow>
}

export function VoiceCommandsSection({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const { t } = useTranslation()
  const commands = settings.voiceCommands
  return <><SettingsGroup icon={<IconSparkle />} title={t('统一语音入口')}>
    <SettingsRow label={t('智能识别语音意图')} description={t('用听写快捷键说出需求，自动选择问答、翻译、提醒、随记或助手操作；普通口述继续自动路由润色。')}>
      <Switch size="small" checked={commands.smartRouting} inputProps={{ 'aria-label': t('智能识别语音意图') }} data-smart-routing-toggle
        onChange={event => patch({ voiceCommands: { smartRouting: event.target.checked } as VoiceCommandsSettings })} />
    </SettingsRow>
    <SettingsHint>{t('意图识别可能增加一次 LLM 调用。')}</SettingsHint>
  </SettingsGroup><SettingsGroup icon={<IconSparkle />} title={t('语音关键词切换模式')}>
    <SettingsRow label={t('启用关键词切换')} description={t('用听写快捷键开麦，先说关键词，再说正文；其他模式快捷键保持原样。')}>
      <Switch size="small" checked={commands.enabled} inputProps={{ 'aria-label': t('启用关键词切换') }} data-voice-commands-toggle
        onChange={event => patch({ voiceCommands: { enabled: event.target.checked } as VoiceCommandsSettings })} />
    </SettingsRow>
    {commands.enabled && <>
      {VOICE_COMMAND_MODES.map(mode => <KeywordRow key={mode} mode={mode} settings={commands}
        save={keywords => patch({ voiceCommands: { keywords: { [mode]: keywords } } as VoiceCommandsSettings })} />)}
      <SettingsHint>{t('关键词用分号或换行分隔，留空停用；可能增加 ASR 调用。')}</SettingsHint>
    </>}
  </SettingsGroup></>
}
