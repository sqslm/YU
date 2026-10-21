import { useState } from 'react'
import { Box, Button, Dialog, Slider, Stack, Switch, TextField, Typography } from '@mui/material'
import type { NamedPrompt, PromptKind } from '@shared/types'
import { builtinPromptText, isBuiltinPromptCustomized } from '@shared/promptLibrary'
import i18n from '../../i18n'

/** Same range the shared normaliser clamps to, so the slider cannot drift. */
const TEMPERATURE_MAX = 1.5
const TEMPERATURE_STEP = 0.05

/** Slider values arrive as floats; persist two decimals like the settings row. */
function roundTemperature(value: number): number {
  return Math.round(Math.min(TEMPERATURE_MAX, Math.max(0, value)) * 100) / 100
}

/** What the dialog hands back; `temperature: undefined` means "follow global". */
export interface PromptEditResult {
  name: string
  content: string
  temperature: number | undefined
}

interface PromptEditorDialogProps {
  /** Card being edited; null keeps the dialog closed. */
  card: NamedPrompt | null
  /** Task type of the card; needed to know its factory text. */
  kind: PromptKind | null
  /** Category of the card, shown as context in the title. */
  kindLabel: string
  /** `settings.polish.temperature`, shown while the card follows the global value. */
  globalTemperature: number
  onClose: () => void
  onSave: (result: PromptEditResult) => void
}

/**
 * Editing happens in a dialog rather than inline: a prompt is multi-line text,
 * and expanding a card inside the ~210px grid cell would push the whole page
 * around on every open.
 */
export function PromptEditorDialog({
  card,
  kind,
  kindLabel,
  globalTemperature,
  onClose,
  onSave
}: PromptEditorDialogProps): JSX.Element {
  return (
    <Dialog
      open={card !== null}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      // The title lives in the keyed body, so point the dialog at it by id.
      aria-labelledby="prompt-editor-title"
      slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
    >
      {/* Keyed by card id so switching cards discards the previous draft. */}
      {card && (
        <PromptEditorBody
          key={card.id}
          card={card}
          kind={kind}
          kindLabel={kindLabel}
          globalTemperature={globalTemperature}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </Dialog>
  )
}

interface PromptEditorBodyProps {
  card: NamedPrompt
  kind: PromptKind | null
  kindLabel: string
  globalTemperature: number
  onClose: () => void
  onSave: (result: PromptEditResult) => void
}

function PromptEditorBody({
  card,
  kind,
  kindLabel,
  globalTemperature,
  onClose,
  onSave
}: PromptEditorBodyProps): JSX.Element {
  const [name, setName] = useState(card.name)
  // A builtin card starts on its shipped text and is edited like any other
  // card; an empty `content` on a legacy builtin card means "程序内置文本".
  const [content, setContent] = useState(
    card.builtin && !card.content.trim() && kind ? builtinPromptText(kind) : card.content
  )
  // No stored temperature means the card inherits the global one.
  const [followGlobal, setFollowGlobal] = useState(card.temperature == null)
  const [temperature, setTemperature] = useState(card.temperature ?? globalTemperature)

  const shownTemperature = followGlobal ? globalTemperature : temperature
  const customized = kind ? isBuiltinPromptCustomized(kind, { ...card, content }) : false

  const submit = (): void => {
    // A blank label makes a card impossible to find again, so keep the old one.
    const nextName = name.trim() || card.name
    onSave({
      name: nextName,
      // Builtin cards are editable too: the saved text becomes the card's own
      // content while `builtin: true` is preserved by the caller's merge.
      content,
      temperature: followGlobal ? undefined : roundTemperature(temperature)
    })
  }

  return (
    <Stack spacing={2} sx={{ p: 2.5 }}>
      <Box>
        <Typography
          id="prompt-editor-title"
          sx={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2 }}
        >
          {i18n.t('编辑提示词')}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5 }}>
          {i18n.t('{{kind}} · 保存后立即生效', { kind: kindLabel })}
          {card.builtin ? i18n.t(' · 内置卡片同样可以改写') : ''}
        </Typography>
      </Box>

      <TextField
        label={i18n.t(i18n.t('名称'))}
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />

      <Box>
        <TextField
          label={i18n.t(i18n.t('内容'))}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          multiline
          minRows={7}
          maxRows={16}
          fullWidth
          placeholder={
            card.builtin
              ? i18n.t('这里是内置文本，可以直接改写；点「恢复默认文本」回到出厂内容')
              : i18n.t('写下这条提示词的要求，例如：去掉口头语、补全标点，不改写原意')
          }
          helperText={
            card.builtin
              ? i18n.t('这一段会原样作为 system prompt 发给模型；保存后仍标记为「内置」，可随时恢复默认文本')
              : i18n.t('原样作为 system prompt 发给模型，支持多行')
          }
        />
        {card.builtin && kind && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: -0.5 }}>
            <Button
              size="small"
              variant="text"
              disabled={!customized}
              onClick={() => setContent(builtinPromptText(kind))}
              sx={{ fontSize: 12, color: 'text.secondary' }}
            >
              {i18n.t('恢复默认文本')}
            </Button>
            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
              {customized ? i18n.t('当前内容已改写') : i18n.t('当前就是出厂文本')}
            </Typography>
          </Box>
        )}
      </Box>

      <Box>
        {/* Label and its live value: baseline, not both boxes centred. */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{i18n.t(i18n.t('温度'))}</Typography>
          <Typography
            sx={{
              fontSize: 11.5,
              lineHeight: '17px',
              color: followGlobal ? 'text.disabled' : 'text.secondary',
              fontVariantNumeric: 'tabular-nums',
              width: 40,
              textAlign: 'right'
            }}
          >
            {shownTemperature.toFixed(2)}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
          <Slider
            size="small"
            min={0}
            max={TEMPERATURE_MAX}
            step={TEMPERATURE_STEP}
            value={shownTemperature}
            disabled={followGlobal}
            onChange={(_event, value) => setTemperature(value as number)}
            aria-label={i18n.t(i18n.t('卡片温度'))}
          />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mt: 0.25 }}>
          <Switch
            size="small"
            checked={followGlobal}
            onChange={(event) => setFollowGlobal(event.target.checked)}
            slotProps={{ input: { 'aria-label': i18n.t('跟随全局') } }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 12.5, lineHeight: 1.6 }}>{i18n.t(i18n.t('跟随全局'))}</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.5 }}>
              {i18n.t('打开后这张卡片使用全局温度 {{value}}，关闭则保存自己的温度', { value: globalTemperature.toFixed(2) })}
            </Typography>
          </Box>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button variant="text" onClick={onClose} sx={{ color: 'text.secondary' }}>
          {i18n.t('取消')}
        </Button>
        <Button variant="contained" onClick={submit}>
          {i18n.t('保存')}
        </Button>
      </Box>
    </Stack>
  )
}
