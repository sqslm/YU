/**
 * 本地语音识别 — the built-in recogniser, as its own block on the 模型 page.
 *
 * Three states drive everything here, and they are genuinely different things:
 *
 * - **文件在不在** (`status.present` / `status.catalog[].present`): a disk fact.
 *   Missing files mean the only useful action is 下载.
 * - **加载了没有** (`status.phase` + `status.loadedModelId`): a memory fact. Weights
 *   mapped into a child process is what makes dictation skip the network, and
 *   killing that child is the only way to give the RAM back.
 * - **开着没有** (`settings.localAsr.enabled`): a routing fact. A loaded model that
 *   is switched off is still loaded, and the status line says so instead of
 *   pretending the switch did nothing.
 *
 * The picker only chooses which model the *next* 加载 uses. Which model owns the
 * memory is read from `loadedModelId`; before that distinction existed, selecting a
 * different model moved the "在用" badge and the 释放 button onto weights that had
 * never been loaded, so releasing them did nothing at all.
 *
 * The page never guesses: every action re-reads `status` from the main process,
 * which rescans the disk each time it is asked.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  LinearProgress,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import type { Settings } from '@shared/types'
import {
  LOCAL_MODELS,
  findModel,
  formatBytes,
  modelBytes,
  type LocalAsrMirror,
  type LocalAsrStatus,
  type LocalDownloadProgress,
  type LocalModel
} from '@shared/local-asr'
import { controlSx, IconCpu, SettingsField, SettingsGroup, SettingsRow } from './General'
import i18n from '../../i18n'

interface LocalModelProps {
  settings: Settings
  patch: (patch: Partial<Settings>) => void
}

const PHASE_LABEL: Record<LocalAsrStatus['phase'], string> = {
  idle: '未加载',
  loading: '加载中',
  ready: '运行中',
  error: '出错了'
}

const LANGUAGE_LABEL: Record<string, string> = {
  auto: '自动识别',
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  yue: '粤语'
}

/** One line for the picker: the name, then the fact that decides "download or not". */
function optionLabel(model: LocalModel, presence: { present: boolean; bytes: number } | undefined): string {
  const size = presence?.present && presence.bytes > 0 ? i18n.t('已安装 {{size}}', { size: formatBytes(presence.bytes) }) : i18n.t('约 {{size}}', { size: formatBytes(modelBytes(model)) })
  return `${model.name} · ${size}`
}

export function LocalModel({ settings, patch }: LocalModelProps): JSX.Element {
  const [status, setStatus] = useState<LocalAsrStatus | null>(null)
  const [progress, setProgress] = useState<LocalDownloadProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setStatus(await window.api.localAsr.status())
  }, [])

  useEffect(() => {
    void refresh()
    return window.api.localAsr.onProgress(setProgress)
  }, [refresh])

  // Picking another model is a settings change, not an engine change: the patch is
  // debounced (350 ms) before main sees it, so `status` still describes the old
  // selection until it is asked again. Ask twice — once for the immediate case and
  // once after the debounce — and keep the picker driven by `settings`, never by
  // `status`, so a slow answer can never snap the dropdown back.
  useEffect(() => {
    void refresh()
    const timer = setTimeout(() => void refresh(), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.localAsr.modelId, settings.localAsr.modelDir, settings.localAsr.language])

  const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    try {
      await action()
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const setLocal = (partial: Partial<Settings['localAsr']>): void => {
    patch({ localAsr: { ...settings.localAsr, ...partial } })
  }

  // The selection is the user's, so it comes from settings. Everything about the
  // disk is per-model (`catalog`), which is why the rows stay correct even while
  // `status` still describes whatever was selected a moment ago.
  const selectedId = settings.localAsr.modelId
  const model = findModel(selectedId) ?? LOCAL_MODELS[0]
  const presence = status?.catalog.find((entry) => entry.id === model.id)
  const present = presence?.present ?? false
  /** True once main has caught up with the picker (it debounces setting writes). */
  const settled = status?.modelId === model.id
  const dir = settled ? status?.dir ?? '' : presence?.dir ?? ''
  const loadedId = status?.loadedModelId ?? null
  const loadedName = status?.loadedModelName ?? null
  const selectedLoaded = loadedId === model.id
  const otherLoaded = loadedId !== null && !selectedLoaded
  const language = settings.localAsr.language
  const languageOptions = model.languages

  const dotColor = status?.phase === 'ready' ? '#4ade80' : status?.phase === 'error' ? '#f87171' : '#8b8b93'

  return (
    <SettingsGroup
      icon={<IconCpu />}
      title={i18n.t(i18n.t('本地语音识别'))}
      hint={i18n.t('离线识别，无需上传录音')}
    >
      <SettingsRow
        label={i18n.t(i18n.t('优先使用本地识别'))}
        description={i18n.t(i18n.t('本地识别无结果或失败时，使用已启用的在线服务。'))}
      >
        <Switch
          size="small"
          checked={settings.localAsr.enabled}
          onChange={(event) => setLocal({ enabled: event.target.checked })}
          inputProps={{ 'data-local-switch': settings.localAsr.enabled ? 'on' : 'off' } as Record<string, string>}
        />
      </SettingsRow>

      <SettingsRow label={i18n.t(i18n.t('识别模型'))} description={i18n.t('选择已下载的模型，加载后用于本地识别。')}>
        <TextField
          select
          size="small"
          value={model.id}
          onChange={(event) => {
            const next = findModel(event.target.value) ?? LOCAL_MODELS[0]
            // A language the new model cannot speak would be silently ignored by
            // the recogniser, so the picker falls back to the model's first option.
            const nextLanguage = next.languages.includes(language) ? language : next.languages[0]
            setLocal({ modelId: next.id, language: nextLanguage })
          }}
          inputProps={{ 'data-local-model': model.id }}
          sx={controlSx}
        >
          {LOCAL_MODELS.map((entry) => (
            <MenuItem
              key={entry.id}
              value={entry.id}
              data-local-option={entry.id}
              data-local-option-present={status?.catalog.find((row) => row.id === entry.id)?.present ? 'on' : 'off'}
            >
              {optionLabel(entry, status?.catalog.find((row) => row.id === entry.id))}
            </MenuItem>
          ))}
        </TextField>
      </SettingsRow>

      <Box
        data-local-state={selectedLoaded ? 'loaded' : otherLoaded ? 'other' : 'idle'}
        data-local-loaded-id={loadedId ?? ''}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1.1,
          borderTop: 1,
          borderColor: 'divider',
          minHeight: 44
        }}
      >
        <Box data-local-dot sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: dotColor, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography data-local-status sx={{ fontSize: 12, lineHeight: 1.5 }} noWrap>
            {status?.autoResume ? i18n.t('待自动恢复') : i18n.t(PHASE_LABEL[status?.phase ?? 'idle'] ?? '')}
            {settled && status?.message ? ` · ${status.message}` : ''}
            {!settled ? ' · ' + i18n.t('正在保存选择…') : ''}
          </Typography>
          <Typography sx={{ fontSize: 10.5, color: 'text.secondary', lineHeight: 1.45 }} noWrap>
            {selectedLoaded
              ? i18n.t('权重常驻在这台电脑上 · {{size}}', { size: formatBytes(status?.installedBytes ?? 0) })
              : otherLoaded
                ? i18n.t('{{name}} 还占着内存，点「释放内存」才还回去；选中「{{target}}」后点加载即切换', { name: loadedName, target: model.name })
                : present
                  ? i18n.t('文件在 {{where}}里，加载后不必再下载', { where: status?.dirSource === 'custom' ? i18n.t('你指定的目录') : i18n.t('安装目录') })
                  : i18n.t('约 {{size}}，下载一次以后离线可用', { size: formatBytes(modelBytes(model)) })}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          {!present && (
            <Button
              size="small"
              variant="contained"
              data-local-download
              disabled={busy !== null}
              onClick={() => void run('download', () => window.api.localAsr.download(settings.localAsr.mirror))}
            >
              {busy === 'download' ? i18n.t('下载中…') : i18n.t('下载')}
            </Button>
          )}
          {present && !selectedLoaded && (
            <Button
              size="small"
              variant="contained"
              data-local-activate
              // Loading reads the selection from the store, not from this render, so
              // it waits for the debounced write instead of loading the previous model.
              disabled={busy !== null || !settled}
              onClick={() => void run('activate', () => window.api.localAsr.activate())}
            >
              {busy === 'activate' ? i18n.t('加载中…') : otherLoaded ? i18n.t('切换到此模型') : i18n.t('加载')}
            </Button>
          )}
          {loadedId !== null && (
            <Button
              size="small"
              data-local-release
              disabled={busy !== null}
              onClick={() => void run('release', () => window.api.localAsr.release())}
            >
              {i18n.t('释放内存')}
            </Button>
          )}
          {present && (
            <Tooltip title={i18n.t(i18n.t('从磁盘删掉这些权重，下次要重新下载'))}>
              <Button
                size="small"
                color="inherit"
                data-local-remove
                disabled={busy !== null}
                onClick={() => void run('remove', () => window.api.localAsr.remove())}
              >
                {i18n.t('删除文件')}
              </Button>
            </Tooltip>
          )}
        </Stack>
      </Box>

      {progress && (
        <Box data-local-progress sx={{ px: 2, pb: 1.2 }}>
          <LinearProgress
            variant={progress.total > 0 ? 'determinate' : 'indeterminate'}
            value={Math.round(Math.min(1, Math.max(0, progress.ratio)) * 100)}
            sx={{ height: 4, borderRadius: 2 }}
          />
          <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.5 }} noWrap>
            {`正在下载 ${progress.file}（${progress.fileIndex + 1}/${progress.fileCount}） · ${formatBytes(progress.received)} / ${progress.total > 0 ? formatBytes(progress.total) : i18n.t('未知大小')}`}
          </Typography>
        </Box>
      )}

      <SettingsRow label={i18n.t(i18n.t('语言'))} description={i18n.t(i18n.t('多数情况下「自动识别」就够；固定语言能少猜一次'))}>
        <TextField
          select
          size="small"
          value={language}
          onChange={(event) => setLocal({ language: event.target.value })}
          inputProps={{ 'data-local-language': language }}
          sx={controlSx}
        >
          {languageOptions.map((code) => (
            <MenuItem key={code} value={code}>
              {i18n.t(LANGUAGE_LABEL[code] ?? code)}
            </MenuItem>
          ))}
        </TextField>
      </SettingsRow>

      <SettingsRow label={i18n.t(i18n.t('下载源'))} description={i18n.t(i18n.t('国内镜像更快；官方地址在镜像失效时用'))}>
        <TextField
          select
          size="small"
          value={settings.localAsr.mirror}
          onChange={(event) => setLocal({ mirror: event.target.value as LocalAsrMirror })}
          inputProps={{ 'data-local-mirror': settings.localAsr.mirror }}
          sx={controlSx}
        >
          <MenuItem value="cn">{i18n.t(i18n.t('国内镜像'))}</MenuItem>
          <MenuItem value="official">HuggingFace</MenuItem>
        </TextField>
      </SettingsRow>

      <SettingsField
        label={i18n.t(i18n.t('存放位置'))}
        description={
          status && !status.installWritable
            ? i18n.t('安装目录不可写，模型保存在用户数据目录。')
            : i18n.t('模型文件的保存位置。')
        }
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexWrap: 'wrap', rowGap: 1 }}>
          <Typography
            data-local-dir
            sx={{ fontSize: 11.5, color: 'text.secondary', width: '100%', overflowWrap: 'anywhere' }}
            title={dir}
          >
            {dir || i18n.t('（还没找到）')}
          </Typography>
          <Button size="small" data-local-open disabled={!present} onClick={() => void window.api.localAsr.openDir()}>
            {i18n.t('打开')}
          </Button>
          <Button size="small" data-local-pick onClick={() => void run('pick', () => window.api.localAsr.pickDir())}>
            {i18n.t('换目录')}
          </Button>
          <Button size="small" data-local-rescan onClick={() => void run('rescan', () => window.api.localAsr.rescan())}>
            {i18n.t('重新检测')}
          </Button>
        </Stack>
      </SettingsField>

      {settings.localAsr.modelDir.trim() !== '' && (
        <SettingsRow label={i18n.t(i18n.t('恢复默认位置'))} description={i18n.t(i18n.t('把「换目录」的选择清掉，重新用安装目录'))}>
          <Button
            size="small"
            data-local-clear-dir
            onClick={() => void run('clear', () => window.api.localAsr.clearDir())}
          >
            {i18n.t('恢复默认')}
          </Button>
        </SettingsRow>
      )}

      {status && !status.runtime && (
        <Box sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }}>
          <Typography data-local-badge sx={{ fontSize: 10.5, color: 'warning.main' }}>
            {i18n.t('本地识别不可用，请使用在线语音服务。')}
          </Typography>
        </Box>
      )}
    </SettingsGroup>
  )
}
