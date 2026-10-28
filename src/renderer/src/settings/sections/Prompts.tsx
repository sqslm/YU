import { PagedList } from '../Pagination'
import { useMemo, useState } from 'react'
import { Box, Button, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { NamedPrompt, PromptKind, PromptLibrary, Settings } from '@shared/types'
import {
  PROMPT_KINDS,
  PROMPT_KIND_HINT,
  PROMPT_KIND_LABEL,
  builtinPrompt,
  builtinPromptText,
  newPromptId,
  normalizePromptLibrary
} from '@shared/promptLibrary'
import { NewPromptCard, PromptCard } from './PromptsCard'
import { PromptEditorDialog, type PromptEditResult } from './PromptsEditor'
import { PromptsAdvanced } from './PromptsAdvanced'
import i18n from '../../i18n'

/**
 * Block order of the settings page: AI → 润色 → 翻译 → 文档 → 邮件. `PROMPT_KINDS`
 * stays in the pipeline's own order, so the presentation order is declared here
 * instead of re-ordering the shared constant. AI leads because it is the newest
 * capability and the one most people come to this page for.
 */
const SECTION_ORDER: PromptKind[] = ['ai', 'polish', 'translate', 'document', 'email']

/**
 * Order of the "主模式" dropdown: the four dictation situations first, AI last.
 * Labels come from `PROMPT_KIND_LABEL`; AI reads "agent协作" there so it does not
 * look like a fifth writing style next to 润色/文档.
 */
const MAIN_KIND_ORDER: PromptKind[] = ['polish', 'translate', 'document', 'email', 'ai']

/**
 * Replace one kind's card list. `PromptLibrary` is a plain record over the five
 * kinds, so every write rebuilds that record instead of mutating it: the
 * settings store swaps the whole `promptLibrary` object on each patch.
 */
function withCards(library: PromptLibrary, kind: PromptKind, cards: NamedPrompt[]): PromptLibrary {
  const nextCards = {} as Record<PromptKind, NamedPrompt[]>
  for (const key of PROMPT_KINDS) nextCards[key] = key === kind ? cards : library.cards[key]
  return { cards: nextCards, active: { ...library.active } }
}

/** Point one kind at another card without touching the other four. */
function withActive(library: PromptLibrary, kind: PromptKind, id: string): PromptLibrary {
  const nextActive = {} as Record<PromptKind, string>
  for (const key of PROMPT_KINDS) nextActive[key] = key === kind ? id : library.active[key]
  return { cards: library.cards, active: nextActive }
}

/** "新提示词", "新提示词 2"… so a list with several cards stays readable. */
function nextCardName(cards: NamedPrompt[]): string {
  const base = i18n.t('新提示词')
  if (!cards.some((card) => card.name === base)) return base
  let index = 2
  while (cards.some((card) => card.name === `${base} ${index}`)) index += 1
  return `${base} ${index}`
}

export function PromptsSection({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  // The card being edited carries its own kind: five blocks share one dialog.
  const [editing, setEditing] = useState<{ kind: PromptKind; id: string } | null>(null)

  // Settings written before this flag existed are normalised to a boolean, so
  // reading it straight off `settings` is safe here.
  const autoActivate = settings.autoActivatePrompts

  // Settings written before the prompt library existed carry no value here, and
  // a hand-edited file can hold junk: normalising keeps this section renderable
  // and never drops the builtin card. It also clamps every stored temperature.
  const library = useMemo(
    () => normalizePromptLibrary(settings.promptLibrary),
    [settings.promptLibrary]
  )

  // Manual routing pair used while auto-activation is off. The card list is read
  // from the normalised library, so it matches the grid below exactly.
  const mainKind = settings.mainPromptKind
  const mainCards = library.cards[mainKind] ?? []
  // A stored id that no longer exists (card deleted, or the kind changed in
  // another window) must read as "follow the kind's active card", not as an
  // empty value MUI would flag as out of range.
  const mainCardValue = mainCards.some((card) => card.id === settings.mainPromptCardId)
    ? settings.mainPromptCardId
    : ''

  const editingCard = editing
    ? library.cards[editing.kind].find((card) => card.id === editing.id) ?? null
    : null

  const saveLibrary = (next: PromptLibrary): void => patch({ promptLibrary: next })

  const setActive = (kind: PromptKind, id: string): void =>
    saveLibrary(withActive(library, kind, id))

  const updateCard = (
    kind: PromptKind,
    id: string,
    delta: Partial<NamedPrompt>
  ): void =>
    saveLibrary(
      withCards(
        library,
        kind,
        library.cards[kind].map((card) => (card.id === id ? { ...card, ...delta } : card))
      )
    )

  /** Create an empty card in one block and jump straight into editing it. */
  const createCard = (kind: PromptKind): void => {
    const cards = library.cards[kind]
    const id = newPromptId(kind, cards)
    const card: NamedPrompt = { id, name: nextCardName(cards), content: '' }
    saveLibrary(withCards(library, kind, [...cards, card]))
    setEditing({ kind, id })
  }

  /**
   * Duplicating edits a copy, so the original keeps its id — including the
   * builtin card, which is why the copy never inherits the `builtin` flag. A
   * builtin card whose content is still empty is copied with the shipped text,
   * otherwise the copy would start blank.
   */
  const duplicateCard = (kind: PromptKind, id: string): void => {
    const cards = library.cards[kind]
    const source = cards.find((card) => card.id === id)
    if (!source) return
    const copy: NamedPrompt = {
      id: newPromptId(kind, cards),
      name: i18n.t('{{name}} 副本', { name: source.name }),
      content: source.content.trim() || (source.builtin ? builtinPromptText(kind) : ''),
      ...(source.temperature == null ? {} : { temperature: source.temperature })
    }
    saveLibrary(withCards(library, kind, [...cards, copy]))
  }

  /**
   * Deleting the card in use must not leave a dangling active id behind. The
   * builtin card is deletable now, so the fallback is "first surviving card" and
   * `''` for an emptied block — `activePrompt` then falls back to the shipped
   * builtin text, and the UI shows the empty state instead of a blank grid.
   */
  const deleteCard = (kind: PromptKind, id: string): void => {
    const next = library.cards[kind].filter((card) => card.id !== id)
    let nextLibrary = withCards(library, kind, next)
    if (library.active[kind] === id) {
      nextLibrary = withActive(nextLibrary, kind, next[0]?.id ?? '')
    }
    saveLibrary(nextLibrary)
    if (editing?.kind === kind && editing.id === id) setEditing(null)
  }

  /** Put the shipped builtin card back after it was deleted, and select it. */
  const restoreBuiltinCard = (kind: PromptKind): void => {
    const cards = library.cards[kind]
    if (cards.some((card) => card.builtin)) return
    const restored = builtinPrompt(kind)
    saveLibrary(withActive(withCards(library, kind, [restored, ...cards]), kind, restored.id))
  }

  const applyEdit = (result: PromptEditResult): void => {
    if (!editing) return
    updateCard(editing.kind, editing.id, result)
    setEditing(null)
  }

  return (
    <Stack spacing={3}>
      {/*
        Auto-activation lives above the blocks because it decides which block's
        active card the pipeline actually uses. The hint text is rendered from
        the same boolean as the switch, and the two dropdowns below it are the
        manual alternative: one main kind + one main card for every window.
      */}
      <Box
        sx={{
          px: 2,
          py: 1.5,
          border: 1,
          borderColor: 'divider',
          borderRadius: '10px',
          bgcolor: 'background.paper'
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              sx={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, color: 'text.primary' }}
            >
              {i18n.t('自动路由')}
            </Typography>
            <Typography
              sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25, lineHeight: 1.45 }}
            >
              {autoActivate
                ? i18n.t('根据当前应用自动选择提示词。')
                : i18n.t('所有应用使用下方指定的模式和提示词。')}
            </Typography>
          </Box>
          <Switch
            size="small"
            checked={autoActivate}
            onChange={(e) => patch({ autoActivatePrompts: e.target.checked })}
            slotProps={{ input: { 'aria-label': i18n.t('自动路由提示词') } }}
            sx={{ mt: -0.25 }}
          />
        </Box>

        {!autoActivate && (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 1.25,
              mt: 1.5
            }}
          >
            <TextField
              select
              size="small"
              label={i18n.t('主模式')}
              value={mainKind}
              disabled={autoActivate}
              onChange={(event) => {
                // A card id from the old kind would dangle, so reset the pair.
                patch({ mainPromptKind: event.target.value as PromptKind, mainPromptCardId: '' })
              }}
              helperText={i18n.t(i18n.t('所有窗口都按这个类型出提示词'))}
              slotProps={{ inputLabel: { shrink: true } }}
            >
              {MAIN_KIND_ORDER.map((kind) => (
                <MenuItem key={kind} value={kind}>
                  {i18n.t(PROMPT_KIND_LABEL[kind])}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              size="small"
              label={i18n.t('主卡片')}
              // A stored id that no longer resolves reads as the follow option
              // instead of rendering an empty value (which MUI warns about).
              value={mainCardValue}
              disabled={autoActivate}
              onChange={(event) => patch({ mainPromptCardId: event.target.value })}
              helperText={
                mainCardValue
                  ? i18n.t('固定用这张卡，类型内切换激活卡不影响它')
                  : i18n.t('跟随该类型当前激活的那张卡')
              }
              slotProps={{ inputLabel: { shrink: true } }}
            >
              <MenuItem value="">{i18n.t(i18n.t('跟随该类型的当前卡片'))}</MenuItem>
              {mainCards.map((card) => (
                <MenuItem key={card.id} value={card.id}>
                  {card.name}
                </MenuItem>
              ))}
            </TextField>
          </Box>
        )}
      </Box>

      {SECTION_ORDER.map((kind) => {
        const cards = library.cards[kind]
        const activeId = library.active[kind]
        const hasBuiltin = cards.some((card) => card.builtin)
        return (
          <Box key={kind}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.35 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.primary' }}>
                {i18n.t(PROMPT_KIND_LABEL[kind])}
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                {i18n.t('{{n}} 张', { n: cards.length })}
              </Typography>
              {/* Deleted builtin: one click puts the shipped card back. */}
              {!hasBuiltin && (
                <Button
                  size="small"
                  variant="text"
                  onClick={() => restoreBuiltinCard(kind)}
                  sx={{
                    ml: 'auto',
                    minWidth: 0,
                    px: 0.75,
                    py: 0,
                    fontSize: 11.5,
                    color: 'text.secondary',
                    '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }
                  }}
                >
                  {i18n.t('恢复内置提示词')}
                </Button>
              )}
            </Box>
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mb: 1.25, lineHeight: 1.5 }}>
              {i18n.t(PROMPT_KIND_HINT[kind])}
            </Typography>

            <Box
              sx={{
                display: 'grid',
                // Three per row in the 900px settings sheet; narrow windows keep
                // two so the footer buttons never stack.
                gridTemplateColumns: {
                  xs: 'repeat(2, minmax(0, 1fr))',
                  lg: 'repeat(3, minmax(0, 1fr))'
                },
                gap: 1.25
              }}
            >
              <PagedList name="Prompts-cards" revealKey={activeId}>{cards.map((card) => (
                <PromptCard
                  key={card.id}
                  card={card}
                  kind={kind}
                  kindLabel={i18n.t(PROMPT_KIND_LABEL[kind])}
                  active={card.id === activeId}
                  onEdit={() => setEditing({ kind, id: card.id })}
                  onUse={() => setActive(kind, card.id)}
                  onCopy={() => duplicateCard(kind, card.id)}
                  onDelete={() => deleteCard(kind, card.id)}
                />
              ))}</PagedList>
              {cards.length === 0 ? (
                // Deleting every card of a kind is allowed; this keeps the block
                // usable instead of leaving a header above an empty grid.
                <Box
                  sx={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0.75,
                    px: 2,
                    py: 3,
                    border: '1px dashed',
                    borderColor: 'divider',
                    borderRadius: '13px',
                    textAlign: 'center'
                  }}
                >
                  <Typography sx={{ fontSize: 13, fontWeight: 500, color: 'text.primary' }}>
                    {i18n.t('这一类的提示词已经全部删掉')}
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.5 }}>
                    {i18n.t('听写时会自动回落到内置文本。新建一张自己的卡片，或者恢复内置提示词。')}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
                    <Button size="small" variant="contained" onClick={() => createCard(kind)}>
                      {i18n.t('新建卡片')}
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => restoreBuiltinCard(kind)}
                    >
                      {i18n.t('恢复内置提示词')}
                    </Button>
                  </Box>
                </Box>
              ) : (
                <NewPromptCard
                  kindLabel={i18n.t(PROMPT_KIND_LABEL[kind])}
                  onCreate={() => createCard(kind)}
                />
              )}
            </Box>
          </Box>
        )
      })}

      <PromptsAdvanced settings={settings} patch={patch} />

      <PromptEditorDialog
        card={editingCard}
        kind={editing ? editing.kind : null}
        kindLabel={editing ? i18n.t(PROMPT_KIND_LABEL[editing.kind]) : ''}
        globalTemperature={settings.polish.temperature}
        onClose={() => setEditing(null)}
        onSave={applyEdit}
      />
    </Stack>
  )
}
