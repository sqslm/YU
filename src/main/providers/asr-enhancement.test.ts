import http from 'node:http'
import https from 'node:https'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeWav } from '../audio/wav'
import { transcribe, resetAsrRuntime } from './asr'
afterEach(() => { vi.restoreAllMocks(); resetAsrRuntime() })
it('uses the official multipart prompt and retries once without entity context when it is rejected', async () => {
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', part => chunks.push(part)); req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString()); res.writeHead(bodies.length === 1 ? 400 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bodies.length === 1 ? { error: 'context rejected' } : { text: 'original transcript' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  vi.spyOn(https, 'request').mockImplementation(((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: address.port, agent: undefined }, callback)) as typeof https.request)
  try {
    const pcm = Int16Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 6000)
    const result = await transcribe({ baseUrl: 'https://api.openai.com/v1', apiKey: 'test', model: 'whisper-1' }, { wav: encodeWav(pcm), entityContext: 'Kubernetes', warm: false, log: vi.fn() })
    expect(result.text).toBe('original transcript'); expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('name="prompt"'); expect(bodies[0]).toContain('Kubernetes')
    expect(bodies[1]).not.toContain('name="prompt"')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
