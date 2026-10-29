import { useEffect, useRef, useState } from 'react'
import { Alert, Button, LinearProgress, MenuItem, Stack, TextField, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import { openMicrophoneMeter } from './microphoneMeter'
import i18n from '../../i18n'

export function MicrophoneCheck({ settings, patch }: { settings: Settings; patch(delta: Partial<Settings>): void }): JSX.Element {
  const t = i18n.t.bind(i18n)
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]), [level, setLevel] = useState(0)
  const [testing, setTesting] = useState(false), [passed, setPassed] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), meter = useRef<{ stop(): void } | null>(null), reservation = useRef<string | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout>>()
  const stop = (): void => {
    generation.current++; clearTimeout(timeout.current); meter.current?.stop(); meter.current = null
    if (reservation.current) { window.api.onboarding.cancelVoice(reservation.current); reservation.current = null }
    setTesting(false); setLevel(0)
  }
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.api.media.devices().then(value => { if (alive) setDevices(value) }).catch(() => { if (alive) setError(t('无法获取麦克风列表，请重试')) }) }
    const hide = (): void => { if (document.hidden) stop() }
    refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh); document.addEventListener('visibilitychange', hide)
    return () => { alive = false; stop(); navigator.mediaDevices?.removeEventListener('devicechange', refresh); document.removeEventListener('visibilitychange', hide) }
  }, [])
  const start = async (): Promise<void> => {
    if (testing) { stop(); return }
    const token = ++generation.current; setTesting(true); setPassed(false); setError('')
    let id: string | null = null
    try {
      id = await window.api.onboarding.beginVoice()
      if (token !== generation.current) { if (id) window.api.onboarding.cancelVoice(id); return }
      if (!id) throw Error(t('当前有其他任务正在使用语音，请稍后重试'))
      reservation.current = id
      const handle = await openMicrophoneMeter(settings.inputDeviceId, settings.audioProcessing, value => { if (generation.current === token) { setLevel(value); if (value > 3) setPassed(true) } })
      if (token !== generation.current) { handle.stop(); window.api.onboarding.cancelVoice(id); return }
      meter.current = handle; timeout.current = setTimeout(stop, 15000)
    } catch (error) { if (token === generation.current) { stop(); setError(error instanceof Error ? error.message : String(error)) } }
  }
  const known = !settings.inputDeviceId || devices.some(device => device.deviceId === settings.inputDeviceId)
  return <Stack spacing={2.5}>
    <Typography color="text.secondary">{t('选择你实际使用的麦克风，再点击测试并说一句话。这里仅检测音量，不保存或上传录音。')}</Typography>
    <TextField select label={t('听写麦克风')} value={settings.inputDeviceId} onChange={event => { stop(); setPassed(false); patch({ inputDeviceId: event.target.value }) }}>
      <MenuItem value="">{t('系统默认麦克风')}</MenuItem>
      {!known && <MenuItem value={settings.inputDeviceId}>{t('已保存的设备（当前不可用）')}</MenuItem>}
      {devices.map(device => <MenuItem key={device.deviceId} value={device.deviceId}>{device.label || t('麦克风')}</MenuItem>)}
    </TextField>
    {!known && <Alert severity="warning">{t('选中的麦克风当前不可用，请重新选择。')}</Alert>}
    {error && <Alert severity="error">{error}</Alert>}
    <LinearProgress aria-label={t('麦克风输入音量')} variant="determinate" value={level} sx={{ height: 10, borderRadius: 5 }} />
    <Typography role="status" color={passed ? 'success.main' : 'text.secondary'}>{passed ? t('检测到声音，麦克风输入正常') : testing ? t('正在监听，请说一句话；15 秒后自动停止。') : t('点击测试后再开始说话')}</Typography>
    <Button variant="outlined" onClick={() => void start()} disabled={!known} sx={{ alignSelf: 'flex-start' }}>{t(testing ? '停止麦克风测试' : '测试麦克风')}</Button>
  </Stack>
}
