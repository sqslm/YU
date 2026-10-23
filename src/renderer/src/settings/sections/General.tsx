import { useEffect, useId, useState, type ReactNode } from 'react'
import { Autocomplete, Box, Button, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { MAX_TRANSLATE_TARGETS } from '@shared/defaults'
import { MicTest } from './MicTest'
// Kept on its own line so the history-retention row (REQ-05) does not restyle
// the imports the other rows already share.
import { Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Select } from '@mui/material'
import { HISTORY_RETENTIONS } from '@shared/defaults'
// Notes storage UI (data dir + migration). Own import line for the same reason
// as the row above: adding names to a shared line restyles it wholesale.
import { Alert, Chip } from '@mui/material'
import i18n from '../../i18n'

/* ------------------------------------------------------------------------- *
 * Shared settings-dialog layout kit.
 *
 * The dialog itself only owns the navigation rail and the section header, so
 * every section renders its content as "groups" of "rows". These primitives
 * live in this module because every section already imported from it (the old
 * SectionTitle did), and theme.ts belongs to another task.
 * ------------------------------------------------------------------------- */

/** Fixed width for dropdowns / short inputs sitting on the right of a row. */
export const controlSx = { width: 220 } as const
/** Wider control for URLs and other long single-line values. */
export const wideControlSx = { width: 300 } as const
/** Narrow control for numbers and short codes. */
export const narrowControlSx = { width: 120 } as const

/** Keep a number editable until blur/Enter, then save a finite integer in range. */
export function SettingsNumber({ value, min, max, step = 1, disabled = false, onChange }: {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value
    setDraft(String(next))
    if (next !== value) onChange(next)
  }
  return <TextField
    size="small"
    type="number"
    value={draft}
    disabled={disabled}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.querySelector('input')?.blur() }}
    slotProps={{ htmlInput: { min, max, step, 'aria-label': `${min}–${max}` } }}
    sx={narrowControlSx}
    helperText={`${min}–${max}`}
  />
}

function glyph(path: JSX.Element, size = 16): JSX.Element {
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
      {path}
    </svg>
  )
}

/* Group / navigation glyphs, kept local so icons.tsx stays untouched. */
export function IconUser({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" />
    </>,
    size
  )
}

export function IconSliders({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <path d="M4 7h6M14 7h6M4 12h10M18 12h2M4 17h4M12 17h8" />
      <circle cx="12" cy="7" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>,
    size
  )
}

export function IconKeyboard({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M8 14h8" />
    </>,
    size
  )
}

export function IconCpu({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2" />
    </>,
    size
  )
}

export function IconSparkle({ size }: { size?: number }): JSX.Element {
  return glyph(<path d="M12 5l1.5 4.5L18 11l-4.5 1.5L12 17l-1.5-4.5L6 11l4.5-1.5z" />, size)
}

export function IconMagnifier({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>,
    size
  )
}

export function IconInfo({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>,
    size
  )
}

export function IconClose({ size }: { size?: number }): JSX.Element {
  return glyph(<path d="M6 6l12 12M18 6L6 18" />, size)
}

export function IconGlobe({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
    </>,
    size
  )
}

export function IconWaveMic({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
    </>,
    size
  )
}

export function IconGear({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.6 7.8l1.7 1M17.7 15.2l1.7 1M4.6 16.2l1.7-1M17.7 8.8l1.7-1" />
    </>,
    size
  )
}

export function IconBolt({ size }: { size?: number }): JSX.Element {
  return glyph(<path d="M13 3 5.5 13.2H11l-1 7.8 8-10.6h-5.5z" />, size)
}

export function IconBook({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v15H6.5A1.5 1.5 0 0 0 5 20.5z" />
      <path d="M8 8h6M8 12h5" />
    </>,
    size
  )
}

export function IconFolder({ size }: { size?: number }): JSX.Element {
  return glyph(
    <path d="M4 7a1 1 0 0 1 1-1h4l1.6 2H19a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />,
    size
  )
}

export function IconCode({ size }: { size?: number }): JSX.Element {
  return glyph(<path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />, size)
}

export function IconHistory({ size }: { size?: number }): JSX.Element {
  return glyph(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.8" />
    </>,
    size
  )
}

/* ------------------------------- primitives ------------------------------- */

interface SettingsGroupProps {
  icon?: ReactNode
  title: string
  hint?: string
  children: ReactNode
  /**
   * Turns the title row into a fold control. Left undefined the card is static,
   * so every call site written before this option existed renders exactly the
   * same DOM as before.
   */
  collapsible?: boolean
  /** First paint of a collapsible card; ignored when `collapsible` is unset. */
  defaultOpen?: boolean
}

/**
 * A titled card. Direct children are separated by a hairline divider, which is
 * what gives the reference app its "one row per preference" rhythm.
 *
 * With `collapsible` the title row becomes the toggle (a 12/18px title is a
 * poor hit target on its own) and the card body is only hidden, never
 * unmounted: folding a group must not throw away a half-typed API key or which
 * profile row inside it was open.
 */
export function SettingsGroup({
  icon,
  title,
  hint,
  children,
  collapsible,
  defaultOpen = true
}: SettingsGroupProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()

  const head = (
    <>
      {icon && <Box sx={{ display: 'grid', placeItems: 'center', color: 'text.secondary' }}>{icon}</Box>}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="h3" sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: 'text.primary', m: 0 }}>
          {title}
        </Typography>
        {hint && (
          <Typography sx={{ fontSize: 11.5, lineHeight: 1.5, color: 'text.secondary', mt: 0.25, overflowWrap: 'anywhere' }}>
            {hint}
          </Typography>
        )}
      </Box>
      {collapsible && (
        <Box component="span" aria-hidden sx={{ display: 'grid', placeItems: 'center', width: 20, height: 20, color: 'text.secondary', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}>
          ▾
        </Box>
      )}
    </>
  )

  const card = (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: '10px',
        bgcolor: 'background.paper',
        // Not `hidden`: the Slider inside a group paints its value label 26px
        // above the track, i.e. outside the card, and clipping turned "10" into a
        // half-cut bubble in 搜索 → 结果条数. Nothing inside needs clipping —
        // rows have no background of their own, and the separators are borders
        // on `* + *`, so the first and last children never draw one.
        overflow: 'visible',
        '& > * + *': { borderTop: 1, borderColor: 'divider' }
      }}
    >
      {children}
    </Box>
  )

  return (
    <Box>
      {collapsible ? (
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? i18n.t('收起') : i18n.t('展开')} ${title}`}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen((value) => !value)
            }
          }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            // A folded card owns no body, so the 10px gap would hang in the
            // seam between two cards.
            mb: open ? 1.25 : 0,
            // The negative side margins pay for the padding that makes the hit
            // area comfortable, so the title keeps the optical edge of the rows
            // inside the card below it.
            ml: -0.5,
            mr: -0.5,
            pl: 0.5,
            pr: 0.5,
            py: 0.75,
            borderRadius: '8px',
            cursor: 'pointer',
            userSelect: 'none',
            transition: 'background-color 120ms',
            '&:hover': { bgcolor: 'action.hover' },
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
          }}
        >
          {head}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25, px: 0.25 }}>{head}</Box>
      )}
      {collapsible ? (
        <Box id={bodyId} sx={{ display: open ? 'block' : 'none' }}>
          {card}
        </Box>
      ) : (
        card
      )}
    </Box>
  )
}

interface SettingsRowProps {
  label: string
  description?: string
  children?: ReactNode
}

/** Label + hint on the left, a width-constrained control on the right. */
export function SettingsRow({ label, description, children }: SettingsRowProps): JSX.Element {
  const labelId = useId()
  return (
    <Box role="group" aria-labelledby={labelId} sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, py: 1.75, minHeight: 64 }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography id={labelId} sx={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4, color: 'text.primary' }}>
          {label}
        </Typography>
        {description && (
          <Typography
            // Paths like /text/chatcompletion_v2 have no break opportunity: at
            // the 780px window the text column is barely 120px wide, so they
            // would spill under the card's clipped edge without this.
            sx={{
              fontSize: 11.5,
              color: 'text.secondary',
              mt: 0.25,
              lineHeight: 1.45,
              overflowWrap: 'anywhere'
            }}
          >
            {description}
          </Typography>
        )}
      </Box>
      {children && (
        <Box
          sx={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 1
          }}
        >
          {children}
        </Box>
      )}
    </Box>
  )
}

interface SettingsFieldProps {
  label: string
  description?: string
  children: ReactNode
}

/** Stacked variant for multi-line or full-width controls. */
export function SettingsField({ label, description, children }: SettingsFieldProps): JSX.Element {
  const labelId = useId()
  return (
    <Box role="group" aria-labelledby={labelId} sx={{ px: 2, py: 1.75 }}>
      <Typography id={labelId} sx={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4, color: 'text.primary' }}>
        {label}
      </Typography>
      {description && (
        <Typography
          sx={{
            fontSize: 11.5,
            color: 'text.secondary',
            mt: 0.25,
            lineHeight: 1.45,
            overflowWrap: 'anywhere'
          }}
        >
          {description}
        </Typography>
      )}
      {/*
        The gap lives on the control, not on the description: fields without a
        description (Base URL, 模型) used to glue the input straight onto the
        label while fields with one got 8px, so two neighbours in the same body
        had different rhythm.
      */}
      <Box sx={{ mt: 1 }}>{children}</Box>
    </Box>
  )
}

/** Tinted footnote rendered as the last child of a group. */
export function SettingsHint({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Box sx={{ px: 2, py: 1.25, bgcolor: 'action.hover' }}>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  )
}

interface SegmentedOption<T extends string> {
  value: T
  label: string
}

/** Compact segmented control that reads correctly in both palettes. */
export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        p: '2px',
        gap: '2px',
        borderRadius: '8px',
        bgcolor: 'action.hover',
        border: 1,
        borderColor: 'divider'
      }}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <Box
            key={option.value}
            component="button"
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            sx={{
              px: 1.25,
              fontFamily: 'inherit',
              height: 26,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '6px',
              fontSize: 11.5,
              fontWeight: active ? 600 : 400,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              color: active ? 'text.primary' : 'text.secondary',
              bgcolor: active ? 'action.selected' : 'transparent',
              border: 1,
              borderColor: active ? 'divider' : 'transparent',
              '&:hover': { color: 'text.primary' }
            }}
          >
            {i18n.t(option.label)}
          </Box>
        )
      })}
    </Box>
  )
}

/* --------------------------------- section -------------------------------- */

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: '', label: '自动检测' }
]

/** Chromium exposes a device with id "default", so the sentinel must differ. */
const SYSTEM_DEFAULT = '__system_default__'

/**
 * Languages offered as translation targets (REQ-10). Any other code can still be
 * typed in: the field is free-solo, the list only carries the common ones.
 */
const TRANSLATE_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ru', label: 'Русский' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: 'ar', label: 'العربية' }
]

function translateLanguageLabel(code: string): string {
  return TRANSLATE_LANGUAGES.find((item) => item.value === code)?.label ?? code
}

/**
 * Chinese labels for the retention windows in `HISTORY_RETENTIONS`. The order
 * comes from that constant, not from this map, so a new window shows up in the
 * dropdown even before somebody writes its label.
 */
const RETENTION_LABELS: Record<number, string> = {
  [-1]: '永远保存',
  0: '不保存',
  86_400: '24 小时',
  604_800: '1 周',
  2_592_000: '1 个月',
  31_536_000: '1 年'
}

function retentionLabel(seconds: number): string {
  return i18n.t(RETENTION_LABELS[seconds] ?? '{{n}} 秒', { n: seconds })
}

/* ------------------------------ notes data ------------------------------- */

/**
 * Where notes (database + audio) live, and the migration flow that moves them.
 *
 * The shown path comes from the main process, not from `settings.notesDir`: an
 * empty setting only means "the app's userData folder", and turning that into a
 * real path is main's job. Keeping the state in its own component also keeps
 * three async calls and a dialog from pushing the rows above it around.
 */
function NotesDataGroup({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  /** Resolved directory + whether the user moved it; null until main answers. */
  const [info, setInfo] = useState<{ dir: string; custom: boolean } | null>(null)
  /** One-line result of the last choose/open action. */
  const [message, setMessage] = useState<string | null>(null)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [migrateTarget, setMigrateTarget] = useState('')
  const [migrating, setMigrating] = useState(false)
  /** `ok` is carried explicitly so a failure can never render as success. */
  const [migrateResult, setMigrateResult] = useState<{ ok: boolean; message: string } | null>(null)

  /** Re-reads the resolved path; main is the only place that knows it. */
  function refresh(): void {
    void window.api.notes
      .dataDir()
      .then(setInfo)
      .catch(() => setMessage(i18n.t('读取随记目录失败：主进程还没有就绪，稍后重试')))
  }

  /**
   * `patch` is optimistic but debounced 350ms before it reaches main, so a
   * read straight after it would still describe the old directory.
   */
  function refreshLater(): void {
    window.setTimeout(refresh, 450)
  }

  useEffect(() => {
    let alive = true
    window.api.notes
      .dataDir()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch(() => {
        if (alive) setMessage(i18n.t('读取随记目录失败：主进程还没有就绪，稍后重试'))
      })
    // A migration or a delete can move the directory without the settings
    // pointer changing, so follow the store instead of polling.
    const off = window.api.notes.onChanged(() => {
      if (alive) refresh()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const chooseDir = async (): Promise<void> => {
    const result = await window.api.notes.chooseDataDir()
    if (result.ok && result.dir) {
      patch({ notesDir: result.dir })
      refreshLater()
      // Switching the pointer does not move anything: say so, or the next
      // screen looks like the notes were deleted.
      setMessage(i18n.t('已切换到所选目录；已有内容不会自动搬走，需要时可点「迁移到新位置…」'))
      return
    }
    setMessage(result.message ?? i18n.t('没有选择目录，仍在使用原来的位置'))
  }

  /** Fill the migration target from the folder picker; nothing is moved yet. */
  const pickMigrateTarget = async (): Promise<void> => {
    const result = await window.api.notes.chooseDataDir()
    if (result.ok && result.dir) {
      setMigrateTarget(result.dir)
      setMigrateResult(null)
      return
    }
    setMigrateResult({ ok: false, message: result.message ?? i18n.t('没有选择目录，迁移没有开始') })
  }

  const startMigrate = async (): Promise<void> => {
    const target = migrateTarget.trim()
    if (!target) {
      setMigrateResult({ ok: false, message: i18n.t('先选择或填写目标目录') })
      return
    }
    setMigrating(true)
    setMigrateResult(null)
    try {
      const result = await window.api.notes.migrate(target)
      // `ok` is the only success signal main gives; a message on its own is
      // never read as "moved".
      setMigrateResult({
        ok: result.ok === true,
        message:
          result.message ??
          (result.ok === true
            ? i18n.t('已迁移 {{n}} 条随记到 {{target}}', { n: result.moved ?? 0, target })
            : i18n.t('迁移没有完成，随记仍保存在原来的目录'))
      })
      if (result.ok === true) {
        patch({ notesDir: target })
        refreshLater()
      }
    } catch (error) {
      setMigrateResult({
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)} · ` + i18n.t('迁移失败，随记仍保存在原来的目录')
      })
    } finally {
      setMigrating(false)
    }
  }

  /**
   * Migration is only offered from the default location: from a custom one the
   * user already has a target on disk, and "更改…" is the right control there.
   */
  const migrateAllowed = info !== null && info.custom === false && (settings.notesDir ?? '') === ''

  return (
    <>
      <SettingsGroup icon={<IconFolder />} title={i18n.t('数据')}>
        <SettingsField
          label={i18n.t('随记目录')}
          description={i18n.t('保存随记数据库和录音。更改目录不会迁移已有内容。')}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Typography
                data-notes-dir
                sx={{
                  // A Windows path has no break opportunity, and the settings
                  // column is narrow at the minimum window width.
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: 'text.primary',
                  overflowWrap: 'anywhere',
                  minWidth: 0
                }}
              >
                {info?.dir ?? i18n.t('读取中…')}
              </Typography>
              <Chip
                data-notes-dir-custom
                size="small"
                variant="outlined"
                color={info?.custom ? 'primary' : 'default'}
                label={info?.custom ? i18n.t('自定义') : i18n.t('默认')}
                sx={{ flex: '0 0 auto', height: 20, fontSize: 11 }}
              />
            </Box>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Button
                size="small"
                variant="outlined"
                data-notes-dir-choose
                onClick={() => void chooseDir()}
              >
                {i18n.t('更改…')}
              </Button>
              <Button
                size="small"
                variant="outlined"
                data-notes-dir-open
                onClick={() => void window.api.app.openDataFolder()}
              >
                {i18n.t('打开')}
              </Button>
              <Button
                size="small"
                variant="outlined"
                data-notes-dir-migrate
                disabled={!migrateAllowed}
                onClick={() => {
                  setMigrateResult(null)
                  setMigrateTarget('')
                  setMigrateOpen(true)
                }}
              >
                {i18n.t('迁移到新位置…')}
              </Button>
            </Box>

            {/*
              Only explained once main has actually answered: while the path is
              still loading `migrateAllowed` is false too, and claiming "you are
              already on a custom directory" would be a lie for one frame.
            */}
            {info !== null && !migrateAllowed && (
              <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.5 }}>
                {i18n.t('已经在用自定义目录，迁移入口只在「默认」目录下提供；想换位置直接点「更改…」。')}
              </Typography>
            )}

            {message && (
              <Typography
                sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.5, overflowWrap: 'anywhere' }}
              >
                {message}
              </Typography>
            )}
          </Box>
        </SettingsField>

        <SettingsHint>
          {i18n.t('音频、转写与分类保存在这个目录；程序本体和密钥仍在系统盘。')}
        </SettingsHint>
      </SettingsGroup>

      <Dialog
        open={migrateOpen}
        onClose={() => {
          if (!migrating) setMigrateOpen(false)
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{i18n.t('迁移数据目录')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.6 }}>
            {i18n.t('随记、录音、转写、分类与标签会先复制到新目录，逐项校验通过后才切过去；校验不过就不切换，原目录不会被删除，随时可以退回。')}
          </DialogContentText>
          <Box sx={{ mt: 2, display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <TextField
              size="small"
              fullWidth
              data-notes-migrate-target
              label={i18n.t('目标目录')}
              placeholder="D:\\Typeless\\notes"
              value={migrateTarget}
              disabled={migrating}
              onChange={(event) => {
                setMigrateTarget(event.target.value)
                setMigrateResult(null)
              }}
            />
            <Button
              size="small"
              variant="outlined"
              data-notes-migrate-pick
              disabled={migrating}
              sx={{ flex: '0 0 auto', height: 40 }}
              onClick={() => void pickMigrateTarget()}
            >
              {i18n.t('选择文件夹…')}
            </Button>
          </Box>
          {migrateResult && (
            <Alert
              severity={migrateResult.ok ? 'success' : 'error'}
              sx={{ mt: 2, fontSize: 12, '& .MuiAlert-message': { overflowWrap: 'anywhere' } }}
            >
              {migrateResult.message}
            </Alert>
          )}
          {migrateResult && !migrateResult.ok && (
            <Typography sx={{ mt: 1, fontSize: 11, color: 'warning.main', lineHeight: 1.5 }}>
              {i18n.t('迁移失败时目录不切换：旧位置里的随记仍然完整，可以重试或直接关掉。')}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={migrating} onClick={() => setMigrateOpen(false)}>
            {migrateResult ? i18n.t('关闭') : i18n.t('取消')}
          </Button>
          <Button
            variant="contained"
            data-notes-migrate-start
            disabled={migrating || migrateTarget.trim().length === 0}
            onClick={() => void startMigrate()}
          >
            {migrating ? i18n.t('迁移中…') : i18n.t('开始迁移')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export function GeneralSection({ settings, patch }: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconGlobe />} title={i18n.t('外观')}>
        <SettingsRow
          label={i18n.t('主题')}
          description={i18n.t('选择浅色、深色或跟随系统。')}
        >
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.themeMode}
            onChange={(e) => patch({ themeMode: e.target.value as Settings['themeMode'] })}
            data-theme-select
          >
            <MenuItem value="dark">{i18n.t('深色')}</MenuItem>
            <MenuItem value="light">{i18n.t('浅色')}</MenuItem>
            <MenuItem value="system">{i18n.t('跟随系统')}</MenuItem>
          </TextField>
        </SettingsRow>
        <SettingsRow
          label={i18n.t('界面语言')}
          description={i18n.t('用于设置、按钮和提示文字。')}
        >
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.uiLanguage}
            onChange={(e) => patch({ uiLanguage: e.target.value === 'en' ? 'en' : 'zh' })}
            inputProps={{ 'data-ui-language': settings.uiLanguage }}
          >
            <MenuItem value="zh">中文</MenuItem>
            <MenuItem value="en">English</MenuItem>
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('列表每页条数')} description={i18n.t('用于历史记录、随记及设置中的数据列表。')}>
          <TextField select size="small" sx={controlSx} value={settings.listPageSize} onChange={event => patch({ listPageSize: Number(event.target.value) })} inputProps={{ 'aria-label': i18n.t('每页条数') }}>
            {[10, 20, 30, 50, 100].map(size => <MenuItem key={size} value={size}>{size}</MenuItem>)}
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('在悬浮条上显示当前模式')} description={i18n.t('在悬浮条中显示听写、翻译或问答模式。')}>
          <Switch
            size="small"
            checked={settings.showModeInBar}
            onChange={(e) => patch({ showModeInBar: e.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup icon={<IconGear />} title={i18n.t('启动与反馈')}>
        <SettingsRow label={i18n.t('关闭主窗口时')} description={i18n.t('后台运行保留快捷键和提醒；退出会停止所有后台服务。')}>
          <TextField select size="small" value={settings.closeBehavior} sx={controlSx}
            inputProps={{ 'aria-label': i18n.t('关闭主窗口时') }} onChange={event => patch({ closeBehavior: event.target.value as Settings['closeBehavior'] })}>
            <MenuItem value="background">{i18n.t('保留后台运行')}</MenuItem>
            <MenuItem value="quit">{i18n.t('完全退出')}</MenuItem>
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('开机自动启动')} description={i18n.t('登录 Windows 后在后台常驻')}>
          <Switch
            size="small"
            checked={settings.launchAtStartup}
            onChange={(e) => patch({ launchAtStartup: e.target.checked })}
          />
        </SettingsRow>
        <SettingsRow
          label={i18n.t('交互音效')}
          description={i18n.t('录音开始、结束或失败时播放提示音。')}
        >
          <Switch
            size="small"
            checked={settings.playSounds}
            onChange={(e) => patch({ playSounds: e.target.checked })}
          />
        </SettingsRow>
        <SettingsRow
          label={i18n.t('提示停留时长')}
          description={i18n.t('悬浮条提示自动隐藏前的等待时间，单位为秒。')}
        >
          <SettingsNumber
            value={settings.alertHideSeconds}
            min={1}
            max={60}
            onChange={(next) => patch({ alertHideSeconds: next })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup icon={<IconHistory />} title={i18n.t('提醒')}>
        <SettingsRow label={i18n.t('普通提醒通知')} description={i18n.t('到期时通过 Windows 系统通知提示。')}>
          <Switch size="small" checked={settings.reminders.notifications} onChange={e => patch({ reminders: { ...settings.reminders, notifications: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('强提醒提示音')} description={i18n.t('强提醒待处理时，每 30 秒提示一次。')}>
          <Switch size="small" checked={settings.reminders.strongSound} onChange={e => patch({ reminders: { ...settings.reminders, strongSound: e.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('稍后提醒时长')}>
          <TextField select size="small" fullWidth={false} value={settings.reminders.snoozeMinutes} sx={{ width: 140 }}
            onChange={e => patch({ reminders: { ...settings.reminders, snoozeMinutes: Number(e.target.value) } })}>
            {[1, 5, 10, 15, 30, 60].map(n => <MenuItem key={n} value={n}>{i18n.t('{{n}} 分钟', { n })}</MenuItem>)}
          </TextField>
        </SettingsRow>
      </SettingsGroup>
    </Stack>
  )
}

export function SpeechSection({ settings, patch }: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  /** Set when the user tried to add a language past the cap (REQ-10). */
  const [translateLimitHit, setTranslateLimitHit] = useState(false)
  const translateTargets = settings.translateTargets ?? []
  const atTranslateLimit = translateTargets.length >= MAX_TRANSLATE_TARGETS

  useEffect(() => {
    type Device = { deviceId: string; label: string }
    // Labels stay blank until the bar has opened a microphone stream, so the list
    // is refreshed a few times after mount — and then only when the set of devices
    // actually changes. A timer that ran forever repainted this section every two
    // seconds for as long as the settings window stayed open.
    const POLLS = 5
    const POLL_MS = 2000
    let alive = true
    let polls = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const same = (a: Device[], b: Device[]): boolean =>
      a.length === b.length && a.every((item, i) => item.deviceId === b[i].deviceId && item.label === b[i].label)
    const load = (): void => {
      void window.api.media.devices().then((next) => {
        if (!alive) return
        setDevices((prev) => (same(prev, next) ? prev : next))
        polls += 1
        if (polls < POLLS) timer = setTimeout(load, POLL_MS)
      })
    }
    load()
    // Plugging a microphone in while settings is open still updates immediately.
    const onDeviceChange = (): void => load()
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange)
    }
  }, [])

  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconGlobe />} title={i18n.t('识别与翻译')}>

        <SettingsRow
          label={i18n.t('语音识别语言')}
          description={i18n.t('识别时使用的语言提示；自动检测适合中英混说的场景')}
        >
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.language}
            onChange={(e) => patch({ language: e.target.value })}
          >
            {LANGUAGES.map((item) => (
              <MenuItem key={item.value} value={item.value}>
                {i18n.t(item.label)}
              </MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        <SettingsField
          label={i18n.t('翻译目标语言')}
          description={i18n.t('最多选择 {{max}} 种语言，已选 {{n}} 种。', { max: MAX_TRANSLATE_TARGETS, n: translateTargets.length })}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Autocomplete
              multiple
              freeSolo
              size="small"
              disableCloseOnSelect
              options={TRANSLATE_LANGUAGES.map((item) => item.value)}
              getOptionLabel={(code) => translateLanguageLabel(code)}
              // A full selection keeps the chosen ones clickable for removal but
              // refuses anything new until one is dropped.
              getOptionDisabled={(code) => atTranslateLimit && !translateTargets.includes(code)}
              value={translateTargets}
              onChange={(_, next) => {
                const picked = next
                  .map((code) => (typeof code === 'string' ? code.trim() : ''))
                  .filter((code, index, all) => code.length > 0 && all.indexOf(code) === index)
                if (picked.length > MAX_TRANSLATE_TARGETS) {
                  setTranslateLimitHit(true)
                  return
                }
                setTranslateLimitHit(false)
                // `translateTarget` mirrors the first entry so older code paths
                // and hand-written prompt builders keep working.
                patch({ translateTargets: picked, translateTarget: picked[0] ?? '' })
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  placeholder={translateTargets.length === 0 ? i18n.t('至少选择一个语言') : ''}
                />
              )}
              fullWidth
            />
            {translateLimitHit || atTranslateLimit ? (
              <Typography sx={{ fontSize: 11, color: 'warning.main' }}>
                {i18n.t('最多 {{n}} 个目标语言', { n: MAX_TRANSLATE_TARGETS })}
              </Typography>
            ) : null}
          </Box>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup icon={<IconWaveMic />} title={i18n.t('音频')}>
        <SettingsRow label={i18n.t('录音实时字幕')} description={i18n.t('说话时分段识别并滚动显示预览，会增加语音接口调用；最终文字以完整识别为准。')}>
          <Switch size="small" data-live-captions checked={settings.liveCaptions} onChange={event => patch({ liveCaptions: event.target.checked })} />
        </SettingsRow>
        <SettingsRow
          label={i18n.t('麦克风')}
          description={
            devices.length > 0
              ? i18n.t('空闲时立即切换；录音中更改在本次结束后生效。')
              : i18n.t('默认使用系统输入设备；授权后会列出全部麦克风')
          }
        >
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.inputDeviceId || SYSTEM_DEFAULT}
            onChange={(e) =>
              patch({ inputDeviceId: e.target.value === SYSTEM_DEFAULT ? '' : e.target.value })
            }
          >
            <MenuItem value={SYSTEM_DEFAULT}>{i18n.t('系统默认')}</MenuItem>
            {devices.map((device) => (
              <MenuItem key={device.deviceId} value={device.deviceId}>
                {device.label}
              </MenuItem>
            ))}
          </TextField>
        </SettingsRow>

        <SettingsRow
          label={i18n.t('录音处理')}
          description={i18n.t('保真优先保留人声细节；环境嘈杂时可试通话降噪。声卡已有降噪时建议保真。')}
        >
          <TextField select data-audio-processing value={settings.audioProcessing}
            onChange={event => patch({ audioProcessing: event.target.value as Settings['audioProcessing'] })} sx={controlSx}>
            <MenuItem value="fidelity">{i18n.t('保真优先（推荐）')}</MenuItem>
            <MenuItem value="voice">{i18n.t('通话降噪')}</MenuItem>
          </TextField>
        </SettingsRow>

        <SettingsRow
          label={i18n.t('说话测试')}
          description={i18n.t('使用当前录音处理，最多录制 10 秒后可回听；测试音频只留在本机内存。')}
        >
          <MicTest deviceId={settings.inputDeviceId} processing={settings.audioProcessing} />
        </SettingsRow>

        <SettingsRow
          label={i18n.t('录音时静音其他声音')}
          description={i18n.t('录音时静音系统播放，结束后恢复原有状态。')}
        >
          <Switch
            size="small"
            data-mute-while-recording
            checked={settings.muteWhileRecording}
            onChange={(e) => patch({ muteWhileRecording: e.target.checked })}
          />
        </SettingsRow>

        <SettingsRow
          label={i18n.t('压缩上传（Opus）')}
          description={i18n.t('减小音频上传体积；服务不支持时自动改用 WAV。', { keySeparator: false, nsSeparator: false })}
        >
          <Switch
            size="small"
            checked={settings.asr.upload === 'opus'}
            onChange={(e) =>
              patch({ asr: { ...settings.asr, upload: e.target.checked ? 'opus' : 'wav' } })
            }
          />
        </SettingsRow>
      </SettingsGroup>
    </Stack>
  )
}

export function InputSection({ settings, patch }: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  /**
   * The blocklist is edited as free text, one name per line. The draft keeps the
   * user's own capitalisation while typing: `normalizeAppList` lowercases on save,
   * and rewriting the field under the caret mid-word is hostile.
   */
  const [appDraft, setAppDraft] = useState(() => settings.disabledApps.join('\n'))
  const commitApps = (): void => {
    const lines = appDraft
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    const normalized = lines.map((line) => line.toLowerCase().replace(/\.exe$/, ''))
    // Only write when the meaning changed: the draft is not normalised, so a
    // straight string compare would fire on every blur.
    if (normalized.join('\n') !== settings.disabledApps.join('\n')) patch({ disabledApps: lines })
  }

  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconCode />} title={i18n.t('文本插入')}>
        <SettingsRow
          label={i18n.t('文本插入方式')}
          description={i18n.t('推荐自动模式，优先通过剪贴板粘贴。')}
        >
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.insertMethod}
            onChange={(e) => patch({ insertMethod: e.target.value as Settings['insertMethod'] })}
          >
            <MenuItem value="auto">{i18n.t('自动（优先粘贴）')}</MenuItem>
            <MenuItem value="sendinput">{i18n.t('模拟键盘输入（SendInput）')}</MenuItem>
            <MenuItem value="clipboard">{i18n.t('剪贴板 + Ctrl+V')}</MenuItem>
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('换行处理')} description={i18n.t('识别结果里的换行如何插入到前台应用')}>
          <TextField
            select
            fullWidth={false}
            sx={controlSx}
            value={settings.multiline}
            onChange={(e) => patch({ multiline: e.target.value as Settings['multiline'] })}
          >
            <MenuItem value="space">{i18n.t(i18n.t('换成空格'))}</MenuItem>
            <MenuItem value="shiftEnter">{i18n.t(i18n.t('Shift + Enter 软换行'))}</MenuItem>
            <MenuItem value="keep">{i18n.t(i18n.t('直接回车'))}</MenuItem>
          </TextField>
        </SettingsRow>
        <SettingsRow label={i18n.t('粘贴后恢复剪贴板内容')} description={i18n.t('粘贴完成后还原剪贴板。仅剪贴板模式可用。')}>
          <Switch
            size="small"
            checked={settings.restoreClipboard}
            disabled={settings.insertMethod === 'sendinput'}
            onChange={(e) => patch({ restoreClipboard: e.target.checked })}
          />
        </SettingsRow>
        <SettingsRow
          label={i18n.t('保留格式（粗体、列表）')}
          description={i18n.t('在支持富文本的应用中保留粗体和列表。仅剪贴板模式可用。')}
        >
          <Switch
            size="small"
            data-rich-insert
            checked={settings.richInsert}
            disabled={settings.insertMethod === 'sendinput'}
            onChange={(e) => patch({ richInsert: e.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup icon={<IconCode />} title={i18n.t('选区处理')}>
        <SettingsRow label={i18n.t('处理结果')} description={i18n.t('选区润色和选区翻译快捷键共用此方式，不再弹出预览窗口。')}>
          <Segmented value={settings.selectionInsertMode} options={[{ value: 'replace', label: '覆盖选区' }, { value: 'append', label: '追加到末尾' }]}
            onChange={value => patch({ selectionInsertMode: value })} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup icon={<IconSliders />} title={i18n.t('听写范围')}>
        <SettingsField
          label={i18n.t('在这些应用里关闭听写')}
          description={i18n.t('每行一个进程名或窗口类名，例如 code、chrome、game；不区分大小写，可省略 .exe', { keySeparator: false, nsSeparator: false })}
        >
          <TextField
            size="small"
            multiline
            minRows={2}
            maxRows={6}
            data-disabled-apps
            fullWidth
            value={appDraft}
            placeholder={'code\nchrome'}
            onChange={(event) => setAppDraft(event.target.value)}
            onBlur={commitApps}
          />
        </SettingsField>
      </SettingsGroup>
    </Stack>
  )
}

export function StorageSection({ settings, patch }: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const [retentionConfirmOpen, setRetentionConfirmOpen] = useState(false)
  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconHistory />} title={i18n.t('历史')}>
        <SettingsRow
          label={i18n.t('历史保留期')}
          description={i18n.t('过期记录连同录音一起删除；选「不保存」立即清空历史')}
        >
          <Select
            size="small"
            sx={controlSx}
            value={settings.historyDurationSeconds}
            onChange={(e) => {
              const next = Number(e.target.value)
              // "Never keep" wipes what is already on disk, so confirm first.
              if (next === 0 && settings.historyDurationSeconds !== 0) {
                setRetentionConfirmOpen(true)
                return
              }
              patch({ historyDurationSeconds: next })
            }}
          >
            {HISTORY_RETENTIONS.map((seconds) => (
              <MenuItem key={seconds} value={seconds}>
                {retentionLabel(seconds)}
              </MenuItem>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow label={i18n.t('历史记录上限')} description={i18n.t('超出后自动删除最旧的记录')}>
          <SettingsNumber
            value={settings.historyLimit}
            min={1}
            max={100000}
            step={50}
            disabled={settings.historyDurationSeconds === 0}
            onChange={(next) => patch({ historyLimit: next })}
          />
        </SettingsRow>
      </SettingsGroup>
      <NotesDataGroup settings={settings} patch={patch} />
      <SettingsGroup icon={<IconFolder />} title={i18n.t('应用数据')}>
        <SettingsRow
          label={i18n.t('用户数据总目录')}
          description={i18n.t('打开设置、历史和日志所在的目录。')}
        >
          <Button size="small" variant="outlined" onClick={() => void window.api.app.openDataFolder()}>
            {i18n.t('打开')}
          </Button>
        </SettingsRow>
      </SettingsGroup>
      <Dialog open={retentionConfirmOpen} onClose={() => setRetentionConfirmOpen(false)}>
        <DialogTitle>{i18n.t('不保存历史记录？')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {i18n.t('确认后会立即清空现有的历史记录和对应的录音文件，之后的录音也不再写入磁盘。此操作无法撤销。')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetentionConfirmOpen(false)}>{i18n.t('取消')}</Button>
          <Button
            color="error"
            onClick={() => {
              setRetentionConfirmOpen(false)
              patch({ historyDurationSeconds: 0 })
            }}
          >
            {i18n.t('清空并关闭')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
