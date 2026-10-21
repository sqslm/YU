import { Box, Slider, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { IconSparkle, SettingsField, SettingsGroup, SettingsRow } from './General'
import i18n from '../../i18n'

/**
 * The two knobs that are not a prompt card: whether dictation gets polished at
 * all, at what temperature, and the optional extra instructions handed to Ask.
 *
 * The hand-written fallback prompts and the glossary used to live here too. The
 * glossary is gone (the sidebar's 词典 page owns term replacement) and the
 * fallback texts are gone with the "use built-in prompts" switch, because the
 * five card groups above are now the only source of prompt text.
 */
export function PromptsAdvanced({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const patchPolish = (delta: Partial<Settings['polish']>): void =>
    patch({ polish: { ...settings.polish, ...delta } })

  return (
    <Stack spacing={2.5}>
      <SettingsGroup icon={<IconSparkle />} title={i18n.t(i18n.t('润色行为'))}>
        <SettingsRow
          label={i18n.t(i18n.t('听写后润色'))}
          description={i18n.t(i18n.t('交给文本模型去掉口头语、补全标点，不改动语义'))}
        >
          <Switch
            size="small"
            checked={settings.polish.enabled}
            onChange={(e) => patchPolish({ enabled: e.target.checked })}
          />
        </SettingsRow>
        <SettingsRow label={i18n.t(i18n.t('温度'))} description={i18n.t(i18n.t('越低越稳定；润色场景建议 0.1–0.3'))}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, width: 240 }}>
            <Slider
              size="small"
              min={0}
              max={1}
              step={0.05}
              value={settings.polish.temperature}
              onChange={(_e, value) => patchPolish({ temperature: value as number })}
            />
            <Typography
              sx={{
                fontSize: 11.5,
                color: 'text.secondary',
                width: 32,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {settings.polish.temperature.toFixed(2)}
            </Typography>
          </Box>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup icon={<IconSparkle />} title={i18n.t(i18n.t('Ask 附加要求'))} hint={i18n.t(i18n.t('可留空'))}>
        <SettingsField
          label={i18n.t(i18n.t('补充说明'))}
          description={i18n.t(i18n.t('只追加在内置问答提示词后面，用来规定语气、长度或格式；不会替换工具与来源规则'))}
        >
          <TextField
            multiline
            minRows={3}
            placeholder={i18n.t(i18n.t('例如：答案控制在三句话以内；数字一律标注单位。'))}
            value={settings.polish.askPrompt}
            onChange={(e) => patchPolish({ askPrompt: e.target.value })}
          />
        </SettingsField>
      </SettingsGroup>
    </Stack>
  )
}
