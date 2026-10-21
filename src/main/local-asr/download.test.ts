import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile } from './download'

const BODY = Buffer.from('x'.repeat(64 * 1024))

let server: Server | null = null
let dir = ''

async function serve(handler: (url: string, res: import('node:http').ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => handler(req.url ?? '/', res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  dir = await mkdtemp(join(tmpdir(), 'local-asr-dl-'))
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('downloadFile', () => {
  it('streams the body to disk and reports progress', async () => {
    const base = await serve((_url, res) => {
      res.writeHead(200, { 'content-length': String(BODY.length) })
      res.end(BODY)
    })
    const target = join(dir, 'sub', 'model.onnx')
    const seen: number[] = []
    const bytes = await downloadFile(`${base}/file`, target, (received) => seen.push(received))

    expect(bytes).toBe(BODY.length)
    expect((await readFile(target)).length).toBe(BODY.length)
    expect(seen.at(-1)).toBe(BODY.length)
    // The temporary file is renamed away, never left behind.
    expect(await readdir(join(dir, 'sub'))).toEqual(['model.onnx'])
  })

  it('follows a redirect to the real file', async () => {
    const base = await serve((url, res) => {
      if (url === '/moved') {
        res.writeHead(302, { location: '/real' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-length': String(BODY.length) })
      res.end(BODY)
    })
    const target = join(dir, 'redirected.onnx')
    await downloadFile(`${base}/moved`, target, () => {})
    expect((await readFile(target)).length).toBe(BODY.length)
  })

  it('rejects a non-200 answer and leaves nothing on disk', async () => {
    const base = await serve((_url, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    const target = join(dir, 'missing.onnx')
    await expect(downloadFile(`${base}/missing`, target, () => {})).rejects.toThrow(/HTTP 404/)
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects a short body instead of believing the server', async () => {
    // The server promises 1 KB, sends 15 bytes and drops the socket — a truncated
    // mirror, a dying Wi-Fi link, a proxy that gave up. It must not be renamed
    // into place as if it were a model.
    const base = await serve((_url, res) => {
      res.writeHead(200, { 'content-length': '1024' })
      res.write('only a few bytes')
      setTimeout(() => res.destroy(), 20)
    })
    const target = join(dir, 'short.onnx')
    await expect(downloadFile(`${base}/short`, target, () => {})).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})
