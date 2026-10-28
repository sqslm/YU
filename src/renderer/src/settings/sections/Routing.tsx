import { PagedList } from '../Pagination'
import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Popover,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  PROMPT_KINDS,
  PROMPT_KIND_HINT,
  PROMPT_KIND_LABEL,
  matchAppRule,
  pickPromptKind,
  resolvePromptCard
} from '@shared/promptLibrary'
import type { TypelessApi } from '@shared/api'
import type { AppRule, PromptKind, Settings } from '@shared/types'
import { parseMatcher } from '@shared/domain'
import { extractDomain } from '@shared/domain'
import { RULE_GROUP_ORDER, countOf, groupDefaultOpen, groupRules, withKind } from './routingView'
import { IconInfo } from './General'
import i18n from '../../i18n'

/**
 * The five categories, with the AI card spelled out — "AI 工具" is what the rule
 * means, while the bare "AI" chip elsewhere stays compact.
 */
const chipSx = {
  height: 20,
  fontSize: 10.5,
  '& .MuiChip-label': { px: 1 }
}

const panelSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: '10px',
  bgcolor: 'background.paper'
}

/**
 * Columns of one rule row: matcher, note, delete.
 *
 * The old grid had a fourth column for the per-row 归类 select. That column is
 * gone on purpose — the block the row lives in *is* the kind — which also hands
 * the matcher and note fields the width the select used to take.
 */
const RULE_GRID = 'minmax(0,1.15fr) minmax(0,1.5fr) auto'

/** Disclosure arrow for a block header. Local: `icons.tsx` carries no chevron. */
function KindChevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        transition: 'transform 140ms ease',
        transform: open ? 'rotate(90deg)' : 'none'
      }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// --- bridge ----------------------------------------------------------------

/** One row of `TypelessApi['windows']['list']`, as `src/shared/api.ts` declares it. */
type ApiWindow = Awaited<ReturnType<TypelessApi['windows']['list']>>[number]

/**
 * The declared payload plus the coordinates only the enumeration knows. They are
 * optional so a bridge that omits them still type-checks; `handle` is only used
 * as a stable React key.
 */
export type WindowRouteInfo = ApiWindow & { className?: string; handle?: string }

/** `window.api.windows`; `null` keeps the page usable before the handler exists. */
function windowsBridge(): TypelessApi['windows'] | null {
  const api = window.api as TypelessApi | undefined
  return api?.windows ?? null
}

// --- pure helpers ----------------------------------------------------------

export interface RoutingPreview {
  kind: PromptKind
  /** Which stage answered: a manual rule, the built-in table, or the fallback. */
  source: 'rule' | 'builtin' | 'fallback'
  rule: AppRule | null
}

/**
 * What the pipeline would pick for a window, and why.
 *
 * Same order as `resolvePromptKind` — manual rule, then `pickPromptKind`, then
 * plain polish — plus the evidence, which is the point of a preview field: the
 * user has to be able to tell "my new rule did this" from "the built-in table
 * happened to agree". `polish` is both the chat bucket and the fallback and the
 * hint lists are private to `@shared/promptLibrary`, so a bare polish is
 * reported as the fallback rather than guessed either way.
 */
export function previewRouting(
  rules: readonly AppRule[],
  appName: string,
  windowTitle: string
): RoutingPreview {
  const rule = matchAppRule(rules, appName, windowTitle)
  if (rule) return { kind: rule.kind, source: 'rule', rule }
  const kind = pickPromptKind(appName, windowTitle)
  return { kind, source: kind === 'polish' ? 'fallback' : 'builtin', rule: null }
}

/**
 * The most stable fragment to recognise this window by. The process name wins:
 * an Electron app keeps it while its title follows the open document, and `dsh`
 * is exactly the token the built-in table is missing. Only when Windows gives no
 * process name does the longest meaningful word of the title stand in.
 */
const BROWSER_PROCESSES = new Set([
  'chrome',
  'msedge',
  'brave',
  'firefox',
  'opera',
  'vivaldi',
  'arc',
  'chromium'
])

export function suggestMatch(candidate: Pick<WindowRouteInfo, 'title' | 'appName'>): string {
  const domain = extractDomain(candidate.title)
  const app = candidate.appName.trim()
  if (app) {
    const process = app.toLowerCase().replace(/\.exe$/, '')
    // A browser process name is the same for every tab, so it would route the
    // whole browser into one bucket; the site is what the user means.
    if (BROWSER_PROCESSES.has(process) && domain) return domain
    return process
  }
  if (domain) return domain
  const words = candidate.title
    .split(/[\s—–\-|·:：/\\()[\]{}]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3)
    .sort((a, b) => b.length - a.length)
  return (words[0] ?? candidate.title.trim()).toLowerCase().slice(0, 40)
}

/** Why a row landed in its category, in the user's words. */
function describeMatch(window: WindowRouteInfo): string {
  if (window.pinned) return i18n.t('自动路由关闭')
  if (window.matchedBy === 'rule') {
    const name = window.matchedRuleLabel || window.matchedRuleId || ''
    return name ? `规则「${name}」` : i18n.t('手动规则')
  }
  if (window.matchedBy === 'heuristic') return i18n.t('内置分类表')
  return i18n.t('兜底')
}

/** Unique id for a new rule, kept readable instead of a random uuid. */
function newRuleId(rules: readonly AppRule[]): string {
  const stamp = Date.now().toString(36)
  let id = `rule-${stamp}`
  let suffix = 1
  while (rules.some((rule) => rule.id === id)) {
    id = `rule-${stamp}-${suffix}`
    suffix += 1
  }
  return id
}

// --- rule row --------------------------------------------------------------

interface RuleRowProps {
  rule: AppRule
  onUpdate: (delta: Partial<AppRule>) => void
  onDelete: () => void
}

/**
 * One editable rule inside a block. `AppRule` has no `enabled` flag, so a rule
 * is either in the list or gone; deleting is the way to switch one off, and the
 * delete button asks once before it goes.
 *
 * There is no 归类 control here on purpose: the kind is the block the row lives
 * in, set once when the rule is created. Changing a rule's kind therefore means
 * deleting it in one block and adding it in another — a two-step the user can
 * see, instead of a select that silently relocates a row of the routing list.
 */
function RuleRow({ rule, onUpdate, onDelete }: RuleRowProps): JSX.Element {
  const [label, setLabel] = useState(rule.label ?? '')
  const [confirming, setConfirming] = useState(false)
  /** One input for both matchers: a stored site rule shows its domain. */
  const storedMatcher = (): string => rule.domain ?? rule.match
  const [match, setMatch] = useState(storedMatcher)

  // Settings can change behind this row (another window, a rule created from the
  // picker), so the drafts follow the stored values.
  useEffect(() => {
    setMatch(rule.domain ?? rule.match)
    setLabel(rule.label ?? '')
    setConfirming(false)
  }, [rule.match, rule.domain, rule.label, rule.id])

  const commitMatch = (): void => {
    const next = match.trim()
    // A blank matcher would be dropped by the settings normaliser; restore.
    if (!next) {
      setMatch(rule.domain ?? rule.match)
      return
    }
    const parsed = parseMatcher(next)
    if (!parsed.match && !parsed.domain) {
      setMatch(rule.domain ?? rule.match)
      return
    }
    const unchanged =
      parsed.match === rule.match && parsed.domain === (rule.domain ?? '')
    if (!unchanged) onUpdate({ match: parsed.match, domain: parsed.domain || undefined })
  }

  const commitLabel = (): void => {
    const next = label.trim()
    if (next !== (rule.label ?? '')) onUpdate({ label: next })
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: RULE_GRID,
        gap: 1,
        alignItems: 'center',
        px: 2,
        py: 0.75,
        borderTop: 1,
        borderColor: 'divider'
      }}
    >
      <TextField
        size="small"
        value={match}
        placeholder={i18n.t(i18n.t('dsh 或 github.com'))}
        onChange={(event) => setMatch(event.target.value)}
        onBlur={commitMatch}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        slotProps={{ input: { 'aria-label': i18n.t('关键词或域名') } }}
      />
      <TextField
        size="small"
        value={label}
        placeholder={i18n.t(i18n.t('可选备注'))}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={commitLabel}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        slotProps={{ input: { 'aria-label': i18n.t('备注') } }}
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        {confirming ? (
          <Button
            size="small"
            color="error"
            onClick={onDelete}
            sx={{ textTransform: 'none', fontSize: 11, minWidth: 0 }}
          >
            {i18n.t('确认删除')}
          </Button>
        ) : (
          <Button
            size="small"
            color="inherit"
            onClick={() => setConfirming(true)}
            sx={{ textTransform: 'none', fontSize: 11, color: 'text.disabled', minWidth: 0 }}
          >
            {i18n.t('删除')}
          </Button>
        )}
      </Box>
    </Box>
  )
}

// --- one kind's block ------------------------------------------------------

interface RuleKindBlockProps {
  kind: PromptKind
  /** Rules of this kind only, already filtered and in stored order. */
  rules: AppRule[]
  /** Name of the card the pipeline would use for this kind right now. */
  cardName: string
  open: boolean
  onToggle: () => void
  onUpdate: (id: string, delta: Partial<AppRule>) => void
  onDelete: (id: string) => void
  /** Append a rule of this block's kind; returns false when the draft was empty. */
  onCreate: (draft: { match: string; label: string }) => boolean
}

/**
 * One prompt kind's rules, as its own management block.
 *
 * The block — not the row — owns the kind. That is the whole point of the
 * split: with a per-row select the page was one list with five meanings, and
 * "which rules apply to AI?" was a question only the select could answer.
 *
 * The header is clickable and collapses the body; the default open state is
 * derived by `groupDefaultOpen` in the parent so a block that gains its first
 * rule opens itself instead of staying shut.
 */
function RuleKindBlock({
  kind,
  rules,
  cardName,
  open,
  onToggle,
  onUpdate,
  onDelete,
  onCreate
}: RuleKindBlockProps): JSX.Element {
  // The draft row lives in the block, not on the page: two kinds can be mid-add
  // at the same time, and one block's 取消 must not wipe another block's input.
  const [draft, setDraft] = useState<{ match: string; label: string } | null>(null)
  const bodyId = `routing-rules-${kind}`
  const label = i18n.t(PROMPT_KIND_LABEL[kind])

  const startDraft = (): void => {
    // Opening the draft inside a collapsed block would hide the very row the
    // click created, so reveal the block first.
    if (!open) onToggle()
    setDraft({ match: '', label: '' })
  }

  const saveDraft = (): void => {
    if (!draft) return
    if (onCreate(draft)) setDraft(null)
  }

  return (
    <Box sx={panelSx}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 2, py: 1.25, flexWrap: 'wrap' }}>
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${label} 归类规则，${rules.length} 条，点击${open ? i18n.t('收起') : i18n.t('展开')}`}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onToggle()
            }
          }}
          sx={{
            flex: '1 1 240px',
            minWidth: 0,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 0.875,
            py: 0.125,
            border: 0,
            bgcolor: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '8px',
            '&:hover .kind-title': { color: 'primary.main' },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2
            }
          }}
        >
          <Box component="span" sx={{ display: 'flex', mt: '3px', color: 'text.secondary' }}>
            <KindChevron open={open} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
              <Typography className="kind-title" sx={{ fontSize: 13, fontWeight: 500 }}>
                {label}
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>{i18n.t('{{n}} 条', { n: rules.length })}</Typography>
            </Box>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.5, mt: 0.125 }}>
              {i18n.t(PROMPT_KIND_HINT[kind])}
            </Typography>
          </Box>
        </Box>

        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flex: '0 0 auto', mt: 0.25 }}>
          <Tooltip title={i18n.t('这一类现在用的卡片：{{name}}', { name: cardName })}>
            <Chip
              size="small"
              variant="outlined"
              sx={{
                ...chipSx,
                maxWidth: 200,
                '& .MuiChip-label': { px: 1, overflow: 'hidden', textOverflow: 'ellipsis' }
              }}
              label={i18n.t('卡片 {{name}}', { name: cardName })}
            />
          </Tooltip>
          <Button
            size="small"
            variant="outlined"
            onClick={startDraft}
            sx={{ textTransform: 'none', fontSize: 11.5, py: 0.25, whiteSpace: 'nowrap' }}
          >
            {i18n.t('新增规则')}
          </Button>
        </Stack>
      </Box>

      <Collapse in={open} unmountOnExit>
        <Box id={bodyId}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: RULE_GRID,
              gap: 1,
              px: 2,
              pt: 0.75,
              pb: 0.25,
              borderTop: 1,
              borderColor: 'divider',
              '& span': { fontSize: 10.5, color: 'text.disabled' }
            }}
          >
            <span>{i18n.t(i18n.t('关键词 / 域名'))}</span>
            <span>{i18n.t(i18n.t('备注'))}</span>
            <span />
          </Box>

          {rules.length === 0 && !draft && (
            <Box sx={{ px: 2, pb: 1.75 }}>
              <Typography sx={{ fontSize: 11.5, color: 'text.disabled', lineHeight: 1.6 }}>
                {i18n.t('还没有「{{label}}」的规则。点上面的「新增规则」，第一格填应用名片段', { label })}
                <Box component="code" sx={{ mx: 0.5, fontSize: 11 }}>
                  dsh
                </Box>
                {i18n.t('或域名')}
                <Box component="code" sx={{ mx: 0.5, fontSize: 11 }}>
                  github.com
                </Box>
                {i18n.t('（也认')}
                <Box component="code" sx={{ mx: 0.5, fontSize: 11 }}>
                  *.example.com
                </Box>
                {i18n.t('），域名规则优先于关键词。')}
              </Typography>
            </Box>
          )}

          <PagedList name="Routing-rules">{rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onUpdate={(delta) => onUpdate(rule.id, delta)}
              onDelete={() => onDelete(rule.id)}
            />
          ))}</PagedList>

          {draft && (
            <Box
              sx={{
                px: 2,
                py: 1,
                borderTop: 1,
                borderColor: 'divider',
                bgcolor: 'action.hover'
              }}
            >
              <Box
                sx={{ display: 'grid', gridTemplateColumns: RULE_GRID, gap: 1, alignItems: 'center' }}
              >
                <TextField
                  size="small"
                  autoFocus
                  value={draft.match}
                  placeholder={i18n.t(i18n.t('dsh 或 github.com'))}
                  onChange={(event) => setDraft({ ...draft, match: event.target.value })}
                  error={draft.match.trim().length === 0}
                  helperText={draft.match.trim().length === 0 ? i18n.t('必填') : ' '}
                  slotProps={{ input: { 'aria-label': i18n.t('关键词或域名') } }}
                />
                <TextField
                  size="small"
                  value={draft.label}
                  placeholder={i18n.t(i18n.t('可选备注'))}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveDraft()
                  }}
                  helperText=" "
                  slotProps={{ input: { 'aria-label': i18n.t('备注') } }}
                />
                <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => setDraft(null)}
                    sx={{ textTransform: 'none', fontSize: 11, minWidth: 0 }}
                  >
                    {i18n.t('取消')}
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={draft.match.trim().length === 0}
                    onClick={saveDraft}
                    sx={{ textTransform: 'none', fontSize: 11, minWidth: 0 }}
                  >
                    {i18n.t('保存')}
                  </Button>
                </Box>
              </Box>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  )
}

// --- section ---------------------------------------------------------------

interface RoutingSectionProps {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}

export function RoutingSection({ settings, patch }: RoutingSectionProps): JSX.Element {
  const rules = settings.appRules

  /**
   * The card each kind would use, from the same resolver the pipeline calls, so
   * a block header cannot disagree with what a take actually gets. This also
   * replaces the old single `mainCardName`: with auto-activation off only the
   * main kind pins a card, and `resolvePromptCard` is exactly that rule.
   */
  const cardNames = useMemo(() => {
    const names = {} as Record<PromptKind, string>
    for (const kind of RULE_GROUP_ORDER) {
      names[kind] = resolvePromptCard(settings, settings.promptLibrary, kind).name
    }
    return names
  }, [settings])

  const mainCardName = cardNames[settings.mainPromptKind]

  // One group per kind, always five, in page order; the block list below is a
  // pure view of `appRules`, so nothing here duplicates the stored array.
  const groups = useMemo(() => groupRules(rules), [rules])

  // Counted through the same grouping the blocks use, so this number always
  // matches what is on screen (a rule of an unknown kind is not rendered).
  const total = RULE_GROUP_ORDER.reduce((sum, kind) => sum + countOf(rules, kind), 0)

  const saveRules = (next: AppRule[]): void => patch({ appRules: next })

  /**
   * Expand state, stored as overrides on top of `groupDefaultOpen`.
   *
   * `undefined` means "follow the derived default", which is what keeps a block
   * that gains its first rule open even though the page mounted while it was
   * empty — settings load asynchronously, so a snapshot taken at mount would
   * have collapsed every block.
   */
  const [openOverrides, setOpenOverrides] = useState<Partial<Record<PromptKind, boolean>>>({})
  const setOpen = (kind: PromptKind, open: boolean): void =>
    setOpenOverrides((prev) => ({ ...prev, [kind]: open }))

  /**
   * Append one rule to the single shared `appRules` list.
   *
   * The caller decides `kind` (a block's "+ 新增规则", or the window picker),
   * and the write path stays `patch({ appRules: next })`: routing priority is
   * still the array order, the five blocks are only a view of it.
   */
  const addRule = (draft: { match: string; label: string }, kind: PromptKind): AppRule | null => {
    // The single input accepts a keyword or a site; the split is decided here so
    // the stored rule carries whichever matcher the pipeline looks for.
    const parsed = parseMatcher(draft.match)
    if (!parsed.match && !parsed.domain) return null
    const label = draft.label.trim()
    const rule: AppRule = withKind(
      {
        id: newRuleId(rules),
        match: parsed.match,
        ...(parsed.domain ? { domain: parsed.domain } : {}),
        ...(label ? { label } : {})
      },
      kind
    )
    saveRules([...rules, rule])
    return rule
  }

  /** Edit one rule in place; `kind` is not part of the delta a row can send. */
  const updateRule = (id: string, delta: Partial<AppRule>): void =>
    saveRules(rules.map((rule) => (rule.id === id ? { ...rule, ...delta } : rule)))

  /** Delete exactly one rule id; the other four blocks keep every rule of theirs. */
  const deleteRule = (id: string): void => saveRules(rules.filter((rule) => rule.id !== id))

  // --- picker -------------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [windows, setWindows] = useState<WindowRouteInfo[] | null>(null)
  const [pickerError, setPickerError] = useState('')
  const [selected, setSelected] = useState<WindowRouteInfo | null>(null)
  const [candidate, setCandidate] = useState<{ match: string; kind: PromptKind; label: string } | null>(
    null
  )
  const [created, setCreated] = useState<AppRule | null>(null)

  const openPicker = async (): Promise<void> => {
    setPickerOpen(true)
    setSelected(null)
    setCandidate(null)
    setCreated(null)
    setPickerError('')

    const bridge = windowsBridge()
    if (!bridge) {
      setWindows(null)
      setPickerError(i18n.t('暂时无法读取窗口列表，请稍后重试。'))
      return
    }

    setLoading(true)
    try {
      setWindows(await bridge.list())
    } catch (error) {
      setWindows(null)
      setPickerError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const chooseWindow = (window: WindowRouteInfo): void => {
    setSelected(window)
    setCandidate({ match: suggestMatch(window), kind: window.matchedKind, label: window.title })
  }

  const saveCandidate = (): void => {
    if (!candidate) return
    const rule = addRule(candidate, candidate.kind)
    if (!rule) return
    // Created from the picker, not from a block: reveal the block it landed in,
    // otherwise "已保存" points at a rule the user cannot see.
    setOpen(rule.kind, true)
    setCreated(rule)
    setCandidate(null)
    setSelected(null)
  }

  /** Would the rule just created also match this row? */
  const hitByCreated = (window: WindowRouteInfo): boolean =>
    created ? matchAppRule([created], window.appName, window.title) !== null : false

  // --- preview ------------------------------------------------------------
  const [probeApp, setProbeApp] = useState('')
  const [probeTitle, setProbeTitle] = useState('')
  const preview = useMemo(
    () => previewRouting(rules, probeApp, probeTitle),
    [rules, probeApp, probeTitle]
  )

  const probeActive = probeApp.trim() !== '' || probeTitle.trim() !== ''
  const previewSource =
    preview.source === 'rule' && preview.rule
      ? i18n.t('命中手动规则「{{rule}}」', { rule: preview.rule.match })
      : preview.source === 'builtin'
        ? i18n.t('命中内置分类表')
        : i18n.t('内置分类表没有更具体的分类，落到兜底润色')

  const unrecognised = windows?.filter((window) => window.matchedBy === 'fallback' && !window.pinned)

  // --- routing-order explainer ---------------------------------------------
  /** Anchor for the header "i" button; the explanation itself lives in a Popover. */
  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null)
  const infoOpen = Boolean(infoAnchor)

  return (
    <Stack spacing={3}>
      {/* 1. how the routing decision is made --------------------------------- */}
      <Box sx={panelSx}>
        <Box sx={{ px: 2, py: 1.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{i18n.t(i18n.t('应用匹配'))}</Typography>
            <Chip
              size="small"
              sx={chipSx}
              color={settings.autoActivatePrompts ? 'success' : 'warning'}
              label={settings.autoActivatePrompts ? i18n.t('自动路由 开') : i18n.t('自动路由 关')}
            />
            {!settings.autoActivatePrompts && <>
            <Chip
              size="small"
              sx={chipSx}
              variant="outlined"
              label={i18n.t('主模式 {{kind}}', { kind: i18n.t(PROMPT_KIND_LABEL[settings.mainPromptKind]) })}
            />
            <Chip size="small" sx={chipSx} variant="outlined" label={i18n.t('主卡片 {{name}}', { name: mainCardName })} />
            </>}
            <Tooltip
              title={
                infoOpen
                  ? ''
                  : i18n.t('按前台窗口挑提示词：手动规则 → 内置分类表 → 兜底润色。点开看完整说明。')
              }
              placement="top"
            >
              <IconButton
                size="small"
                aria-label={i18n.t('自动路由顺序说明')}
                aria-expanded={infoOpen ? 'true' : undefined}
                onClick={(event) => setInfoAnchor(infoOpen ? null : event.currentTarget)}
                sx={{
                  ml: 'auto',
                  flex: '0 0 auto',
                  p: 0,
                  width: 26,
                  height: 26,
                  color: 'text.disabled',
                  '&:hover': { color: 'text.primary', bgcolor: 'action.hover' }
                }}
              >
                <IconInfo size={18} />
              </IconButton>
            </Tooltip>
          </Box>
          {!settings.autoActivatePrompts && (
            <Alert
              severity="warning"
              sx={{ mt: 1.25, fontSize: 11.5, py: 0.25, borderRadius: '8px' }}
            >
              {i18n.t('自动路由已关闭：所有窗口固定用「{{kind}}」+ 主卡片，下面的规则和内置分类表都不参与。要按窗口分类，先去「提示词」页打开自动路由。', { kind: i18n.t(PROMPT_KIND_LABEL[settings.mainPromptKind]) })}
            </Alert>
          )}
        </Box>

        <Popover
          open={infoOpen}
          anchorEl={infoAnchor}
          onClose={() => setInfoAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{
            paper: {
              sx: {
                mt: 0.75,
                py: 1.5,
                pl: 1.75,
                pr: 2.25,
                maxWidth: 340,
                bgcolor: 'background.paper',
                border: 1,
                borderColor: 'divider',
                borderRadius: '8px',
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'text.secondary'
              }
            }
          }}
        >
          <Box
            component="ol"
            sx={{
              m: 0,
              pl: 2,
              '& li': { fontSize: 11.5, lineHeight: 1.6 },
              '& li + li': { mt: 0.75 },
              '& b': { color: 'text.primary', fontWeight: 500 }
            }}
          >
            <li>
              <b>{i18n.t(i18n.t('手动规则优先'))}</b>：从上往下第一条命中的生效，忽略大小写，匹配「进程名 + 窗口标题」。
            </li>
            <li>
              <b>{i18n.t(i18n.t('其次看内置分类表'))}</b>：AI 开发工具 / 终端 → AI，邮件客户端 → 邮件，Office / Notion →
              {i18n.t('文档，微信 / QQ / Slack → 润色。')}
            </li>
            <li>
              <b>{i18n.t(i18n.t('都没命中 → 润色'))}</b>。想让 DSH 这类自建 Electron 应用进 AI，加一条 `dsh → AI 工具` 即可。
            </li>
          </Box>
        </Popover>
      </Box>

      {/* 2. one management block per prompt kind ---------------------------- */}
      {/*
        The picker stays at page level because it can create a rule of any kind:
        it belongs to no single block. Rendered as a bare row instead of a panel
        so the five blocks below stay the only panels under the header.
      */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 0.25,
          flexWrap: 'wrap'
        }}
      >
        <Typography sx={{ fontSize: 12.5, fontWeight: 500 }}>{i18n.t(i18n.t('手动归类规则'))}</Typography>
        <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
          {total > 0 ? `共 ${total} 条` : i18n.t('还没有规则')}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={i18n.t('列出所有可见窗口，一眼看出哪个没被识别；选中一行直接生成规则')}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => void openPicker()}
            sx={{ textTransform: 'none', fontSize: 11.5, py: 0.25 }}
          >
            {i18n.t('拾取当前窗口')}
          </Button>
        </Tooltip>
      </Box>

      {/*
        Five blocks, same page, fixed order. Each one filters `appRules` by its
        own kind and appends back into the same array, so "manage one kind" and
        "one routing list" stay the same data rather than two sources of truth.
      */}
      {groups.map((group) => {
        const open = openOverrides[group.kind] ?? groupDefaultOpen(group)
        return (
          <RuleKindBlock
            key={group.kind}
            kind={group.kind}
            rules={group.rules}
            cardName={cardNames[group.kind]}
            open={open}
            onToggle={() => setOpen(group.kind, !open)}
            onUpdate={updateRule}
            onDelete={deleteRule}
            onCreate={(draft) => addRule(draft, group.kind) !== null}
          />
        )
      })}

      {/* 3. live preview ------------------------------------------------------ */}
      <Box sx={panelSx}>
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{i18n.t(i18n.t('测试窗口'))}</Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25, mb: 1, lineHeight: 1.6 }}>
            {i18n.t('输入进程名或窗口标题，预览匹配结果，不会修改设置。')}
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: '180px minmax(0,1fr)', gap: 1 }}>
            <TextField
              size="small"
              label={i18n.t('进程名')}
              placeholder={i18n.t(i18n.t('dsh 或 github.com'))}
              value={probeApp}
              onChange={(event) => setProbeApp(event.target.value)}
            />
            <TextField
              size="small"
              label={i18n.t('窗口标题')}
              placeholder={i18n.t(i18n.t('DeepSeek Harness — 对话'))}
              value={probeTitle}
              onChange={(event) => setProbeTitle(event.target.value)}
            />
          </Box>
          <Box sx={{ mt: 1.25, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t(i18n.t('会归类为'))}</Typography>
            {probeActive ? (
              <>
                <Chip
                  size="small"
                  sx={chipSx}
                  color={preview.source === 'rule' ? 'primary' : 'default'}
                  variant={preview.source === 'rule' ? 'filled' : 'outlined'}
                  label={i18n.t(PROMPT_KIND_LABEL[preview.kind])}
                />
                <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>{previewSource}</Typography>
              </>
            ) : (
              <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                {i18n.t('在上面输入一段进程名或标题')}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      {/* picker dialog -------------------------------------------------------- */}
      <Dialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        maxWidth="md"
        fullWidth
        slotProps={{
          paper: {
            sx: { borderRadius: '12px', bgcolor: 'background.default', height: 'min(560px, 86vh)' }
          }
        }}
      >
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600, pb: 0.5 }}>{i18n.t(i18n.t('当前打开的窗口'))}</DialogTitle>
        <DialogContent sx={{ pt: '4px !important' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 0.5, rowGap: 0.25, mb: 1 }}>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
              {i18n.t('预览与录音使用相同的匹配规则。')}
            </Typography>
            <Chip size="small" sx={chipSx} color="error" label={i18n.t('未识别')} />
            <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
              {i18n.t('表示内置分类表没有更具体的分类、最终落到兜底润色——这正是需要补一条规则的窗口。')}
            </Typography>
            {unrecognised && unrecognised.length > 0 && (
              <Typography sx={{ fontSize: 11, color: 'error.main' }}>
                {i18n.t('本次有 {{n}} 个未识别窗口。', { n: unrecognised.length })}
              </Typography>
            )}
          </Box>

          {loading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!loading && pickerError && (
            <Alert severity="info" sx={{ fontSize: 11.5, borderRadius: '8px' }}>
              {pickerError}
            </Alert>
          )}

          {!loading && !pickerError && windows && windows.length === 0 && (
            <Typography sx={{ fontSize: 11.5, color: 'text.disabled', py: 2 }}>
              {i18n.t('没有枚举到可见窗口。')}
            </Typography>
          )}

          {!loading && !pickerError && windows && windows.length > 0 && (
            <Table
              size="small"
              stickyHeader
              sx={{ '& td, & th': { py: 0.65, px: 1, borderColor: 'divider' } }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 10.5, color: 'text.disabled' }}>{i18n.t(i18n.t('窗口'))}</TableCell>
                  <TableCell sx={{ fontSize: 10.5, color: 'text.disabled' }}>{i18n.t(i18n.t('当前归类'))}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                    {i18n.t('操作')}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <PagedList name="Routing-windows">{windows.map((window, index) => {
                  const hit = hitByCreated(window)
                  return (
                    <TableRow
                      key={`${window.handle ?? window.pid}-${index}`}
                      hover
                      selected={hit}
                      onClick={() => chooseWindow(window)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell sx={{ maxWidth: 300 }}>
                        <Typography
                          sx={{
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                        >
                          {window.title || i18n.t('（无标题）')}
                        </Typography>
                        <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                          {window.appName || i18n.t('未知进程')} · pid {window.pid}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
                          <Chip
                            size="small"
                            sx={chipSx}
                            color={window.matchedBy === 'rule' ? 'primary' : 'default'}
                            variant={window.matchedBy === 'rule' ? 'filled' : 'outlined'}
                            label={i18n.t(PROMPT_KIND_LABEL[window.matchedKind])}
                          />
                          {window.matchedBy === 'fallback' && !window.pinned && (
                            <Chip size="small" sx={chipSx} color="error" label={i18n.t('未识别')} />
                          )}
                          {window.pinned && (
                            <Chip size="small" sx={chipSx} color="warning" label={i18n.t('固定主模式')} />
                          )}
                          <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                            {describeMatch(window)}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
                          {hit && (
                            <Chip size="small" sx={chipSx} color="success" label={i18n.t('这条规则会命中它')} />
                          )}
                          <Button
                            size="small"
                            sx={{ textTransform: 'none', fontSize: 11, minWidth: 0 }}
                            onClick={(event) => {
                              event.stopPropagation()
                              chooseWindow(window)
                            }}
                          >
                            {i18n.t('用它新建规则')}
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  )
                })}</PagedList>
              </TableBody>
            </Table>
          )}

          {selected && candidate && (
            <Box
              sx={{
                mt: 1.5,
                pt: 1.25,
                borderTop: 1,
                borderColor: 'divider',
                position: 'sticky',
                bottom: 0,
                bgcolor: 'background.default'
              }}
            >
              <Typography sx={{ fontSize: 12, mb: 0.75 }}>
                为「{selected.title || selected.appName || i18n.t('当前窗口')}」新建规则
              </Typography>
              <Box
                sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 130px minmax(0,1.2fr)', gap: 1 }}
              >
                <TextField
                  size="small"
                  label={i18n.t('匹配关键词')}
                  value={candidate.match}
                  onChange={(event) => setCandidate({ ...candidate, match: event.target.value })}
                  error={candidate.match.trim().length === 0}
                  helperText={candidate.match.trim().length === 0 ? i18n.t('必填') : ' '}
                />
                <TextField
                  select
                  size="small"
                  label={i18n.t('归为')}
                  value={candidate.kind}
                  onChange={(event) =>
                    setCandidate({ ...candidate, kind: event.target.value as PromptKind })
                  }
                  helperText=" "
                >
                  {PROMPT_KINDS.map((kind) => (
                    <MenuItem key={kind} value={kind}>
                      {i18n.t(PROMPT_KIND_LABEL[kind])}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  label={i18n.t('备注（存完整标题）')}
                  value={candidate.label}
                  onChange={(event) => setCandidate({ ...candidate, label: event.target.value })}
                  helperText=" "
                />
              </Box>
              <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>
                {i18n.t('建议用进程名')}
                {selected.appName ? `「${selected.appName}」` : ''}
                {i18n.t('：它不会随窗口标题变化，改文档名也不会失配。')}
                {selected.matchedBy === 'fallback' && !selected.pinned && (
                  <Box component="span" sx={{ color: 'error.main' }}>
                    {i18n.t('这个窗口目前落到兜底润色，记得把「归为」改成真正想要的类别。')}
                  </Box>
                )}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 1 }}>
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    setCandidate(null)
                    setSelected(null)
                  }}
                  sx={{ textTransform: 'none', fontSize: 11.5 }}
                >
                  {i18n.t('取消')}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  disabled={candidate.match.trim().length === 0}
                  onClick={saveCandidate}
                  sx={{ textTransform: 'none', fontSize: 11.5 }}
                >
                  {i18n.t('保存规则')}
                </Button>
              </Box>
            </Box>
          )}

          {created && (
            <Alert severity="success" sx={{ mt: 1.5, fontSize: 11.5, borderRadius: '8px' }}>
              {i18n.t('已保存规则「{{rule}}」→ {{kind}}，命中的窗口已高亮。', { rule: created.match, kind: i18n.t(PROMPT_KIND_LABEL[created.kind]) })}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2, pb: 1.5 }}>
          <Button
            size="small"
            onClick={() => void openPicker()}
            disabled={loading}
            sx={{ textTransform: 'none', fontSize: 11.5 }}
          >
            {i18n.t('刷新')}
          </Button>
          <Button
            size="small"
            onClick={() => setPickerOpen(false)}
            sx={{ textTransform: 'none', fontSize: 11.5 }}
          >
            {i18n.t('关闭')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
