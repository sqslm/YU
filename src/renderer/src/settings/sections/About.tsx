import { useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import type { RecordingSessionInfo, Settings } from '@shared/types'
import { IconCode, IconInfo, IconWaveMic, SettingsGroup, SettingsRow } from './General'
import i18n from '../../i18n'

/** How the per-take log ended, in the words the pill would use. */
const SESSION_STATUS: Record<RecordingSessionInfo['status'], string> = {
  done: '完成',
  cancelled: '已取消',
  error: '失败',
  empty: '空录音',
  open: '未结束'
}

interface SectionProps {
  settings: Settings
}

/** Shown until the runtime answers, and forever when no version bridge exists. */
const FALLBACK_VERSION = 'v0.8.3'

/** `src/shared/api.ts` has no `version()` yet and is out of scope here, so the
 *  capability is probed structurally: use it when the runtime exposes it. */
interface VersionBridge {
  version?: () => Promise<string>
}

function probeVersion(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  const bridge = (window.api?.app as VersionBridge | undefined)?.version
  if (typeof bridge !== 'function') return Promise.resolve(null)
  return bridge.call(window.api.app).catch(() => null)
}

/**
 * Resolves the packaged version once. Lives here because this section owns the
 * "version" concept and the settings sheet and the account section both reuse it;
 * `src/shared` and any new file are off-limits for this change.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState(FALLBACK_VERSION)

  useEffect(() => {
    let cancelled = false
    void probeVersion().then((value) => {
      if (cancelled || !value) return
      setVersion(value.startsWith('v') ? value : `v${value}`)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return version
}

const STACK: Array<[string, string]> = [
  [i18n.t('录音'), i18n.t('AudioWorklet · 16 kHz 单声道 PCM16 · 常开暖流')],
  [i18n.t('热键'), i18n.t('WH_KEYBOARD_LL（utilityProcess + koffi，吞键）')],
  [i18n.t('插入'), i18n.t('剪贴板整段粘贴 → SendInput → UIA 三级回退')],
  [i18n.t('存储'), i18n.t('SQLite（node:sqlite）+ 子串检索，仅本机；可选同步到自建服务')]
]

export function AboutSection({ settings }: SectionProps): JSX.Element {
  const version = useAppVersion()
  const [diagnostics, setDiagnostics] = useState<{ busy: boolean; message: string }>({
    busy: false,
    message: ''
  })
  const [sessions, setSessions] = useState<RecordingSessionInfo[]>([])
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [sessionText, setSessionText] = useState('')
  const [sessionNotice, setSessionNotice] = useState('')

  const refreshSessions = async (): Promise<void> => {
    const next = await window.api.app.recordingList().catch(() => [])
    setSessions(next)
  }

  // Read once when the panel opens. There is no live push: a take ending while
  // the user stares at this page is rare, and "刷新" is right there.
  useEffect(() => {
    void refreshSessions()
  }, [])

  const toggleSession = async (id: string): Promise<void> => {
    if (openSession === id) {
      setOpenSession(null)
      setSessionText('')
      return
    }
    const text = await window.api.app.recordingRead(id).catch(() => null)
    setOpenSession(id)
    setSessionText(text ?? i18n.t('（文件已经不在了）'))
  }

  const clearSessions = async (): Promise<void> => {
    const removed = await window.api.app.recordingClear().catch(() => 0)
    setOpenSession(null)
    setSessionText('')
    setSessionNotice(i18n.t('已删除 {{n}} 个会话日志', { n: removed }))
    await refreshSessions()
  }

  const route =
    settings.pipelineMode === 'multimodal'
      ? i18n.t('多模态 · {{model}}', { model: settings.multimodal.model })
      : `ASR ${settings.asr.model} → LLM ${settings.polish.model}`

  /**
   * Devices are passed in because only the renderer can enumerate them; the main
   * process owns everything else (versions, connectivity, log tail).
   */
  const runDiagnostics = async (): Promise<void> => {
    setDiagnostics({ busy: true, message: '' })
    const devices = await window.api.media.devices().catch(() => [])
    const result = await window.api.app
      .diagnostics(devices)
      .catch(
        (): { ok: boolean; path?: string; message?: string } => ({
          ok: false,
          message: i18n.t('调用失败')
        })
      )
    setDiagnostics({
      busy: false,
      message: result.ok
        ? i18n.t('已生成 {{path}}', { path: result.path ?? i18n.t('未知路径') })
        : i18n.t('失败：{{message}}', { message: result.message ?? i18n.t('未知错误') })
    })
  }

  return (
    <Box>
      <SettingsGroup icon={<IconInfo />} title={i18n.t('版本')}>
        <Box sx={{ px: 2, py: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>Typeless Rebuild</Typography>
            <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>{version}</Typography>
          </Box>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.75, lineHeight: 1.55 }}>
            {i18n.t('净室复刻：自建 ASR + LLM 后端，界面与交互对齐原版 Typeless。')}
          </Typography>
        </Box>
        <SettingsRow label={i18n.t('当前链路')} description={i18n.t('在「模型」里可以切换两段式与一段直出')}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', maxWidth: 320, textAlign: 'right' }}>
            {route}
          </Typography>
        </SettingsRow>
        <SettingsRow label={i18n.t('联网检索')} description={i18n.t('在「搜索」里可以关闭或更换搜索服务')}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            {settings.search.enabled ? settings.search.provider : i18n.t('已关闭')}
          </Typography>
        </SettingsRow>
      </SettingsGroup>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconCode />} title={i18n.t('诊断')}>
          <SettingsRow
            label={i18n.t('运行诊断')}
            description={i18n.t('打包版本、连通性、麦克风与最近 50 行日志（已脱敏）并打开文件夹')}
          >
            <Button
              size="small"
              variant="outlined"
              disabled={diagnostics.busy}
              onClick={() => void runDiagnostics()}
              sx={{ textTransform: 'none', fontSize: 12 }}
            >
              {diagnostics.busy ? i18n.t('生成中…') : i18n.t('运行诊断')}
            </Button>
          </SettingsRow>
          {diagnostics.message && (
            <Box sx={{ px: 2, pb: 1.5 }}>
              <Typography
                sx={{ fontSize: 11.5, color: diagnostics.message.startsWith(i18n.t('失败')) ? 'error.main' : 'text.secondary', wordBreak: 'break-all' }}
              >
                {diagnostics.message}
              </Typography>
            </Box>
          )}
        </SettingsGroup>
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconCode />} title={i18n.t('最近几次听写')}>
          <SettingsRow
            label={i18n.t('每次听写一个日志文件')}
            description={i18n.t('哪一句没插进去，就打开那一次的文件：前台窗口、识别结果、用了哪张卡片、插入是否核对成功都在里面')}
          >
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                size="small"
                variant="outlined"
                data-recording-open
                onClick={() => void window.api.app.recordingOpen()}
                sx={{ textTransform: 'none', fontSize: 12 }}
              >
                {i18n.t('打开文件夹')}
              </Button>
              <Button
                size="small"
                variant="outlined"
                onClick={() => void refreshSessions()}
                sx={{ textTransform: 'none', fontSize: 12 }}
              >
                {i18n.t('刷新')}
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                data-recording-clear
                disabled={sessions.length === 0}
                onClick={() => void clearSessions()}
                sx={{ textTransform: 'none', fontSize: 12 }}
              >
                {i18n.t('清空')}
              </Button>
            </Box>
          </SettingsRow>

          {sessionNotice && (
            <Box sx={{ px: 2, pb: 1 }}>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{sessionNotice}</Typography>
            </Box>
          )}

          {sessions.length === 0 && (
            <Box sx={{ px: 2, pb: 1.5 }}>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {i18n.t('还没有记录。听写一次之后这里会出现一行。')}
              </Typography>
            </Box>
          )}

          {sessions.slice(0, 8).map((session) => (
            <Box key={session.id} sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
              <Box
                role="button"
                tabIndex={0}
                data-recording-session={session.id}
                onClick={() => void toggleSession(session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') void toggleSession(session.id)
                }}
                sx={{
                  px: 2,
                  py: 1,
                  cursor: 'pointer',
                  display: 'flex',
                  gap: 1.5,
                  alignItems: 'baseline',
                  '&:hover': { backgroundColor: 'action.hover' }
                }}
              >
                <Typography sx={{ fontSize: 12, minWidth: 128, color: 'text.secondary' }}>
                  {new Date(session.startedAt).toLocaleTimeString()}
                </Typography>
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{session.mode}</Typography>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1, minWidth: 0 }} noWrap>
                  {session.appName || i18n.t('（未读到前台应用）')}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 11.5,
                    color: session.status === 'error' ? 'error.main' : 'text.secondary'
                  }}
                >
                  {i18n.t(SESSION_STATUS[session.status] ?? '')}
                </Typography>
              </Box>
              {openSession === session.id && (
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    mx: 2,
                    mb: 1.5,
                    p: 1.5,
                    maxHeight: 220,
                    overflow: 'auto',
                    fontSize: 11,
                    lineHeight: 1.55,
                    borderRadius: 1,
                    backgroundColor: 'action.hover',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all'
                  }}
                >
                  {sessionText}
                </Box>
              )}
            </Box>
          ))}
        </SettingsGroup>
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconWaveMic />} title={i18n.t('实现要点')}>
          {STACK.map(([label, value]) => (
            <SettingsRow key={label} label={label} description={value} />
          ))}
        </SettingsGroup>
      </Box>

      <Box sx={{ mt: 2.5 }}>
        <SettingsGroup icon={<IconCode />} title={i18n.t('开源组件')}>
          <SettingsRow label={i18n.t('Electron + React 18 + MUI 6')} description={i18n.t('渲染层与主进程之间只走类型化的 IPC')} />
          <SettingsRow label={i18n.t('faster-whisper / SenseVoice')} description={i18n.t('自建转写网关，任何 OpenAI 兼容接口都能接入')} />
        </SettingsGroup>
      </Box>
    </Box>
  )
}


