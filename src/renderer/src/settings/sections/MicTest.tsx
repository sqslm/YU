/**
 * Microphone test (REQ-09).
 *
 * The reference app asks "is the blue bar moving?" during onboarding and offers
 * the same meter in settings. This is that meter: a real `getUserMedia` stream on
 * the currently selected device, sampled with an `AnalyserNode`, reported as
 * dBFS plus a clipping flag so a hot or dead input is visible before the first
 * dictation rather than after it.
 */
import { useEffect, useRef, useState } from 'react'
import { Box, Button, LinearProgress, Typography } from '@mui/material'
import i18n from '../../i18n'

/** Peak level at or above this dBFS is treated as clipping. */
const CLIP_DB = -1
/** Below this the input is effectively silent. */
const SILENT_DB = -55

function toDb(peak: number): number {
  if (peak <= 0) return -100
  return Math.max(-100, 20 * Math.log10(peak))
}

export interface MicTestProps {
  /** Device the recorder uses; an empty string means the system default. */
  deviceId: string
}

export function MicTest({ deviceId }: MicTestProps): JSX.Element {
  const [running, setRunning] = useState(false)
  const [db, setDb] = useState(-100)
  const [peakDb, setPeakDb] = useState(-100)
  const [error, setError] = useState<string | null>(null)
  const stopRef = useRef<(() => void) | null>(null)

  // A device switch or a closed panel must release the microphone, otherwise the
  // settings window keeps a capture device open and the bar fights it for the
  // exclusive default device on some drivers.
  useEffect(() => {
    if (!running) return
    let cancelled = false
    void begin().catch((err: unknown) => {
      if (cancelled) return
      setError(describe(err))
      setRunning(false)
    })
    return () => {
      cancelled = true
      stopRef.current?.()
      stopRef.current = null
    }

    async function begin(): Promise<void> {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buffer)
        let peak = 0
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample))
        const value = toDb(peak)
        setDb(value)
        setPeakDb((previous) => Math.max(previous === -100 ? value : previous * 0.98, value))
      }, 80)
      stopRef.current = () => {
        window.clearInterval(timer)
        for (const track of stream.getTracks()) track.stop()
        void context.close().catch(() => undefined)
      }
    }
  }, [running, deviceId])

  const start = (): void => {
    setError(null)
    setPeakDb(-100)
    setRunning(true)
  }

  const stop = (): void => {
    stopRef.current?.()
    stopRef.current = null
    setRunning(false)
  }

  /** -100 dBFS … 0 dBFS mapped to 0 … 100 for the bar. */
  const percent = Math.round(Math.min(100, Math.max(0, (db + 60) / 60 * 100)))
  const clipping = running && peakDb >= CLIP_DB
  const silent = running && peakDb < SILENT_DB

  return (
    <Box sx={{ width: 240 }} data-mic-test>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LinearProgress
          variant="determinate"
          value={percent}
          sx={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            '& .MuiLinearProgress-bar': {
              backgroundColor: clipping ? 'warning.main' : 'primary.main'
            }
          }}
        />
        <Button
          size="small"
          variant={running ? 'outlined' : 'contained'}
          onClick={running ? stop : start}
          data-mic-test-toggle
          sx={{ minWidth: 64, flex: '0 0 auto' }}
        >
          {running ? i18n.t('停止') : i18n.t('测试说话')}
        </Button>
      </Box>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.75 }} data-mic-test-readout>
        {error
          ? error
          : !running
            ? i18n.t('点「测试说话」后对着麦克风说话')
            : clipping
              ? i18n.t('峰值 {{db}} dBFS · 已削波，建议调低输入音量', { db: peakDb.toFixed(1) })
              : silent
                ? i18n.t('没有拾到声音，检查设备或系统输入音量')
                : i18n.t('峰值 {{db}} dBFS · 正常', { db: peakDb.toFixed(1) })}
      </Typography>
    </Box>
  )
}

function describe(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError') return i18n.t('麦克风权限被拒绝，请在系统隐私设置里允许')
  if (name === 'NotFoundError') return i18n.t('没有找到可用的麦克风')
  if (name === 'NotReadableError') return i18n.t('设备被其他程序占用')
  return err instanceof Error ? err.message : String(err)
}
