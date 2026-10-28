import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Typography } from '@mui/material'
import type { Settings } from '@shared/types'
import type { WakeWordStatus } from '@shared/wake-word'
import { MicCapture, listDevices } from '../../bar/capture'
import { playCue } from '../../bar/cues'
import { registerGameModePreparation } from '../gameModePreparation'
import i18n from '../../i18n'

/** Audio stays in memory until the local recognizer has learned three readings. */
export function WakeTrainingDialog({ settings, onClose }: { settings: Settings; onClose: () => void }): JSX.Element {
  const t = i18n.t.bind(i18n)
  const [phase, setPhase] = useState<'preparing' | 'ready' | 'recording' | 'learning' | 'testing' | 'success'>('preparing')
  const [count, setCount] = useState(0), [level, setLevel] = useState(0), [error, setError] = useState('')
  const [status, setStatus] = useState<WakeWordStatus>({ phase: 'off' })
  const alive = useRef(true), mic = useRef<MicCapture | null>(null), samples = useRef<Int16Array[]>([])
  const chunks = useRef<Int16Array[]>([]), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recording = useRef(false), starting = useRef(false), stopping = useRef(false)
  const phrase = useRef(settings.wakeWord.phrase).current
  const close = useRef(onClose); close.current = onClose
  const release = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null; recording.current = false
    const current = mic.current; mic.current = null
    if (current) { await current.setActive(false, false); await current.stop() }
    await window.api.wakeWord.setup(null)
  }
  useEffect(() => {
    alive.current = true
    const off = window.api.wakeWord.onTestDetected(() => {
      if (alive.current) { setPhase('success'); void playCue('start', settings.playSounds) }
    })
    const offStatus = window.api.wakeWord.onChanged(value => { if (alive.current) setStatus(value) })
    const hide = (): void => { if (document.hidden) { void release().catch(() => undefined); close.current() } }
    document.addEventListener('visibilitychange', hide)
    const offGame = registerGameModePreparation(async () => { await release(); close.current(); return true })
    void window.api.wakeWord.setup('recording').then(() => { if (alive.current) setPhase('ready') }).catch(err => { if (alive.current) setError(String(err)) })
    return () => {
      alive.current = false; off(); offStatus(); offGame(); document.removeEventListener('visibilitychange', hide)
      samples.current = []; chunks.current = []
      void release().catch(() => undefined)
    }
  }, [])
  const finish = async (): Promise<void> => {
    if (!recording.current || stopping.current) return
    stopping.current = true; recording.current = false
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const current = mic.current
    try {
      await current?.setActive(false); await current?.stop(); mic.current = null
      if (!alive.current) return
      const size = chunks.current.reduce((sum, part) => sum + part.length, 0)
      if (size < 5600) throw Error(t('录音太短，请完整说出唤醒词后再停止'))
      const pcm = new Int16Array(size); let offset = 0
      for (const part of chunks.current) { pcm.set(part, offset); offset += part.length }
      samples.current.push(pcm); setCount(samples.current.length); setLevel(0)
      if (samples.current.length < 3) { setPhase('ready'); return }
      setPhase('learning')
      await window.api.wakeWord.learn(phrase, samples.current)
      samples.current = []
      if (!alive.current) return
      await window.api.wakeWord.setup('testing')
      if (alive.current) setPhase('testing')
    } catch (err) {
      if (alive.current) { setError(err instanceof Error ? err.message : String(err)); samples.current = []; setCount(0); setPhase('ready') }
    } finally { stopping.current = false; chunks.current = [] }
  }
  const start = async (): Promise<void> => {
    if (starting.current || stopping.current || phase !== 'ready') return
    starting.current = true; setError(''); setLevel(0); chunks.current = []
    const current = new MicCapture({ onChunk: part => { if (chunks.current.reduce((sum, item) => sum + item.length, 0) < 112_000) chunks.current.push(part) },
      onLevel: value => { if (alive.current) setLevel(value * 100) },
      onError: message => { if (alive.current) { setError(message); recording.current = false; setPhase('ready') } }
    })
    mic.current = current
    try {
      await window.api.wakeWord.setup('recording')
      // WinMM and Chromium use different device IDs. Match the chosen native
      // device's label after microphone permission, never silently train another mic.
      await current.start()
      if (!alive.current) { await current.stop(); return }
      if (settings.wakeWord.deviceId) {
        const native = (await window.api.wakeWord.devices()).find(item => item.id === settings.wakeWord.deviceId)
        const available = await listDevices()
        const label = native?.name.toLocaleLowerCase()
        const matches = label ? available.filter(item => item.deviceId !== 'default' && item.deviceId !== 'communications' && item.label.toLocaleLowerCase().startsWith(label)) : []
        if (matches.length !== 1) throw Error(t('无法对应所选麦克风，请选择系统默认麦克风后学习'))
        await current.setDevice(matches[0].deviceId, 'fidelity')
      }
      if (!alive.current || !current.isRunning) { await current.stop(); return }
      await playCue('start', settings.playSounds)
      if (!alive.current) { await current.stop(); return }
      await current.setActive(true)
      if (!alive.current) { await current.stop(); return }
      recording.current = true; setPhase('recording')
      timer.current = setTimeout(() => { void finish() }, 6_000)
    } catch (err) {
      await current.stop()
      if (alive.current) { setError(err instanceof Error ? err.message : String(err)); setPhase('ready') }
    } finally { starting.current = false }
  }
  const testing = phase === 'testing' || phase === 'success'
  return <Dialog open maxWidth="sm" fullWidth onClose={onClose} data-wake-training>
    <DialogTitle>{t('学习唤醒词')}</DialogTitle>
    <DialogContent><Stack spacing={2}>
      <Typography color="text.secondary">{t('在安静环境中，用平时的语气录三遍。仅在本机学习识别结果与置信度，不上传或保存原始录音。')}</Typography>
      <Typography variant="h5" textAlign="center" sx={{ py: 2 }}>{phrase}</Typography>
      {!testing && <Typography>{t('已录制 {{count}} / 3 遍', { count })}</Typography>}
      <LinearProgress variant={phase === 'learning' || phase === 'preparing' ? 'indeterminate' : 'determinate'} value={testing ? status.audioLevel ?? 0 : level} />
      <Typography role="status">{t(phase === 'preparing' ? '正在准备本地学习…' : phase === 'learning' ? '正在本机学习发音并校准置信度…' : phase === 'recording' ? '请说出唤醒词，说完点击停止' : phase === 'testing' ? '学习已保存，请再说一遍唤醒词进行测试（不会开始任务）' : phase === 'success' ? '唤醒成功！完成后即可正常使用' : '点击开始录制，听到提示音后说话')}</Typography>
      {testing && status.phase === 'error' && <Alert severity="error">{t('本地识别器不可用，请检查 Windows 语音识别语言包或麦克风')}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack></DialogContent>
    <DialogActions>
      <Button onClick={onClose}>{t(testing ? '完成' : '取消')}</Button>
      {phase === 'recording' && <Button variant="contained" onClick={() => { void finish() }}>{t('停止')}</Button>}
      {phase === 'ready' && <Button variant="contained" onClick={() => { void start() }}>{t('开始录制第 {{n}} 遍', { n: count + 1 })}</Button>}
      {phase === 'testing' && <Button onClick={() => { samples.current = []; setCount(0); setError(''); void window.api.wakeWord.setup('recording').then(() => setPhase('ready')).catch(err => setError(String(err))) }}>{t('重新学习')}</Button>}
    </DialogActions>
  </Dialog>
}
