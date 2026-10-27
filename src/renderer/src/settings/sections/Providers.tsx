import { useState } from 'react'
import { Box, MenuItem, Stack, Tab, Tabs, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { ProviderProfiles } from './ProviderProfiles'
import { LocalModel } from './LocalModel'
import { ReadAloudSection } from './ReadAloud'
import i18n from '../../i18n'
import { modelSelectedBackground } from './ModelWorkspace'

type ModelService = 'asr' | 'llm' | 'tts'
const SERVICES: Array<{ kind: ModelService; label: string; hint: string }> = [
  { kind: 'asr', label: 'ASR模型', hint: '将录音转换成文字' },
  { kind: 'llm', label: 'LLM模型', hint: '理解、处理与生成内容' },
  { kind: 'tts', label: 'TTS模型', hint: '将文字转换为语音' }
]

export function ProvidersSection({ settings, patch, saving, saveError }: { settings: Settings; patch: (delta: Partial<Settings>) => void; saving: boolean; saveError: string }): JSX.Element {
  const [service, setService] = useState<ModelService>(settings.pipelineMode === 'multimodal' ? 'llm' : 'asr')
  return <Stack spacing={1.75} data-models-redesign>
    <Tabs value={service} onChange={(_event, next: ModelService) => setService(next)} variant="fullWidth" aria-label={i18n.t('模型用途')}
      sx={{ minHeight: 62, border: 1, borderColor: 'divider', borderRadius: '9px', bgcolor: 'background.paper', '& .MuiTabs-indicator': { display: 'none' } }}>
      {SERVICES.map(item => <Tab key={item.kind} value={item.kind} aria-label={i18n.t(item.label)} data-model-service={item.kind}
        label={<Box><Typography component="span" sx={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{i18n.t(item.label)}</Typography><Typography component="span" sx={{ display: 'block', mt: 0.35, fontSize: 11, color: 'text.secondary' }}>{i18n.t(item.hint)}</Typography></Box>}
        sx={{ minHeight: 62, minWidth: 0, px: 1, py: 1, border: 1, borderColor: 'transparent', borderRadius: '8px', color: 'text.secondary', '&.Mui-selected': { borderColor: 'primary.main', bgcolor: modelSelectedBackground, color: 'primary.main' } }} />)}
    </Tabs>
    {service !== 'tts' && <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{i18n.t('处理方式')}</Typography>
      <TextField select size="small" value={settings.pipelineMode} inputProps={{ 'aria-label': i18n.t('语音处理流程') }} sx={{ width: 146 }}
        onChange={event => patch({ pipelineMode: event.target.value as Settings['pipelineMode'] })}>
        <MenuItem value="classic" data-model-flow="classic">{i18n.t('分步处理')}</MenuItem>
        <MenuItem value="multimodal" data-model-flow="multimodal">{i18n.t('音频直达')}</MenuItem>
      </TextField>
      <Typography data-model-active-chain sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.5 }}>{i18n.t(settings.pipelineMode === 'classic' ? 'ASR → LLM，分别识别与处理' : '多模态 LLM 直接处理录音')}</Typography>
    </Stack>}
    {service === 'tts' ? <ReadAloudSection settings={settings} patch={patch} saving={saving} saveError={saveError} /> :
      <ProviderProfiles key={service} kind={service} settings={settings} patch={patch} saving={saving} saveError={saveError}
        localModel={service === 'asr' ? <LocalModel settings={settings} patch={patch} /> : undefined} />}
  </Stack>
}
