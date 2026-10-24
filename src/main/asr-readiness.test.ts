import { createServer } from 'node:net'
import { describe, it, expect, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { checkAsrReadiness, endpointReachable } from './asr-readiness'

const profiles = [{ id: 'asr', name: 'ASR', preset: '', enabled: true, kind: 'asr' as const, baseUrl: 'http://127.0.0.1:9999/v1', apiKey: '', model: 'test' }]
describe('recording ASR preflight', () => {
  it('rejects an unstarted service and accepts a reachable failover', async () => {
    const local = { available: () => false, activate: vi.fn() }
    const settings = mergeSettings({ profiles })
    await expect(checkAsrReadiness(settings, local, async () => false)).rejects.toThrow('语音识别服务未连接')
    settings.profiles.push({ ...profiles[0], id: 'backup', baseUrl: 'https://backup.test' })
    await expect(checkAsrReadiness(settings, local, async url => url.includes('backup'))).resolves.toBeUndefined()
    expect(local.activate).not.toHaveBeenCalled()
  })
  it('loads a selected built-in model automatically and does not send an ASR request', async () => {
    const settings = mergeSettings({}); settings.localAsr.enabled = true
    const local = { available: () => false, activate: vi.fn(async () => ({ phase: 'ready', message: '' })) }
    const probe = vi.fn()
    await checkAsrReadiness(settings, local, probe)
    expect(local.activate).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled()
  })
  it('reports missing local model files without downloading or masking the error', async () => {
    const settings = mergeSettings({}); settings.localAsr.enabled = true
    await expect(checkAsrReadiness(settings, { available: () => false, activate: async () => ({ phase: 'error', message: '缺少模型文件' }) })).rejects.toThrow('缺少模型文件')
  })
  it('checks real sockets and releases them, without using an HTTP model endpoint', async () => {
    const server = createServer(socket => socket.end())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    expect(await endpointReachable(`http://127.0.0.1:${port}/v1`)).toBe(true)
    await new Promise<void>(resolve => server.close(() => resolve()))
    expect(await endpointReachable(`http://127.0.0.1:${port}`)).toBe(false)
    expect(await endpointReachable('file:///private')).toBe(false)
  })
})
