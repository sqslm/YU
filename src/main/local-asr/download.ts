/**
 * Minimal HTTPS downloader for model files.
 *
 * Deliberately not `fetch`/undici: these are 200 MB single responses that have to
 * be streamed straight to disk with a progress callback, and the app already runs
 * inside Electron where `net` would add a session and proxy layer nobody asked
 * for. `https.get` plus `pipeline` is the whole thing.
 *
 * Written to `<target>.part` and renamed on completion, so an interrupted
 * download can never be mistaken for an installed model (the page decides that by
 * looking for the exact filenames).
 *
 * Plain `http` is supported as well as `https`: a mirror inside a LAN or an
 * intranet file server is a perfectly normal place to publish a 200 MB model, and
 * refusing the scheme would only push people into running TLS they do not want.
 */
import { createWriteStream, rmSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { get as getHttp, type IncomingMessage } from 'node:http'
import { get as getHttps } from 'node:https'

const MAX_REDIRECTS = 5
/** A stalled socket must fail instead of hanging the page forever. */
const IDLE_TIMEOUT_MS = 60_000

export type ProgressFn = (received: number, total: number) => void

function request(
  url: string,
  onResponse: (response: IncomingMessage) => void,
  onError: (error: Error) => void,
  redirects = 0
): void {
  const get = url.startsWith('http:') ? getHttp : getHttps
  const req = get(url, { headers: { 'user-agent': 'Typeless Rebuild', accept: '*/*' } }, (response) => {
    const status = response.statusCode ?? 0
    const location = response.headers.location
    if (status >= 300 && status < 400 && location) {
      response.resume()
      if (redirects >= MAX_REDIRECTS) {
        onError(new Error(`too many redirects for ${url}`))
        return
      }
      request(new URL(location, url).toString(), onResponse, onError, redirects + 1)
      return
    }
    onResponse(response)
  })
  req.on('error', onError)
  req.setTimeout(IDLE_TIMEOUT_MS, () => {
    req.destroy(new Error('download stalled'))
  })
}

/**
 * Downloads one file, reporting bytes as they arrive.
 *
 * Resolves with the number of bytes written. Rejects on a non-200 answer, on a
 * short body (the server promised a length and delivered less), and on a stall.
 */
export async function downloadFile(url: string, target: string, onProgress: ProgressFn): Promise<number> {
  await mkdir(dirname(target), { recursive: true })
  const part = `${target}.part`
  await rm(part, { force: true })

  return new Promise<number>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      // Synchronous on purpose: the caller (and the tests) must never observe a
      // leftover .part after a failure.
      rmSync(part, { force: true })
      reject(error)
    }

    request(url, (response) => {
      const status = response.statusCode ?? 0
      if (status !== 200) {
        response.resume()
        fail(new Error(`HTTP ${status} for ${url}`))
        return
      }
      const total = Number(response.headers['content-length'] ?? 0)
      let received = 0
      const out = createWriteStream(part)

      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress(received, total)
      })
      response.setTimeout(IDLE_TIMEOUT_MS, () => {
        response.destroy(new Error('download stalled'))
      })
      response.on('error', (error: Error) => {
        out.destroy()
        fail(error as Error)
      })
      out.on('error', (error) => {
        response.destroy()
        fail(error)
      })
      out.on('close', () => {
        if (settled) return
        if (total > 0 && received < total) {
          fail(new Error(`short download: ${received}/${total} bytes`))
          return
        }
        settled = true
        void rename(part, target).then(
          () => resolve(received),
          (error: Error) => reject(error)
        )
      })
      response.pipe(out)
    }, fail)
  })
}
