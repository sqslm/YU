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
    if (phase === 'available') {
      const result = await window.api.update?.download()
      if (result && !result.ok) setState((prev) => ({ ...(prev ?? { currentVersion: '' }), phase: 'error', message: result.message } as UpdateState))
      return
    }
    if (phase === 'downloaded') {
      await window.api.update?.install()
      return
    }
    const next = await window.api.update?.check()
    if (next) setState(next)
  }, [state?.phase])

  if (!state) return null
  // Nothing to show until a release actually exists: a permanent "up to date"
  // chip would be noise in a window the user keeps open all day.
  if (state.phase !== 'available' && state.phase !== 'downloading' && state.phase !== 'downloaded') {
    return null
  }

  const version = state.version ?? ''
  const label =
    state.phase === 'downloaded'
      ? i18n.t('重启安装 v{{version}}', { version })
      : state.phase === 'downloading'
        ? i18n.t('下载中 {{percent}}%', { percent: state.percent ?? 0 })
        : i18n.t('有新版本 v{{version}}', { version })
  const hint =
    state.phase === 'downloaded'
      ? i18n.t('更新已下载，点击重启并安装')
      : state.phase === 'downloading'
        ? i18n.t('正在后台下载更新')
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
          maxWidth: 132,
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
