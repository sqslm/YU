import { normalizeGameProcesses } from '@shared/game-mode'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, MenuItem, Stack, Switch, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material'
import type { ResourceUsage, Settings } from '@shared/types'
import { controlSx, IconCpu, SettingsGroup, SettingsHint, SettingsRow } from './General'
import i18n from '../../i18n'
import { Pager, PaginationSettings } from '../Pagination'

const ROLE_LABELS: Record<string, string> = {
  main: '主进程', graphics: '图形服务', interface: '界面', hotkeys: '快捷键',
  context: '上下文读取', localModel: '本地语音模型', memory: '长期记忆', network: '网络服务', media: '媒体服务', other: '辅助进程'
}

function memory(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function ResourcesSection({ settings, patch }: {
  settings: Settings
  patch: (patch: Partial<Settings>) => void
}): JSX.Element {
  const { size, change } = useContext(PaginationSettings)
  const [page, setPage] = useState(1)
  const [usage, setUsage] = useState<ResourceUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const editingGames = useRef(false)
  const [gamesDraft, setGamesDraft] = useState(settings.gameMode.processes.join('\n'))
  useEffect(() => { if (!editingGames.current) setGamesDraft(settings.gameMode.processes.join('\n')) }, [settings.gameMode.processes])
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const refresh = useCallback(async () => {
    try { setUsage(await window.api.app.resources()) }
    catch (error) { setNotice({ error: true, text: String(error) }) }
  }, [])

  useEffect(() => {
    let alive = true
    const update = (): void => {
      if (!alive || document.visibilityState === 'hidden') return
      void window.api.app.resources().then(
        (next) => { if (alive) setUsage(next) },
        (error) => { if (alive) setNotice({ error: true, text: String(error) }) }
      )
    }
    update()
    const timer = setInterval(update, 3000)
    document.addEventListener('visibilitychange', update)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [])

  const release = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      setUsage(await window.api.app.releaseResources())
      setNotice({ error: false, text: i18n.t('已完成空闲资源回收，快捷键和麦克风保持就绪。') })
    } catch (error) { setNotice({ error: true, text: String(error) }) }
    finally { setBusy(false) }
  }
  const minutes = settings.localAsr.idleUnloadMinutes
  const intervals = [...new Set([0, 1, 5, 15, minutes])].sort((a, b) => a - b)
  const total = usage?.processes.length ?? 0
  const safePage = Math.min(page, Math.max(1, Math.ceil(total / size)))
  useEffect(() => setPage(1), [size])
  useEffect(() => { if (page !== safePage) setPage(safePage) }, [page, safePage])
  const pager = total > size ? <Pager name="processes" page={safePage} total={total} size={size} onPage={setPage} onSize={change} /> : null
  const privateAvailable = usage !== null && usage.privateResidentBytes !== null

  return (
    <Stack spacing={3}>
      <SettingsGroup title={i18n.t('游戏模式')} hint={i18n.t('游戏退出后自动恢复，Alt+Tab 切出仍保持暂停。')}>
        <SettingsRow label={i18n.t('自动检测游戏')} description={i18n.t('识别常见游戏、游戏窗口及独占 3D 全屏；普通浏览器全屏不会触发。')}>
          <Switch size="small" checked={settings.gameMode.enabled} inputProps={{ 'aria-label': i18n.t('自动检测游戏') }}
            onChange={event => patch({ gameMode: { ...settings.gameMode, enabled: event.target.checked } })} />
        </SettingsRow>
        <SettingsRow label={i18n.t('当前状态')}>
          <Typography data-game-mode-status sx={{ fontSize: 12.5, color: usage?.gameMode?.active ? 'primary.main' : 'text.secondary' }}>
            {i18n.t(usage?.gameMode?.active ? usage.gameMode.source === 'manual' ? '手动游戏模式' : '检测到游戏，已暂停' : '正常运行')}
            {usage?.gameMode?.game ? ` · ${usage.gameMode.game}` : ''}
          </Typography>
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.5 }}>
          <TextField fullWidth size="small" multiline minRows={2} label={i18n.t('额外游戏进程')} value={gamesDraft}
            placeholder={'mygame.exe\ngame-win64-shipping.exe'}
            onFocus={() => { editingGames.current = true }}
            onBlur={() => { editingGames.current = false; setGamesDraft(settings.gameMode.processes.join('\n')) }}
            onChange={event => { const value = event.target.value; setGamesDraft(value); patch({ gameMode: { ...settings.gameMode, processes: normalizeGameProcesses(value.split(/[\n,;，；]+/)) } }) }}
            helperText={i18n.t('一行一个进程名或 exe 完整路径。未识别的窗口化游戏可加入此列表。')} />
          <Button data-game-mode-manual size="small" sx={{ mt: 1.5 }} disabled={busy} onClick={() => {
            setBusy(true)
            void window.api.app.setGameMode(usage?.gameMode?.source !== 'manual').then(() => refresh(), error => setNotice({ error: true, text: String(error) })).finally(() => setBusy(false))
          }}>{i18n.t(usage?.gameMode?.source === 'manual' ? '结束手动模式' : '手动保持游戏模式')}</Button>
        </Box>
        <SettingsHint>{i18n.t('暂停语音唤醒与所有语音快捷键，关闭录音条，释放本地模型和空闲界面，暂停同步与提醒调度。未保存成功的草稿和截图会保留；退出后恢复原设置。')}</SettingsHint>
      </SettingsGroup>
      <SettingsGroup icon={<IconCpu />} title={i18n.t('资源占用')}>
        <SettingsRow label={i18n.t('当前驻留内存')} description={privateAvailable
          ? i18n.t('各进程实际占用的私有物理内存，不重复计算共享页。')
          : i18n.t('系统不提供私有驻留统计，当前显示包含共享页的工作集。')}>
          <Typography data-resource-memory sx={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {usage ? memory(usage.privateResidentBytes ?? usage.workingSetBytes) : '—'}
          </Typography>
        </SettingsRow>
        <SettingsRow label={i18n.t('已提交内存')} description={i18n.t('包含暂未驻留的内存，与当前物理占用不同。')}>
          <Typography sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{memory(usage?.committedBytes ?? null)}</Typography>
        </SettingsRow>
        <SettingsRow label={i18n.t('本地语音模型')}>
          <Typography data-resource-model sx={{ fontSize: 12.5 }}>
            {!usage ? '—' : usage.localModel.loaded ? i18n.t('已加载') : usage.localModel.autoResume ? i18n.t('已释放，使用时恢复') : i18n.t('未加载')}
          </Typography>
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.75, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button data-resource-release variant="contained" disabled={busy} onClick={() => void release()}>{busy ? i18n.t('释放中…') : i18n.t('释放空闲资源')}</Button>
          <Button data-resource-copy variant="outlined" disabled={!usage || busy} onClick={() => void window.api.app.copyText(JSON.stringify(usage, null, 2)).then(() => setNotice({ error: false, text: i18n.t('占用信息已复制') }), (error) => setNotice({ error: true, text: String(error) }))}>{i18n.t('复制占用信息')}</Button>
          <Button disabled={busy} onClick={() => void refresh()}>{i18n.t('刷新')}</Button>
        </Box>
        <SettingsHint>{i18n.t('读数包含当前窗口；关闭主窗口会释放界面进程，听写和同步继续运行。')}</SettingsHint>
      </SettingsGroup>
      {notice && <Alert severity={notice.error ? 'error' : 'success'} onClose={() => setNotice(null)} sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>{notice.text}</Alert>}
      <SettingsGroup title={i18n.t('后台策略')}>
        <SettingsRow label={i18n.t('本地模型空闲释放')} description={i18n.t('到时卸载模型权重；下次本地听写会重新加载，首次识别会稍慢。')}>
          <TextField select value={minutes} sx={controlSx} onChange={(event) => patch({ localAsr: { ...settings.localAsr, idleUnloadMinutes: Number(event.target.value) } })}>
            {intervals.map((value) => <MenuItem key={value} value={value}>{value === 0 ? i18n.t('保持加载') : i18n.t('{{n}} 分钟', { n: value })}</MenuItem>)}
          </TextField>
        </SettingsRow>
        <SettingsHint>{i18n.t('开机启动时仅驻留托盘；录音和识别过程中不会自动卸载模型。')}</SettingsHint>
      </SettingsGroup>
      <SettingsGroup title={i18n.t('进程详情')} hint={usage ? i18n.t('{{n}} 个进程', { n: usage.processes.length }) : undefined} collapsible defaultOpen={false}>
        {pager}
        <Table size="small" aria-label={i18n.t('进程内存占用')} sx={{ '& td, & th': { fontSize: 11.5, px: 1.5, py: 1.25 }, '& tr:last-child td': { borderBottom: 0 } }}>
          <TableHead><TableRow><TableCell>{i18n.t('进程')}</TableCell><TableCell align="right">PID</TableCell><TableCell align="right">{i18n.t('驻留')}</TableCell><TableCell align="right">{i18n.t('已提交')}</TableCell></TableRow></TableHead>
          <TableBody>{usage?.processes.slice((safePage - 1) * size, safePage * size).map((process) => <TableRow key={process.pid}>
            <TableCell>{i18n.t(ROLE_LABELS[process.role] ?? '辅助进程')}</TableCell><TableCell align="right">{process.pid}</TableCell>
            <TableCell align="right">{memory(privateAvailable ? process.privateResidentBytes : process.workingSetBytes)}</TableCell><TableCell align="right">{memory(process.committedBytes)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {pager}
      </SettingsGroup>
    </Stack>
  )
}
