import { Box, Stack, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { profilesOf } from '@shared/profiles'
import {
  IconBook,
  IconCpu,
  IconGlobe,
  IconSparkle,
  IconWaveMic,
  SettingsGroup,
  SettingsRow,
  SettingsNumber
} from './General'
import { ProviderProfiles } from './ProviderProfiles'
import { LocalModel } from './LocalModel'
import i18n from '../../i18n'

type Mode = Settings['pipelineMode']

/**
 * Spacing ladder, in 8px units: the mode switch and its banner are page blocks
 * (`PARTITION_GAP`), the cards of one mode are one group (`GROUP_GAP`). The
 * cards themselves keep the same title/content rhythm as every other settings
 * page, because they are the same `SettingsGroup` those pages use.
 */
const PARTITION_GAP = 3.5 // 28px
const GROUP_GAP = 2.5 // 20px

const MODES: ReadonlyArray<{ value: Mode; label: string; icon: JSX.Element }> = [
  { value: 'classic', label: '传统模式', icon: <IconCpu /> },
  { value: 'multimodal', label: '多模态模式', icon: <IconSparkle /> }
]

/**
 * The one control on this page that is not a card.
 *
 * It is the same pill language as `Segmented` (2px trough, 26–32px options,
 * one filled option), widened to the content column because picking a pipeline
 * mode is a page-level choice rather than a value inside a row. Each option
 * carries the number of profiles saved for that mode, so the tab answers "is
 * there anything in there?" before it is opened — the counts used to sit on the
 * two partition headers this replaces.
 */
function ModeTabs({
  value,
  counts,
  onChange
}: {
  value: Mode
  counts: Record<Mode, number>
  onChange: (value: Mode) => void
}): JSX.Element {
  return (
    <Box
      role="tablist"
      aria-label={i18n.t('模型模式')}
      data-partition-tabs
      sx={{
        display: 'flex',
        gap: '2px',
        p: '2px',
        borderRadius: '8px',
        bgcolor: 'action.hover',
        border: 1,
        borderColor: 'divider'
      }}
    >
      {MODES.map((option) => {
        const selected = option.value === value
        const count = counts[option.value]
        return (
          <Box
            key={option.value}
            role="tab"
            aria-selected={selected}
            tabIndex={0}
            data-partition-toggle={option.value}
            data-partition-open={selected ? 'true' : 'false'}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onChange(option.value)
              }
            }}
            sx={{
              position: 'relative',
              flex: 1,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.75,
              borderRadius: '6px',
              fontSize: 12,
              fontWeight: selected ? 600 : 400,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              color: selected ? 'text.primary' : 'text.secondary',
              bgcolor: selected ? 'action.selected' : 'transparent',
              border: 1,
              borderColor: selected ? 'divider' : 'transparent',
              transition: 'background-color 120ms, color 120ms',
              '&:hover': { color: 'text.primary' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
            }}
          >
            <Box
              component="span"
              sx={{
                display: 'grid',
                placeItems: 'center',
                color: selected ? 'primary.main' : 'text.disabled'
              }}
            >
              {option.icon}
            </Box>
            <Box component="span">{i18n.t(option.label)}</Box>
            <Box
              component="span"
              data-partition-count={option.value}
              sx={{
                minWidth: 16,
                px: '5px',
                borderRadius: '999px',
                fontSize: 10.5,
                lineHeight: '15px',
                textAlign: 'center',
                bgcolor: 'action.hover',
                color: count > 0 ? 'text.secondary' : 'text.disabled'
              }}
            >
              {count}
            </Box>
            {/*
              The only thing that says which panel is on screen, kept as a hook
              for the UI scripts that used to read the folded partition headers.
            */}
            {selected ? (
              <Box
                component="span"
                aria-hidden
                data-partition-caret={option.value}
                sx={{
                  position: 'absolute',
                  bottom: 4,
                  left: '50%',
                  width: 16,
                  height: 2,
                  borderRadius: 1,
                  bgcolor: 'primary.main',
                  transform: 'translateX(-50%)'
                }}
              />
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Model connections live only in the saved profile list.
 *
 * One mode is mounted at a time and the other one is not rendered at all: a
 * profile can only belong to one kind, so showing the other mode's list next to
 * this one only invited people to fill in a form that the current pipeline
 * never reads.
 */
export function ProvidersSection({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const patchMm = (delta: Partial<Settings['multimodal']>): void =>
    patch({ multimodal: { ...settings.multimodal, ...delta } })

  const mode = settings.pipelineMode
  // Scoped to the mode on screen: a profile saved for the other pipeline never
  // runs while this one is selected, so saying "nothing is configured" next to a
  // list that could not fix it would be wrong in both directions.
  const enabled =
    mode === 'classic'
      ? profilesOf(settings, 'asr').filter((profile) => profile.enabled).length +
        profilesOf(settings, 'llm').filter((profile) => profile.enabled).length
      : profilesOf(settings, 'multimodal').filter((profile) => profile.enabled).length
  const counts: Record<Mode, number> = {
    classic: profilesOf(settings, 'asr').length + profilesOf(settings, 'llm').length,
    multimodal: profilesOf(settings, 'multimodal').length
  }

  return (
    <Stack spacing={PARTITION_GAP}>
      <Box>
        <ModeTabs value={mode} counts={counts} onChange={(value) => patch({ pipelineMode: value })} />
        <Typography
          sx={{
            fontSize: 11,
            color: 'text.secondary',
            mt: 1,
            px: 0.25,
            lineHeight: 1.55,
            overflowWrap: 'anywhere'
          }}
        >
          {mode === 'multimodal'
            ? i18n.t('音频直接交给模型，一次出结果，代价是单次时长受模型上限约束。')
            : i18n.t('先转写再润色，两次请求，成本低、两个服务可以完全不同。')}
        </Typography>
      </Box>

      {enabled === 0 && (
        <Box
          sx={{
            px: 1.75,
            py: 1.25,
            borderRadius: '10px',
            border: 1,
            borderColor: 'warning.main',
            bgcolor: 'action.hover'
          }}
        >
          <Typography
            sx={{
              fontSize: 11.5,
              color: 'text.primary',
              lineHeight: 1.65,
              overflowWrap: 'anywhere'
            }}
          >
            {i18n.t('还没有启用的配置，现在录音会直接报错。点下面「+ 新增配置」，选一个服务商、填上 API Key 就能用。')}
          </Typography>
        </Box>
      )}

      {/*
        The panel keeps the partition hooks the page always exposed, and the two
        modes never coexist: switching tabs swaps this subtree wholesale.
      */}
      <Box
        role="tabpanel"
        aria-label={mode === 'classic' ? i18n.t('传统模式配置') : i18n.t('多模态模式配置')}
        data-partition={mode}
        data-partition-body={mode}
        data-partition-open="true"
      >
        <Stack spacing={GROUP_GAP}>
          {mode === 'classic' ? (
            <>
              <SettingsGroup
                collapsible
                icon={<IconWaveMic />}
                title={i18n.t('语音转写')}
                hint={i18n.t(i18n.t('OpenAI 兼容 · /audio/transcriptions'))}
              >
                <ProviderProfiles kind="asr" settings={settings} patch={patch} />
              </SettingsGroup>

              <SettingsGroup
                collapsible
                icon={<IconBook />}
                title={i18n.t('语言模型')}
                hint={i18n.t(i18n.t('OpenAI 兼容 · /chat/completions'))}
              >
                <ProviderProfiles kind="llm" settings={settings} patch={patch} />
              </SettingsGroup>
            </>
          ) : (
            <SettingsGroup collapsible icon={<IconGlobe />} title={i18n.t('多模态模型')} hint="Gemini generateContent">
              <ProviderProfiles kind="multimodal" settings={settings} patch={patch} />
              <SettingsRow label={i18n.t('单次上限')} description={i18n.t('一次请求最多携带的音频秒数')}>
                <SettingsNumber
                  value={settings.multimodal.maxSeconds}
                  min={5}
                  max={600}
                  onChange={(next) => patchMm({ maxSeconds: next })}
                />
              </SettingsRow>
            </SettingsGroup>
          )}
        </Stack>
      </Box>

      {/*
        Sits below the provider cards rather than inside 语音转写: it is the
        alternative to a provider, not another profile in the chain, and hiding
        it inside that card would suggest the two are the same kind of thing.
      */}
      <LocalModel settings={settings} patch={patch} />

      <Typography
        sx={{
          fontSize: 11,
          color: 'text.disabled',
          lineHeight: 1.65,
          px: 0.25,
          overflowWrap: 'anywhere'
        }}
      >
        {i18n.t('提示：自建 faster-whisper 网关实现 /audio/transcriptions 就能接入；凭据只留在这台电脑上。')}
      </Typography>
    </Stack>
  )
}
