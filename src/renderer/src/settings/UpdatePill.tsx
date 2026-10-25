import { useCallback, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Tooltip from '@mui/material/Tooltip'
import i18n from '../i18n'
import type { UpdateState } from '@shared/api'

/**
 * One small pill in the hub footer that only exists when there is something to
 * say. An update is the one piece of background work that needs a visible
 * resting state: the alert in the floating bar disappears, and without this the
 * user has no way to know a newer build was published.
 *
 * Clicking it does the obvious next step for the current phase, so the whole
 * flow (download → restart) lives in one 200px-wide control.
 */
export function UpdatePill(): JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.update?.state().then((next) => {
      if (alive && next) setState(next)
    })
    const off = window.api.update?.onState((next) => setState(next))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const act = useCallback(async () => {
    const phase = state?.phase
    if (phase === 'available' || phase === 'paused' || (phase === 'error' && state?.version)) {
      const result = await window.api.update?.download()
      if (result && !result.ok) setState((prev) => ({ ...(prev ?? { currentVersion: '' }), phase: 'error', message: result.message } as UpdateState))
      return
    }
    if (phase === 'downloading') { await window.api.update?.pause(); return }
    if (phase === 'verifying') return
    if (phase === 'downloaded') {
      await window.api.update?.install()
      return
    }
    const next = await window.api.update?.check()
    if (next) setState(next)
  }, [state?.phase, state?.version])

  if (!state) return null
  // Nothing to show until a release actually exists: a permanent "up to date"
  // chip would be noise in a window the user keeps open all day.
  if (!['available', 'downloading', 'downloaded', 'paused', 'verifying'].includes(state.phase) && !(state.phase === 'error' && state.version)) {
    return null
  }

  const version = state.version ?? ''
  const label =
    state.phase === 'downloaded'
      ? i18n.t('重启安装 v{{version}}', { version })
      : state.phase === 'paused' ? i18n.t('继续下载 {{percent}}%', { percent: state.percent ?? 0 })
      : state.phase === 'verifying' ? i18n.t('正在校验更新')
      : state.phase === 'error' ? i18n.t('下载失败，点击重试')
      : state.phase === 'downloading'
        ? i18n.t('下载中 {{percent}}%', { percent: state.percent ?? 0 })
        : i18n.t('有新版本 v{{version}}', { version })
  const hint =
    state.phase === 'downloaded'
      ? i18n.t('更新已下载，点击重启并安装')
      : state.phase === 'paused' ? i18n.t('已保留下载进度，点击继续')
      : state.phase === 'verifying' ? i18n.t('正在校验安装包，请稍候')
      : state.phase === 'error' ? state.message
      : state.phase === 'downloading'
        ? `${i18n.t('点击暂停下载')} · ${((state.transferred ?? 0) / 1048576).toFixed(1)} / ${((state.total ?? 0) / 1048576).toFixed(1)} MB · ${((state.bytesPerSecond ?? 0) / 1048576).toFixed(1)} MB/s${state.etaSeconds ? ` · ${state.etaSeconds}s` : ''}`
        : i18n.t('点击下载这个版本')

  return (
    <Tooltip title={hint}>
      <Box
        role="button"
        tabIndex={0}
        data-update-pill
        data-update-phase={state.phase}
        aria-label={label}
        onClick={() => void act()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            void act()
          }
        }}
        sx={{
          ml: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 0.75,
          height: 24,
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: 11.5,
          color: 'primary.main',
          bgcolor: 'rgba(76,141,255,0.12)',
          whiteSpace: 'nowrap',
          maxWidth: 180,
          overflow: 'hidden',
          '&:hover': { bgcolor: 'rgba(76,141,255,0.2)' }
        }}
      >
        <Box
          component="span"
          sx={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            bgcolor: 'primary.main',
            flex: '0 0 auto'
          }}
        />
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </Box>
      </Box>
    </Tooltip>
  )
}
