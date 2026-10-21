import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { mt } from '@shared/mainI18n'
import { decodeWavPcm16 } from './wav'
import { resolveFfmpeg } from './transcode'

export const MAX_IMPORT_BYTES = 128 * 1024 * 1024
export const MAX_IMPORT_SAMPLES = 10 * 60 * 16_000

/** Decode one selected recording. Never truncate an overlong file. */
export async function decodeRecording(file: string, signal?: AbortSignal): Promise<{ pcm: Int16Array; durationMs: number }> {
  signal?.throwIfAborted()
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_IMPORT_BYTES) throw new Error(mt('录音文件不能超过 128 MB'))
  if (!['.wav', '.mp3', '.m4a', '.ogg'].includes(extname(file).toLowerCase())) throw new Error(mt('请选择 WAV、MP3、M4A 或 OGG 录音'))

  // The app's uncompressed recordings need no external decoder.
  if (extname(file).toLowerCase() === '.wav' && info.size <= MAX_IMPORT_SAMPLES * 2 + 65_536) {
    const data = await readFile(file, { signal })
    let decoded: ReturnType<typeof decodeWavPcm16> | undefined
    try { decoded = decodeWavPcm16(data) } catch { /* Other WAV formats need FFmpeg. */ }
    if (decoded?.sampleRate === 16_000) return result(decoded.pcm, signal)
  }

  const pcm = await new Promise<Int16Array>((resolve, reject) => {
    const child = spawn(resolveFfmpeg() || 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', file, '-vn', '-sn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let length = 0
    let stderr = ''
    let failure: Error | undefined
    const stop = (error: Error): void => { failure ??= error; child.kill() }
    const abort = (): void => stop(new Error(mt('已取消录音处理')))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new Error(mt('录音解码超时'))), 90_000)
    timer.unref()
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    if (signal?.aborted) abort()
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_IMPORT_SAMPLES * 2) stop(new Error(mt('录音时长不能超过 10 分钟')))
      else if (!failure) chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup()
      reject(error.code === 'ENOENT' ? new Error(mt('此录音需要 FFmpeg，请安装并加入 PATH，或设置 TYPELESS_FFMPEG')) : error)
    })
    child.once('close', (code) => {
      cleanup()
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(mt('无法解码录音：{{message}}', { message: stderr.trim() || String(code) })))
      if (!length || length % 2) return reject(new Error(mt('录音中没有有效音频')))
      const pcm = new Int16Array(length / 2)
      new Uint8Array(pcm.buffer).set(Buffer.concat(chunks, length))
      resolve(pcm)
    })
  })
  return result(pcm, signal)
}

function result(pcm: Int16Array, signal?: AbortSignal): { pcm: Int16Array; durationMs: number } {
  signal?.throwIfAborted()
  if (!pcm.length) throw new Error(mt('录音中没有有效音频'))
  if (pcm.length > MAX_IMPORT_SAMPLES) throw new Error(mt('录音时长不能超过 10 分钟'))
  return { pcm, durationMs: Math.round(pcm.length / 16) }
}
