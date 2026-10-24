import { useEffect, useState } from 'react'
import { Box, Button, Typography, useTheme } from '@mui/material'
import { BrandLogo } from '../../BrandLogo'
import type { RecordingSessionInfo } from '@shared/types'
import { IconCode, IconInfo, SettingsField, SettingsGroup, SettingsRow } from './General'
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
  diagnosticsOnly?: boolean
}

/** Shown until the runtime answers, and forever when no version bridge exists. */
const FALLBACK_VERSION = '—'

/** Version comes from the running application, including packaged builds. */
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
 * "version" concept and the settings sheet also uses it.
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

export function AboutSection({ diagnosticsOnly = false }: SectionProps): JSX.Element {
  const theme = useTheme()
  const version = useAppVersion()
  const [showDiagnostics, setShowDiagnostics] = useState(false)
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

  useEffect(() => {
    if (!diagnosticsOnly) return
    void refreshSessions()
    return window.api.app.onRecordingChanged(() => {
      void refreshSessions()
      if (openSession) void window.api.app.recordingRead(openSession).then(text => setSessionText(text ?? i18n.t('（文件已经不在了）')))
    })
  }, [openSession, diagnosticsOnly])

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
      {!diagnosticsOnly && <SettingsGroup icon={<IconInfo />} title={i18n.t('版本')}>
        <Box sx={{ px: 2, py: 2 }}>
          <BrandLogo mode={theme.palette.mode} width={240} full />
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{i18n.t('product.name')}</Typography>
            <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>{version}</Typography>
          </Box>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.75, lineHeight: 1.55 }}>
            {i18n.t('用你的方式，与电脑交流。')}
          </Typography>
        </Box>
      </SettingsGroup>}
      {!diagnosticsOnly && <Box sx={{ mt: 3 }}>
        <SettingsGroup icon={<IconInfo />} title={i18n.t('设计理念')}>
          <SettingsRow label={i18n.t('自然表达')} description={i18n.t('保留你的原意，让口头表达成为清晰文字。')} />
          <SettingsRow label={i18n.t('一个入口')} description={i18n.t('用自然语言连接信息、随记、待办与本地工具。')} />
          <SettingsRow label={i18n.t('本地优先')} description={i18n.t('记录与提醒可在本机使用；按需调用你配置的模型与云同步。')} />
          <SettingsRow label={i18n.t('安静陪伴')} description={i18n.t('需要时出现，任务完成后回到后台，减少打扰。')} />
        </SettingsGroup>
        <Box sx={{ px: 2, py: 2 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{i18n.t('为什么叫「语」？')}</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.8, mt: 1 }}>{i18n.t('语言连接人与世界。打开的门，象征从表达走向工具与更多可能的入口。')}</Typography>
        </Box>
      </Box>}

      {diagnosticsOnly && <Box>
        <SettingsGroup icon={<IconCode />} title={i18n.t('诊断')}>
          <SettingsRow
            label={i18n.t('运行诊断')}
            description={i18n.t('导出版本、网络、麦克风和近期日志，敏感信息会隐藏。')}
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
      </Box>}

      {diagnosticsOnly && <Box sx={{ mt: 3 }}>
        <SettingsGroup icon={<IconCode />} title={i18n.t('最近几次听写')}>
          <SettingsField
            label={i18n.t('听写日志')}
            description={i18n.t('查看近期听写的识别、处理和插入结果。')}
          >
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
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
          </SettingsField>

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
                  {new Date(session.startedAt).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')}
                </Typography>
                <Typography sx={{ fontSize: 12, fontWeight: 600 }}>{i18n.t(({ dictation: '听写', translate: '翻译', ask: '问答' } as Record<string, string>)[session.mode] ?? session.mode)}</Typography>
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
      </Box>}

      {!diagnosticsOnly && <Box sx={{ mt: 3 }}>
        <SettingsGroup icon={<IconCode />} title={i18n.t('开源组件')}>
          <SettingsRow label={i18n.t('Electron + React 18 + MUI 6')} description={i18n.t('桌面界面与应用运行环境。')} />
          <SettingsRow label={'sherpa-onnx / ONNX Runtime'} description={i18n.t('本机语音识别与模型推理。')} />
        </SettingsGroup>
        <Typography sx={{ px: 2, mt: 2, fontSize: 11, color: 'text.secondary' }}>© 2026 YU contributors · MIT</Typography>
        <Button data-about-diagnostics size="small" sx={{ mt: 1 }} onClick={() => setShowDiagnostics(value => !value)}>{i18n.t(showDiagnostics ? '收起诊断工具' : '诊断工具')}</Button>
        {showDiagnostics && <AboutSection diagnosticsOnly />}
      </Box>}
    </Box>
  )
}


