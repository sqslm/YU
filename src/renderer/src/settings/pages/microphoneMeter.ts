import { captureConstraints } from '../../bar/capture'
import type { AudioProcessingMode } from '@shared/types'

export function microphoneLevel(data: Float32Array): number {
  if (!data.length) return 0
  return Math.min(100, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length) * 400)
}
/** Local level check only: no audio is stored, played back or uploaded. */
export async function openMicrophoneMeter(deviceId: string, mode: AudioProcessingMode, changed: (level: number) => void): Promise<{ stop(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...captureConstraints(mode), ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false })
  let context: AudioContext | undefined, timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); if (context && context.state !== 'closed') void context.close() }
  try {
    context = new AudioContext()
    const analyser = context.createAnalyser(); analyser.fftSize = 512
    context.createMediaStreamSource(stream).connect(analyser)
    await context.resume()
    const data = new Float32Array(analyser.fftSize)
    timer = setInterval(() => { analyser.getFloatTimeDomainData(data); changed(microphoneLevel(data)) }, 80)
    return { stop }
  } catch (error) { stop(); throw error }
}
