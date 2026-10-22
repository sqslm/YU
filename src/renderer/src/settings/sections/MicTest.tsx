import { useEffect, useRef, useState } from 'react'
import { Box, Button, LinearProgress, Typography } from '@mui/material'
import type { AudioProcessingMode } from '@shared/types'
import { encodeWav, SAMPLE_RATE } from '@shared/audio'
import { MicCapture } from '../../bar/capture'
import i18n from '../../i18n'

const MAX_SAMPLES = SAMPLE_RATE * 10
const CLIP_DB = -1
const SILENT_DB = -55

export interface MicTestProps {
  deviceId: string
  processing: AudioProcessingMode
}

/** Uses the same capture, PCM format and processing as actual recognition. */
export function MicTest({ deviceId, processing }: MicTestProps): JSX.Element {
  const [running, setRunning] = useState(false)
  const [db, setDb] = useState(-100)
  const [peakDb, setPeakDb] = useState(-100)
  const [error, setError] = useState<string | null>(null)
  const [clipUrl, setClipUrl] = useState<string | null>(null)
  const [inputRate, setInputRate] = useState<number | null>(null)
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }, [clipUrl])
  useEffect(() => {
    // A change invalidates the old comparison clip and releases its memory.
    setClipUrl(null)
  }, [deviceId, processing])

  useEffect(() => {
    if (!running) return
    let cancelled = false
    let finishing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let count = 0
    const chunks: Int16Array[] = []
    const mic = new MicCapture({
      onChunk: chunk => {
        const keep = chunk.subarray(0, Math.max(0, MAX_SAMPLES - count))
        if (keep.length) { chunks.push(keep); count += keep.length }
        let peak = 0
        for (const sample of chunk) peak = Math.max(peak, Math.abs(sample) / 32768)
        const value = peak > 0 ? Math.max(-100, 20 * Math.log10(peak)) : -100
        if (!cancelled) { setDb(value); setPeakDb(previous => Math.max(previous, value)) }
      },
      onLevel: () => undefined,
      onFormat: format => { if (!cancelled) setInputRate(format.sampleRate ?? null) },
      onError: message => { if (!cancelled) { setError(message); setRunning(false) } }
    })
    const finish = async (): Promise<void> => {
      if (finishing) return
      finishing = true
      if (timer) clearTimeout(timer)
      await mic.setActive(false)
      await mic.stop()
      if (cancelled) return
      if (count > 0) {
        const pcm = new Int16Array(count)
        let offset = 0
        for (const part of chunks) { pcm.set(part, offset); offset += part.length }
        const wav = encodeWav(pcm)
        setClipUrl(URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' })))
      }
      setRunning(false)
    }
    stopRef.current = () => { void finish() }
    void (async () => {
      await mic.setDevice(deviceId, processing)
      await mic.start()
      if (cancelled) { await mic.stop(); return }
      if (!mic.isRunning) { setRunning(false); return }
      await mic.setActive(true)
      if (cancelled) { await mic.setActive(false, false); await mic.stop(); return }
      timer = setTimeout(() => { void finish() }, 10_000)
    })().catch((err: unknown) => {
      if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setRunning(false) }
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stopRef.current = null
      chunks.length = 0
      void mic.setActive(false, false).then(() => mic.stop())
    }
  }, [running, deviceId, processing])

  const percent = Math.round(Math.min(100, Math.max(0, (db + 60) / 60 * 100)))
  const clipping = running && peakDb >= CLIP_DB
  const silent = running && peakDb < SILENT_DB
  return (
    <Box sx={{ width: 240 }} data-mic-test>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LinearProgress variant="determinate" value={percent} sx={{ flex: 1, height: 6, borderRadius: 3,
          '& .MuiLinearProgress-bar': { backgroundColor: clipping ? 'warning.main' : 'primary.main' } }} />
        <Button size="small" variant={running ? 'outlined' : 'contained'} data-mic-test-toggle
          sx={{ minWidth: 64, flex: '0 0 auto' }} onClick={() => {
            if (running) stopRef.current?.()
            else { setError(null); setClipUrl(null); setDb(-100); setPeakDb(-100); setInputRate(null); setRunning(true) }
          }}>
          {running ? i18n.t('停止') : i18n.t('测试说话')}
        </Button>
      </Box>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.75 }} data-mic-test-readout>
        {error ? error : !running ? i18n.t('点「测试说话」后对着麦克风说话')
          : clipping ? i18n.t('峰值 {{db}} dBFS · 电平偏高，建议调低系统输入音量', { db: peakDb.toFixed(1) })
          : silent ? i18n.t('没有拾到声音，检查设备或系统输入音量')
          : i18n.t('峰值 {{db}} dBFS · 正常', { db: peakDb.toFixed(1) })}
      </Typography>
      {inputRate && <Typography sx={{ fontSize: 11, color: inputRate < SAMPLE_RATE ? 'warning.main' : 'text.secondary', mt: 0.5 }} data-mic-input-rate>
        {inputRate < SAMPLE_RATE ? i18n.t('设备输入带宽较低，建议换用独立麦克风') : i18n.t('设备输入 {{rate}} kHz · 识别音频 16 kHz', { rate: inputRate / 1000 })}
      </Typography>}
      {clipUrl && <audio controls preload="metadata" src={clipUrl} data-mic-test-playback style={{ width: '100%', height: 30, marginTop: 8 }} />}
    </Box>
  )
}
