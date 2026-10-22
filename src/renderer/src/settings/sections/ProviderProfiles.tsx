import { useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import type { ProviderKind, ProviderProfile, Settings } from '@shared/types'
import { MAX_PROFILES } from '@shared/defaults'
import { CUSTOM_PRESET_ID, findPreset, presetsFor, presetDraft } from '@shared/providerPresets'
import { defaultVendorValues, missingVendorFields, presetVendorFields } from '@shared/providerFields'
import {
  moveProfile,
  newProfileId,
  uniqueProfileName,
  profilesOf,
  removeProfile,
  setProfileEnabled,
  upsertProfile
} from '@shared/profiles'
import { isSameOrder, reorderIds } from './providerProfilesView'
import { controlSx, SettingsField, SettingsHint, wideControlSx } from './General'
import i18n from '../../i18n'

const KIND_LABEL: Record<ProviderKind, string> = {
  asr: '语音转写',
  llm: '语言模型',
  multimodal: '多模态'
}

/** Callbacks a row needs; the parent owns the settings object and its patches. */
interface RowHandlers {
  edit: (next: ProviderProfile) => void
  toggle: (enabled: boolean) => void
  move: (delta: -1 | 1) => void
  remove: () => void
}

/** What the list is currently dragging, and which edge it would land on. */
interface ProfileDragState {
  dragId: string
  overId: string
  after: boolean
}

/** Drag wiring handed to every row; the parent owns the state and the patch. */
interface RowDrag {
  state: ProfileDragState | null
  start: (id: string) => void
  over: (id: string, after: boolean) => void
  drop: (id: string) => void
  end: () => void
}

/**
 * The one hairline a row may show: an insertion marker while dragging.
 *
 * Drawn inside the row, a few pixels in from either edge, so it reads as a line
 * between two entries instead of a border on the entry it is about to replace.
 */
const dropLine = (edge: 'before' | 'after'): Record<string, unknown> => ({
  content: '""',
  position: 'absolute',
  left: 8,
  right: 8,
  height: 2,
  borderRadius: 1,
  bgcolor: 'primary.main',
  ...(edge === 'before' ? { top: 0 } : { bottom: 0 })
})

/** One saved connection, collapsed to a single row until someone opens it. */
function ProfileRow({
  profile,
  kind,
  handlers,
  drag,
  first,
  last
}: {
  profile: ProviderProfile
  kind: ProviderKind
  handlers: RowHandlers
  drag: RowDrag
  first: boolean
  last: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text: string }>({
    busy: false,
    text: ''
  })
  const rowRef = useRef<HTMLDivElement | null>(null)
  const preset = profile.preset ? findPreset(profile.preset, kind) : undefined
  const dragging = drag.state?.dragId === profile.id
  // The row under the pointer only gets an edge when it is not the dragged one.
  const edge: 'before' | 'after' | null =
    drag.state && drag.state.dragId !== profile.id && drag.state.overId === profile.id
      ? drag.state.after
        ? 'after'
        : 'before'
      : null

  /**
   * Probes this row's own connection rather than whatever the form above holds:
   * with several saved profiles, "which one is broken" is the question that
   * matters, and a chain can hide a dead entry behind a healthy one.
   */
  const runTest = async (): Promise<void> => {
    setTest({ busy: true, text: '' })
    try {
      const result =
        kind === 'multimodal'
          ? await window.api.net.probeMultimodal({
              baseUrl: profile.baseUrl,
              apiKey: profile.apiKey,
              model: profile.model,
              extraHeaders: profile.extraHeaders
            })
          : await window.api.net.probe({
              baseUrl: profile.baseUrl,
              apiKey: profile.apiKey,
              extraHeaders: profile.extraHeaders
            })
      /*
        A passing probe only needs a verdict plus the status code it reached; a
        failing one already carries the message the user has to act on, so that
        text is shown verbatim instead of being wrapped in another sentence.
      */
      setTest({
        busy: false,
        ok: result.ok,
        text: result.ok
          ? result.status
            ? i18n.t('连接正常 · HTTP {{status}}', { status: result.status })
            : i18n.t('连接正常')
          : result.message
      })
    } catch (error) {
      setTest({
        busy: false,
        ok: false,
        text: i18n.t('调用失败：{{message}}', { message: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  /** Only a real drop from this list may reorder; stray text drags are ignored. */
  const onRowDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!drag.state) return
    event.preventDefault()
    if (drag.state.dragId === profile.id) return
    const rect = event.currentTarget.getBoundingClientRect()
    drag.over(profile.id, event.clientY > rect.top + rect.height / 2)
  }

  const onRowDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (!drag.state) return
    event.preventDefault()
    event.stopPropagation()
    drag.drop(profile.id)
  }

  return (
    <Box
      ref={rowRef}
      data-profile={profile.id}
      data-profile-row={profile.id}
      data-profile-open={open ? 'true' : 'false'}
      onDragOver={onRowDragOver}
      onDrop={onRowDrop}
      onDragEnd={drag.end}
      sx={{
        position: 'relative',
        // One hairline between entries, and only between entries: the card these
        // rows live in already draws the outer border, so a box per row would
        // stack borders two deep (this list used to draw its own cards).
        ...(last ? {} : { borderBottom: 1, borderColor: 'divider' }),
        opacity: dragging ? 0.4 : profile.enabled ? 1 : 0.55,
        transition: 'opacity 120ms',
        ...(dragging ? { outline: '1px dashed', outlineColor: 'divider', outlineOffset: '-1px' } : {}),
        ...(edge ? { borderColor: 'primary.main', '&::before': dropLine(edge) } : {})
      }}
    >
      {/*
        The 13px name and the 11px model hint are one text pair, so the row is
        baseline-aligned and every non-text item (handle, switch, chip, caret)
        opts back into centring — otherwise a differing font size on the same
        `center` axis leaves the small grey hint hanging above the name.

        Row spacing matches `SettingsRow` on every other page: 16px side padding
        and a 46px minimum, so this list lines up with the toggles in 通用.
      */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        alignItems="baseline"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={i18n.t('{{name}} 配置详情', { name: profile.name })}
        data-profile-toggle={profile.id}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((value) => !value)
          }
        }}
        sx={{
          px: 2,
          py: 1,
          minHeight: 46,
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'background-color 120ms',
          '&:hover': { bgcolor: 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
        }}
      >
        <Box
          component="span"
          data-profile-drag={profile.id}
          draggable
          title={i18n.t(i18n.t('拖动调整顺序'))}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            // A private type, not text/plain: a row dropped onto a text field
            // should never paste an id into someone's Base URL.
            event.dataTransfer.setData('application/x-typeless-profile', profile.id)
            if (rowRef.current) event.dataTransfer.setDragImage(rowRef.current, 16, 16)
            drag.start(profile.id)
          }}
          onDragEnd={drag.end}
          onClick={(event) => event.stopPropagation()}
          sx={{
            display: 'flex',
            alignItems: 'center',
            alignSelf: 'center',
            cursor: 'grab',
            color: 'text.disabled',
            '&:active': { cursor: 'grabbing' }
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 16 }} />
        </Box>
        <Switch
          size="small"
          checked={profile.enabled}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => handlers.toggle(event.target.checked)}
          sx={{ ml: -0.5, alignSelf: 'center' }}
          inputProps={{ 'aria-label': i18n.t('{{name}} 启用', { name: profile.name }) }}
        />
        {/*
          The three text items own the free width: the name gives way first, the
          model line takes whatever is left, and both clip with an ellipsis
          instead of pushing the caret off the row at the 780px window width.
        */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flex: 1 }}>
          <Typography
            sx={{ fontSize: 13, fontWeight: 500, lineHeight: '18px', minWidth: 0, flex: '0 1 auto' }}
            noWrap
          >
            {profile.name}
          </Typography>
          {preset ? (
            <Chip
              size="small"
              label={preset.name}
              sx={{
                height: 18,
                fontSize: 10.5,
                alignSelf: 'center',
                flexShrink: 0,
                maxWidth: 120,
                // A long vendor name has to shorten, not widen the row.
                '& .MuiChip-label': {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }
              }}
            />
          ) : null}
          <Typography
            sx={{
              fontSize: 11,
              lineHeight: '18px',
              color: 'text.disabled',
              minWidth: 0,
              flex: '1 1 auto'
            }}
            noWrap
          >
            {profile.model || i18n.t('未选模型')}
          </Typography>
        </Box>
        <Box
          component="span"
          aria-hidden
          sx={{
            alignSelf: 'center',
            flexShrink: 0,
            fontSize: 11,
            color: 'text.disabled',
            transition: 'transform 120ms',
            transform: open ? 'rotate(180deg)' : 'none'
          }}
        >
          ▾
        </Box>
      </Stack>
      {open ? (
        /*
          `SettingsField` owns the 16px inset every other page uses, so the
          editor adds no horizontal padding of its own — the fields line up with
          the rows of the card above and below. The hairline is the only line in
          the row and it exists to separate the summary from its form.
        */
        <Box data-profile-editor={profile.id} sx={{ borderTop: 1, borderColor: 'divider', pt: 0.25, pb: 1.25 }}>
          <SettingsField label="Base URL">
            <TextField
              size="small"
              fullWidth
              sx={wideControlSx}
              value={profile.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => handlers.edit({ ...profile, baseUrl: event.target.value })}
            />
          </SettingsField>
          <SettingsField label={i18n.t(i18n.t('模型'))}>
            <TextField
              size="small"
              fullWidth
              sx={wideControlSx}
              value={profile.model}
              onChange={(event) => handlers.edit({ ...profile, model: event.target.value })}
            />
          </SettingsField>
          <SettingsField label="API Key" description={i18n.t(i18n.t('只存在本机设置文件里'))}>
            <TextField
              size="small"
              type="password"
              fullWidth
              sx={wideControlSx}
              value={profile.apiKey}
              onChange={(event) => handlers.edit({ ...profile, apiKey: event.target.value })}
            />
          </SettingsField>
          <SettingsField label={i18n.t(i18n.t('额外请求头'))} description={i18n.t(i18n.t('每行一个 Name: Value，一般留空'))}>
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              sx={wideControlSx}
              value={profile.extraHeaders ?? ''}
              onChange={(event) => handlers.edit({ ...profile, extraHeaders: event.target.value })}
            />
          </SettingsField>
          {kind === 'asr' ? null : (
            <SettingsField
              label={i18n.t(i18n.t('请求路径'))}
              description={i18n.t(i18n.t('一般留空（默认 /chat/completions）；MiniMax 填 /text/chatcompletion_v2'))}
            >
              <TextField
                size="small"
                fullWidth
                sx={wideControlSx}
                value={profile.requestPath ?? ''}
                placeholder="chat/completions"
                onChange={(event) => handlers.edit({ ...profile, requestPath: event.target.value })}
              />
            </SettingsField>
          )}
          {/* Vendor-specific fields: the four generic ones above cannot express
              "which Azure deployment" or "which Tencent region", and hiding that
              behind a doc link is what made those providers look broken. */}
          {presetVendorFields(profile.preset).map((item) => {
            const value = profile.vendor?.[item.key] ?? ''
            const blank = item.required === true && value.trim() === ''
            return (
              <SettingsField
                key={item.key}
                label={item.required ? i18n.t('{{label}}（必填）', { label: item.label }) : item.label}
                description={item.hint}
              >
                <TextField
                  size="small"
                  fullWidth
                  sx={wideControlSx}
                  inputProps={{ 'data-vendor-field': item.key } as Record<string, string>}
                  value={value}
                  placeholder={item.placeholder}
                  error={blank}
                  onChange={(event) =>
                    handlers.edit({
                      ...profile,
                      vendor: { ...(profile.vendor ?? {}), [item.key]: event.target.value }
                    })
                  }
                />
              </SettingsField>
            )
          })}
          {missingVendorFields(profile.preset, profile.vendor).length > 0 ? (
            <SettingsHint>
              {i18n.t('还差')}
              {missingVendorFields(profile.preset, profile.vendor)
                .map((item) => `「${item.label}」`)
                .join('·')}
              {i18n.t('，填完才能调用这家服务商。')}
            </SettingsHint>
          ) : null}
          {preset?.notes ? <SettingsHint>{preset.notes}</SettingsHint> : null}
          {test.text ? (
            <Typography
              data-profile-test-result={profile.id}
              // Server messages can be long HTML-ish blobs; breaking anywhere
              // keeps them inside the card instead of widening the dialog.
              sx={{
                fontSize: 11,
                lineHeight: 1.55,
                mt: 1,
                px: 2,
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
                color: test.ok ? 'success.main' : 'error.main'
              }}
            >
              {test.text}
            </Typography>
          ) : null}
          {/* 12px of air above the actions; they wrap instead of overflowing
              the row when the window is at its 780px minimum. */}
          <Stack direction="row" spacing={1} useFlexGap sx={{ px: 2, pt: 1.5, flexWrap: 'wrap' }}>
            <Button size="small" onClick={() => void runTest()} disabled={test.busy}>
              {test.busy ? i18n.t('测试中…') : i18n.t('测试连接')}
            </Button>
            <Button size="small" data-profile-move-up={profile.id} disabled={first} onClick={() => handlers.move(-1)}>
              {i18n.t('上移')}
            </Button>
            <Button size="small" data-profile-move-down={profile.id} disabled={last} onClick={() => handlers.move(1)}>
              {i18n.t('下移')}
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button size="small" color="error" data-profile-remove={profile.id} onClick={handlers.remove}>
              {i18n.t('删除')}
            </Button>
          </Stack>
        </Box>
      ) : null}
    </Box>
  )
}

/** Saved profiles for one kind, in the order they will be tried. */
export function ProviderProfiles({
  kind,
  settings,
  patch
}: {
  kind: ProviderKind
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  // The connection fields live in state rather than derived from the preset:
  // "custom" is a preset too, and a user who picks a vendor must still be able
  // to fix the base URL (self-hosted mirrors, proxies, local ports).
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [requestPath, setRequestPath] = useState('')
  const [drag, setDrag] = useState<ProfileDragState | null>(null)
  const presets = useMemo(() => presetsFor(kind), [kind])
  const list = profilesOf(settings, kind)
  const order = list.map((profile) => profile.id)
  const preset = presetId ? presets.find((item) => item.id === presetId) : undefined

  const apply = (next: Settings): void => patch({ profiles: next.profiles, chains: next.chains })

  const openAdd = (): void => {
    setAdding(true)
    setPresetId(CUSTOM_PRESET_ID)
    setName('')
    setApiKey('')
    setBaseUrl('')
    setModel('')
    setRequestPath('')
  }

  /** Fills the form from a preset; the blank one clears everything. */
  const pickPreset = (id: string): void => {
    setPresetId(id)
    const picked = presets.find((item) => item.id === id)
    if (!picked) {
      setBaseUrl('')
      setModel('')
      setRequestPath('')
      return
    }
    const draft = presetDraft(picked)
    setBaseUrl(draft.baseUrl)
    setModel(draft.model)
    setRequestPath(draft.requestPath ?? '')
    if (!name.trim() && picked.id !== CUSTOM_PRESET_ID) setName(picked.name)
  }

  const submit = (): void => {
    const profile: ProviderProfile = {
      id: newProfileId(kind, settings.profiles ?? []),
      name: uniqueProfileName(name.trim() || preset?.name || i18n.t('我的{{kind}}', { kind: i18n.t(KIND_LABEL[kind] ?? '') }), settings.profiles ?? []),
      kind,
      preset: preset && preset.id !== CUSTOM_PRESET_ID ? preset.id : '',
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      extraHeaders: preset?.headers ?? '',
      // The adapter id is copied in, not looked up later: a profile that moves to
      // a proxy or gets renamed keeps its vendor's request shape.
      ...(preset?.asrAdapter ? { asrAdapter: preset.asrAdapter } : {}),
      ...(Object.keys(defaultVendorValues(preset?.id)).length > 0
        ? { vendor: defaultVendorValues(preset?.id) }
        : {}),
      ...(requestPath.trim() ? { requestPath: requestPath.trim() } : {}),
      enabled: true
    }
    apply(upsertProfile(settings, profile))
    setAdding(false)
  }

  /**
   * Drop = rewrite the chain.
   *
   * `chains[kind]` is the authoritative order, so the rendered list is frozen
   * into it wholesale: profiles that were never chained still render last, and
   * after a drag they are simply chained in that same position.
   */
  const dragApi: RowDrag = {
    state: drag,
    start: (id) =>
      setDrag({
        dragId: id,
        overId: id,
        after: false
      }),
    over: (id, after) =>
      setDrag((prev) =>
        prev && (prev.overId !== id || prev.after !== after) ? { ...prev, overId: id, after } : prev
      ),
    drop: (id) => {
      const dropState = drag
      if (dropState) {
        const next = reorderIds(order, dropState.dragId, id, dropState.after)
        if (!isSameOrder(next, order)) patch({ chains: { ...settings.chains, [kind]: next } })
      }
      setDrag(null)
    },
    end: () => setDrag(null)
  }

  const full = (settings.profiles ?? []).length >= MAX_PROFILES

  return (
    <Box>
      {/*
        The list header is a row of the card, not a block above it: same 16px
        inset, its own hairline underneath, and the 12px heading shares a
        baseline with its 11px hint while the button centres itself against the
        pair instead of hanging off a baseline.
      */}
      <Box
        data-profile-toolbar={kind}
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 1.25,
          rowGap: 0.5,
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: 'divider'
        }}
      >
        <Typography
          sx={{ fontSize: 12, fontWeight: 600, lineHeight: '18px', color: 'text.secondary' }}
        >
          {i18n.t('{{n}} 个配置', { n: list.length })}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          sx={{ alignSelf: 'center', flexShrink: 0, ml: 'auto' }}
          disabled={full}
          onClick={openAdd}
          data-profile-add={kind}
        >
          {i18n.t('新增配置')}
        </Button>
      </Box>
      {list.length === 0 ? (
        /*
          The form that used to sit under this list is gone, so the empty state
          may not point at it any more: one calm line, button stays above.
        */
        <Box data-profile-empty={kind} sx={{ px: 2, py: 1.5 }}>
          <Typography
            sx={{
              fontSize: 11.5,
              color: 'text.secondary',
              lineHeight: 1.6,
              overflowWrap: 'anywhere'
            }}
          >
            {i18n.t('暂无配置，点击「新增配置」添加服务。')}
          </Typography>
        </Box>
      ) : (
        <Box data-profile-list={kind}>
          {list.map((profile, index) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              kind={kind}
              first={index === 0}
              last={index === list.length - 1}
              drag={dragApi}
              handlers={{
                edit: (next) => apply(upsertProfile(settings, next)),
                toggle: (enabled) => apply(setProfileEnabled(settings, profile.id, enabled)),
                move: (delta) => apply(moveProfile(settings, profile.id, delta)),
                remove: () => apply(removeProfile(settings, profile.id))
              }}
            />
          ))}
        </Box>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{i18n.t('新增{{kind}}配置', { kind: i18n.t(KIND_LABEL[kind] ?? '') })}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              size="small"
              label={i18n.t(i18n.t('模板'))}
              value={presetId}
              onChange={(event) => pickPreset(event.target.value)}
              sx={controlSx}
            >
              {presets.map((item) => (
                <MenuItem key={item.id || 'blank'} value={item.id}>
                  {item.name}
                </MenuItem>
              ))}
            </TextField>
            {preset ? (
              <Alert severity="info" sx={{ fontSize: 12 }}>
                {preset.notes ? <Box>{preset.notes}</Box> : null}
                {preset.keyUrl ? (
                  <Box sx={{ mt: 0.5, color: 'text.secondary' }}>{i18n.t('申请 Key：{{url}}', { url: preset.keyUrl })}</Box>
                ) : null}
              </Alert>
            ) : null}
            <TextField
              size="small"
              label="Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://127.0.0.1:8080/v1"
              sx={controlSx}
            />
            <TextField
              size="small"
              label={i18n.t(i18n.t('模型'))}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={i18n.t(i18n.t('whisper-1 / gpt-4o-mini / 你的本地模型名'))}
              sx={controlSx}
            />
            {kind === 'asr' ? null : (
              <TextField
                size="small"
                label={i18n.t(i18n.t('请求路径（可选）'))}
                value={requestPath}
                onChange={(event) => setRequestPath(event.target.value)}
                placeholder="chat/completions"
                sx={controlSx}
              />
            )}
            <TextField
              size="small"
              label={i18n.t(i18n.t('名称'))}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={preset ? preset.name : i18n.t('我的服务')}
              sx={controlSx}
            />
            <TextField
              size="small"
              label="API Key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={i18n.t(i18n.t('本机服务可留空'))}
              sx={controlSx}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>{i18n.t(i18n.t('取消'))}</Button>
          <Button
            variant="contained"
            onClick={submit}
            disabled={!baseUrl.trim() || !model.trim()}
            data-profile-submit={kind}
          >
            {i18n.t('保存')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
