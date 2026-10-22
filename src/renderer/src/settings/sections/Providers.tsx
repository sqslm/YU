import { useState } from 'react'
import { Alert, Box, Button, Stack, Typography } from '@mui/material'
import type { ProviderKind, Settings } from '@shared/types'
import { profilesOf } from '@shared/profiles'
import { IconCpu, SettingsGroup, SettingsRow, SettingsNumber } from './General'
import { ProviderProfiles } from './ProviderProfiles'
import { LocalModel } from './LocalModel'
import i18n from '../../i18n'

const SERVICES: Array<{ kind: ProviderKind; label: string; hint: string }> = [
  { kind: 'asr', label: '语音识别', hint: '将录音转换成文字，供分步处理使用。' },
  { kind: 'llm', label: '文本处理', hint: '用于润色、翻译、Ask 和选区处理，两种语音流程均可使用。' },
  { kind: 'multimodal', label: '音频模型', hint: '直接理解录音并生成结果，供音频直达使用。' }
]

/** Choose how audio is handled, then manage connections by the job they do. */
export function ProvidersSection({ settings, patch }: { settings: Settings; patch: (delta: Partial<Settings>) => void }): JSX.Element {
  const [service, setService] = useState<ProviderKind>(settings.pipelineMode === 'multimodal' ? 'multimodal' : 'asr')
  const selected = SERVICES.find(item => item.kind === service)!
  const list = profilesOf(settings, service)
  const enabled = list.filter(profile => profile.enabled)
  const summary = (kind: ProviderKind): string => profilesOf(settings, kind).filter(profile => profile.enabled).map(profile => profile.name).join(' → ') || i18n.t('未启用连接')
  return <Stack spacing={3} data-models-redesign>
    <Box>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>{i18n.t('语音处理流程')}</Typography>
      <Box role="group" aria-label={i18n.t('语音处理流程')} sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 }}>
        {([
          { mode: 'classic', title: '分步处理', path: '录音 → 语音识别 → 文本处理', hint: '识别与润色分别选择模型' },
          { mode: 'multimodal', title: '音频直达', path: '录音 → 音频模型 → 结果', hint: '由支持音频输入的模型直接处理' }
        ] as const).map(option => <Button key={option.mode} data-model-flow={option.mode} aria-pressed={settings.pipelineMode === option.mode}
          onClick={() => { patch({ pipelineMode: option.mode }); setService(option.mode === 'classic' ? 'asr' : 'multimodal') }}
          sx={{ display: 'block', textAlign: 'left', p: 1.75, border: 1, borderColor: settings.pipelineMode === option.mode ? 'primary.main' : 'divider', borderRadius: '10px', bgcolor: settings.pipelineMode === option.mode ? 'action.selected' : 'background.paper', color: 'text.primary' }}>
          <Typography component="span" sx={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{i18n.t(option.title)}</Typography>
          <Typography component="span" sx={{ display: 'block', mt: 0.75, fontSize: 11.5, color: 'text.secondary' }}>{i18n.t(option.path)}</Typography>
          <Typography component="span" sx={{ display: 'block', mt: 0.5, fontSize: 11, color: 'text.disabled' }}>{i18n.t(option.hint)}</Typography>
        </Button>)}
      </Box>
      <Box data-model-active-chain sx={{ mt: 1.25, px: 0.25, fontSize: 11.5, lineHeight: 1.7, color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {settings.pipelineMode === 'classic'
          ? <>{i18n.t('语音识别')}：{settings.localAsr.enabled ? i18n.t('本地优先，失败后使用云端') : summary('asr')}<br />{i18n.t('文本处理')}：{summary('llm')}</>
          : <>{i18n.t('音频模型')}：{summary('multimodal')}<br />{i18n.t('Ask 和选区处理仍使用文本处理连接。')}</>}
      </Box>
    </Box>

    <Box>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>{i18n.t('模型连接')}</Typography>
      <Box role="tablist" aria-label={i18n.t('模型连接')} sx={{ display: 'flex', gap: 0.5, borderBottom: 1, borderColor: 'divider', mb: 1.5 }}>
        {SERVICES.map(item => <Button key={item.kind} role="tab" aria-selected={service === item.kind} data-model-service={item.kind} onClick={() => setService(item.kind)}
          sx={{ flex: 1, minWidth: 0, borderRadius: '6px 6px 0 0', py: 1, fontSize: 12, color: service === item.kind ? 'text.primary' : 'text.secondary', bgcolor: service === item.kind ? 'action.selected' : 'transparent', borderBottom: 2, borderColor: service === item.kind ? 'primary.main' : 'transparent' }}>
          {i18n.t(item.label)}<Box component="span" sx={{ ml: 0.75, fontSize: 10.5, color: 'text.disabled' }}>{profilesOf(settings, item.kind).length}</Box>
        </Button>)}
      </Box>
      <Typography sx={{ mb: 1.5, fontSize: 11.5, color: 'text.secondary', lineHeight: 1.65 }}>{i18n.t(selected.hint)}</Typography>
      <SettingsGroup icon={<IconCpu />} title={i18n.t(selected.label)}>
        <ProviderProfiles key={service} kind={service} settings={settings} patch={patch} />
        {service === 'multimodal' && <SettingsRow label={i18n.t('音频时长上限')} description={i18n.t('每次发送给音频模型的最长录音')}>
          <SettingsNumber value={settings.multimodal.maxSeconds} min={5} max={600} onChange={maxSeconds => patch({ multimodal: { ...settings.multimodal, maxSeconds } })} />
        </SettingsRow>}
      </SettingsGroup>
      <Typography sx={{ mt: 1, fontSize: 11, color: 'text.disabled' }}>{i18n.t('启用的连接按列表顺序调用，失败后使用下一条；拖动可调整顺序。')}</Typography>
      {!enabled.length && <Alert severity="info" sx={{ mt: 1.5, fontSize: 12 }}>{i18n.t(service === 'asr' && settings.localAsr.enabled ? '当前优先使用本地识别，可添加云端备用连接。' : '此类服务尚未启用连接。')}</Alert>}
    </Box>
    <LocalModel settings={settings} patch={patch} />
  </Stack>
}
