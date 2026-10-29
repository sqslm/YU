import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { validModelFile, downloadMemoryModel, memoryModelReady } from './model'
const roots: string[] = []
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'yu-memory-model-')); roots.push(path); return path }
afterEach(async () => { vi.unstubAllGlobals(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
it('validates both pinned git blobs and SHA256 and rejects a corrupted or missing model', async () => {
  const path = await root(), data = Buffer.from('checked model bytes')
  await writeFile(join(path, 'model'), data)
  expect(await validModelFile(path, ['model', data.length, createHash('sha256').update(data).digest('hex')])).toBe(true)
  expect(await validModelFile(path, ['model', data.length, createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')])).toBe(true)
  expect(await validModelFile(path, ['model', data.length, 'wrong'])).toBe(false)
  expect(await memoryModelReady(path)).toBe(false)
})
it('cancels before downloading and never sends user credentials', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request)
  const controller = new AbortController(); controller.abort()
  await expect(downloadMemoryModel(await root(), controller.signal, () => {})).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})
it('rejects an oversized source and removes only its own partial file', async () => {
  const request = vi.fn(async () => new Response('x'.repeat(717))); vi.stubGlobal('fetch', request)
  const path = await root(); await writeFile(join(path, 'keep'), 'user data')
  await expect(downloadMemoryModel(path, new AbortController().signal, () => {})).rejects.toThrow('大小')
  expect(request.mock.calls[0]).toEqual([expect.stringContaining('/75c43b069aac4d136ba6bc1122f995fedcfd2781/'), expect.objectContaining({ credentials: 'omit' })])
  expect(await readFile(join(path, 'keep'), 'utf8')).toBe('user data')
  await expect(readFile(join(path, 'config.json.part'))).rejects.toThrow()
})
