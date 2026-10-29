import { useCallback, useEffect, useRef, useState } from 'react'
import { encodeWav, SAMPLE_RATE } from '@shared/audio'
import { MicCapture } from '../bar/capture'
import { playCue } from '../bar/cues'
import i18n from '../i18n'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')

/** Uses the dictation microphone pipeline, but sends text back to this card's thread. */
type VoiceBridge = Pick<typeof window.api.card, 'beginVoice' | 'cancelVoice' | 'transcribeVoice'>
export function useVoiceQuestion(submit: (text: string) => void, bridge: VoiceBridge = window.api.card): { recording: boolean; working: boolean; error: string; toggle(): void; cancel(): void; clearError(): void } {
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge
  const [recording, setRecording] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const clearError = useCallback(() => setError(''), [])
  const submitRef = useRef(submit); submitRef.current = submit
  const current = useRef<{ cancelled: boolean; mic: MicCapture; timer?: ReturnType<typeof setTimeout>; chunks: Int16Array[]; count: number; finishing: boolean; reserved: string | null } | null>(null)
  const cancel = useCallback((): void => {
    const take = current.current
    if (!take) return
    take.cancelled = true
    clearTimeout(take.timer)
    if (take.reserved) bridgeRef.current.cancelVoice(take.reserved!)
    void take.mic.setActive(false, false).then(() => take.mic.stop())
    // Keep the lock until an in-flight begin/start/transcription settles.
    if (!take.finishing) current.current = null
    setRecording(false); setWorking(false)
  }, [])
  useEffect(() => cancel, [cancel])
  const finish = async (): Promise<void> => {
    const take = current.current
    if (!take || take.finishing || take.cancelled) return
    take.finishing = true
    setRecording(false); setWorking(true)
    clearTimeout(take.timer)
    try {
      await take.mic.setActive(false)
      await take.mic.stop()
      if (take.cancelled) return
      const pcm = new Int16Array(take.count)
      let at = 0
      for (const chunk of take.chunks) { pcm.set(chunk, at); at += chunk.length }
      const text = await bridgeRef.current.transcribeVoice(take.reserved!, encodeWav(pcm))
      if (!take.cancelled) submitRef.current(text)
    } catch (error) { if (!take.cancelled) setError(errorMessage(error)) }
    finally {
      take.chunks.length = 0
      if (current.current === take) { current.current = null; setWorking(false); setRecording(false) }
      if (take.reserved && !take.cancelled) bridgeRef.current.cancelVoice(take.reserved!)
    }
  }
  const start = async (): Promise<void> => {
    if (current.current) return
    setError(''); setWorking(true)
    const mic = new MicCapture({
      onLevel: () => undefined,
      onError: message => { setError(message); cancel() },
      onChunk: chunk => {
        const take = current.current
        if (!take || take.cancelled) return
        const keep = chunk.slice(0, Math.max(0, SAMPLE_RATE * 60 - take.count))
        if (keep.length) { take.chunks.push(keep); take.count += keep.length }
        if (take.count >= SAMPLE_RATE * 60 && !take.finishing) void finish()
      }
    })
    const take = { cancelled: false, mic, chunks: [] as Int16Array[], count: 0, finishing: true, reserved: null as string | null, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    current.current = take
    try {
      take.reserved = await bridgeRef.current.beginVoice()
      if (!take.reserved) throw new Error(i18n.t('当前有其他任务正在使用语音，请稍后重试'))
      if (take.cancelled) { bridgeRef.current.cancelVoice(take.reserved!); return }
      const settings = await window.api.settings.get()
      if (take.cancelled) return
      await mic.setDevice(settings.inputDeviceId, settings.audioProcessing)
      await mic.start()
      if (take.cancelled) { await mic.stop(); return }
      if (!mic.isRunning) throw new Error(i18n.t('无法打开麦克风'))
      await playCue('start', settings.playSounds)
      if (take.cancelled) { await mic.stop(); return }
      await mic.setActive(true)
      if (take.cancelled) { await mic.setActive(false, false); await mic.stop(); return }
      take.finishing = false
      setWorking(false); setRecording(true)
      take.timer = setTimeout(() => { void finish() }, 60_000)
    } catch (error) { if (!take.cancelled) setError(errorMessage(error)); cancel() }
    finally {
      if (take.cancelled && current.current === take) { current.current = null; if (take.reserved) bridgeRef.current.cancelVoice(take.reserved!) }
    }
  }
  return { recording, working, error, toggle: () => { if (recording) void finish(); else if (!working) void start() }, cancel, clearError }
}
