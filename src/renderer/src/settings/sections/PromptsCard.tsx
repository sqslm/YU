import type { MouseEvent } from 'react'
import { Box, Button, Chip, IconButton, Tooltip, Typography } from '@mui/material'
import type { NamedPrompt, PromptKind } from '@shared/types'
import { isBuiltinPromptCustomized } from '@shared/promptLibrary'
import { IconCheck, IconPlus } from '../icons'
import i18n from '../../i18n'

/**
 * The pencil stays local: `icons.tsx` is shared with the other sections, and a
 * one-off glyph does not justify a new export there.
 */
function IconPencil({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 19.5h4L19 9l-4-4L4.5 15.5z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  )
}

/** Shared pill styling so the category, builtin and temperature chips align. */
const chipSx = {
  height: 18,
  fontSize: 10,
  bgcolor: 'action.hover',
  color: 'text.secondary',
  border: 1,
  borderColor: 'divider',
  '& .MuiChip-label': { px: 0.75 }
}

/** Text-only footer buttons; the cards are ~210px wide, so they stay tight. */
const actionSx = {
  minWidth: 0,
  height: 20,
  px: 0.75,
  py: 0,
  fontSize: 11.5,
  fontWeight: 500,
  color: 'text.secondary',
  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
}

/**
 * Inline buttons live inside the clickable card, so every one of them has to
 * stop the click from also opening the editor.
 */
function buttonAction(fn: () => void) {
  return (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation()
    fn()
  }
}

interface PromptCardProps {
  card: NamedPrompt
  /** Task type of the card; used to tell a rewritten builtin from the shipped one. */
  kind: PromptKind
  /** Category label shown as the first chip, e.g. 润色. */
  kindLabel: string
  /** True when `library.active[kind]` points at this card. */
  active: boolean
  onEdit: () => void
  onUse: () => void
  onCopy: () => void
  onDelete: () => void
}

/** Shown only for a builtin card whose content is still empty (legacy settings). */
const BUILTIN_EXPLANATION = i18n.t('使用程序内置文本（未改写），点击可编辑')

/**
 * One prompt card in the four-block grid. Everything a user can do to a card
 * is either the surface click (edit) or a footer button, which mirrors the
 * reference app's "style pack" tiles.
 *
 * Builtin cards are ordinary cards now: their shipped text is editable, so they
 * show a content preview like the rest, and they can be deleted. A deleted
 * builtin is recoverable from the block header or from the empty state.
 */
export function PromptCard({
  card,
  kind,
  kindLabel,
  active,
  onEdit,
  onUse,
  onCopy,
  onDelete
}: PromptCardProps): JSX.Element {
  const summary = card.content.trim() || (card.builtin ? i18n.t(BUILTIN_EXPLANATION) : i18n.t('还没有内容，点击添加'))
  const rewritten = isBuiltinPromptCustomized(kind, card)

  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={i18n.t('编辑提示词 {{name}}', { name: card.name })}
      aria-current={active ? 'true' : undefined}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // Cards stretch to the row height, so the footer buttons line up even
        // when one description is shorter than its neighbour.
        height: '100%',
        minHeight: 156,
        p: 2,
        borderRadius: '13px',
        border: 1,
        borderColor: active ? 'primary.main' : 'divider',
        bgcolor: 'background.paper',
        cursor: 'pointer',
        transition: 'border-color .15s, background-color .15s',
        '&:hover': {
          bgcolor: 'action.hover',
          borderColor: active ? 'primary.main' : 'text.disabled'
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.3,
            color: 'text.primary',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {card.name}
        </Typography>

        {card.builtin && (
          <Chip
            size="small"
            label={i18n.t(i18n.t('内置'))}
            // Smaller than the chip row: it shares the line with the card name.
            sx={{ ...chipSx, height: 16, fontSize: 9.5, '& .MuiChip-label': { px: 0.5 } }}
          />
        )}

        <Box
          sx={{
            ml: 'auto',
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          {active && (
            // Icon-only on purpose: at three columns a card is ~200px wide, and
            // the text form of this marker truncated long names.
            <Tooltip title={i18n.t(i18n.t('当前使用的提示词'))}>
              <Box sx={{ display: 'flex', alignItems: 'center', color: 'primary.main' }}>
                <IconCheck size={12} />
              </Box>
            </Tooltip>
          )}
          <Tooltip title={i18n.t(i18n.t('编辑'))}>
            <IconButton
              size="small"
              // Distinct from the footer 编辑 button: the whole card is already a
              // button, so duplicate labels would confuse screen readers.
              aria-label={i18n.t(i18n.t('编辑提示词'))}
              onClick={buttonAction(onEdit)}
              sx={{
                width: 20,
                height: 20,
                color: 'text.disabled',
                '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
              }}
            >
              <IconPencil size={12} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Typography
        sx={{
          mt: 0.75,
          flex: 1,
          fontSize: 12,
          lineHeight: 1.5,
          color: 'text.secondary',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-word'
        }}
      >
        {summary}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mt: 1 }}>
        <Chip size="small" label={kindLabel} sx={chipSx} />
        {/* Only cards with their own temperature advertise it; the rest follow
            the global value, which the footer of the page documents. */}
        {card.temperature != null && (
          <Chip
            size="small"
            label={i18n.t('温度 {{value}}', { value: card.temperature.toFixed(2) })}
            sx={{ ...chipSx, color: 'text.primary' }}
          />
        )}
        {rewritten && (
          // A shipped builtin card starts on the factory text; the chip marks the
          // ones the user has replaced, so the block still reads at a glance.
          <Chip size="small" label={i18n.t(i18n.t('已改写'))} sx={{ ...chipSx, color: 'text.primary' }} />
        )}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          mt: 1.25,
          pt: 0.75,
          borderTop: 1,
          borderColor: 'divider'
        }}
      >
        {active ? (
          <Button size="small" disabled sx={actionSx}>
            {i18n.t('当前')}
          </Button>
        ) : (
          <Button size="small" onClick={buttonAction(onUse)} sx={actionSx}>
            {i18n.t('激活')}
          </Button>
        )}
        <Button size="small" onClick={buttonAction(onCopy)} sx={actionSx}>
          {i18n.t('复制')}
        </Button>
        <Button size="small" onClick={buttonAction(onEdit)} sx={actionSx}>
          {i18n.t('编辑')}
        </Button>
        {/* Builtin cards are deletable too; the block header offers 恢复内置提示词
            afterwards, so this is a reversible action rather than a dead end. */}
        <Button
          size="small"
          onClick={buttonAction(onDelete)}
          sx={{ ...actionSx, color: 'error.main', ml: 'auto' }}
        >
          {i18n.t('删除')}
        </Button>
      </Box>
    </Box>
  )
}

/**
 * The dashed "new card" tile that closes every grid. It is a full panel rather
 * than a text button so it reads as one more cell in the same grid.
 */
export function NewPromptCard({
  kindLabel,
  onCreate
}: {
  kindLabel: string
  onCreate: () => void
}): JSX.Element {
  return (
    <Box
      role="button"
      tabIndex={0}
      aria-label={i18n.t('在{{kind}}新建提示词', { kind: kindLabel })}
      onClick={onCreate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onCreate()
        }
      }}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
        height: '100%',
        minHeight: 156,
        p: 2,
        borderRadius: '13px',
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'transparent',
        cursor: 'pointer',
        textAlign: 'center',
        transition: 'border-color .15s, background-color .15s',
        '&:hover': { borderColor: 'text.disabled', bgcolor: 'action.hover' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2
        }
      }}
    >
      <Box
        sx={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          border: 1,
          borderColor: 'divider',
          color: 'text.secondary',
          mb: 0.25
        }}
      >
        <IconPlus size={16} />
      </Box>
      <Typography sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary' }}>
        {i18n.t('新建提示词')}
      </Typography>
      <Typography sx={{ fontSize: 11.5, color: 'text.disabled', lineHeight: 1.4 }}>
        {i18n.t('从空白提示词开始')}
      </Typography>
    </Box>
  )
}
