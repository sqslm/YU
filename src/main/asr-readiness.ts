import { connect } from 'node:net'
import type { Settings } from '@shared/types'
import { mt } from '@shared/mainI18n'
import { chainFor } from './providers/chain'

/** Transport check only: no audio, model request or provider quota is used. */
export function endpointReachable(baseUrl: string): Promise<boolean> {
  let url: URL
  try { url = new URL(baseUrl) } catch { return Promise.resolve(false) }
  if (!['http:', 'https:'].includes(url.protocol)) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
    const finish = (ok: boolean): void => { socket.destroy(); resolve(ok) }
    socket.setTimeout(1500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function checkAsrReadiness(
  settings: Settings,
  local: { available(): boolean; activate(): Promise<{ phase: string; message: string }> },
  probe = endpointReachable
): Promise<void> {
  // A selected built-in model is loaded before use, including after idle release.
  let localError = ''
  if (settings.pipelineMode !== 'multimodal' && settings.localAsr.enabled) {
    if (local.available()) return
    const status = await local.activate()
    if (status.phase === 'ready') return
    localError = status.message
  }
  const profiles = chainFor(settings, settings.pipelineMode === 'multimodal' ? 'multimodal' : 'asr')
  if ((await Promise.all(profiles.map(profile => probe(profile.baseUrl)))).some(Boolean)) return
  throw new Error(localError || mt('语音识别服务未连接，请先启动本地 ASR 服务或检查模型配置'))
}
