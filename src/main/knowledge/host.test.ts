import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeError, type KnowledgeCard } from '@shared/knowledge'

import { KnowledgeHost, type KnowledgeHostOptions } from './host'
import type { ModelCall } from './model'

/**
 * The stub speaks the real protocol on real pipes, so the host's framing,
 * deadlines, cancellation, model bridge and lifetime are exercised without a
 * provider and without touching a database. The compiled helper is covered by
 * `host.integration.test.ts` and by the crate's own process tests.
 *
 * `card.get` is the probe: its `id` selects the stub's behaviour, so every test
 * still goes through the typed API the renderer uses.
 */
const STUB = `
import { createInterface } from 'node:readline'
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
write({ v: 1, type: 'ready', schema: { knowledge: 1, profile: 1 }, fts5: true, trigram: true })
let modelWait = null
const card = (id) => ({ id, kind: 'concept', title: id, summary: '', body: '', topics: [], aliases: [], sourceIds: [], edited: false, createdAt: 1, updatedAt: 1 })
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'model.result') {
    if (modelWait) modelWait(frame)
    return
  }
  if (frame.type === 'cancel') {
    write({ v: 1, type: 'result', id: frame.id, ok: false, error: { code: 'cancelled', message: 'cancelled' } })
    return
  }
  if (frame.type !== 'request') return
  const reply = (result) => write({ v: 1, type: 'result', id: frame.id, ok: true, result })
  const fail = (code, message) => write({ v: 1, type: 'result', id: frame.id, ok: false, error: { code, message } })
  if (frame.method === 'status') return reply({ version: 1, opened: true, fts5: true, trigram: true, schema: { knowledge: 1, profile: 1 } })
  if (frame.method !== 'card.get') return reply({ ok: true })
  const id = frame.params.id
  if (id === 'missing') return fail('not_found', 'unknown card: missing')
  if (id === 'slow') return
  if (id === 'crash') return void process.exit(3)
  if (id === 'late') return void setTimeout(() => reply(card('late')), 250)
  if (id === 'split') {
    const text = JSON.stringify({ v: 1, type: 'result', id: frame.id, ok: true, result: { ...card('split'), title: '中文答案🙂' } }) + '\\n'
    const bytes = Buffer.from(text, 'utf8')
    const cut = bytes.indexOf(Buffer.from('🙂', 'utf8')) + 1
    process.stdout.write(bytes.subarray(0, cut))
    return void setTimeout(() => process.stdout.write(bytes.subarray(cut)), 30)
  }
  if (id === 'model' || id === 'model-hang') {
    write({
      v: 1,
      type: 'model.request',
      id: 'm1',
      parentId: frame.id,
      profileId: 'p2',
      effort: frame.params.effort ?? 'high',
      messages: [{ role: 'user', content: '合成内容' }],
      maxTokens: 64
    })
    modelWait = (answer) => reply(card(answer.ok ? answer.text : answer.error.code))
    return
  }
  return reply(card(id))
})
`

let stubDir: string | undefined

function stubScript(): string {
  if (!stubDir) {
    stubDir = mkdtempSync(join(tmpdir(), 'yu-knowledge-stub-'))
    writeFileSync(join(stubDir, 'stub.mjs'), STUB)
  }
  return join(stubDir, 'stub.mjs')
}

function asText(value: KnowledgeCard): string {
  return (value as unknown as { title: string }).title
}

const created: KnowledgeHost[] = []

function host(over: Partial<KnowledgeHostOptions> = {}): KnowledgeHost {
  const script = stubScript()
  const instance = new KnowledgeHost({
    entry: 'unused',
    root: join(tmpdir(), 'yu-knowledge-stub-root'),
    requestMs: 2_000,
    idleMs: 60_000,
    // The same pipes and the same argv the production helper gets.
    spawn: (_entry, root) =>
      spawn(process.execPath, [script, '--root', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    ...over
  })
  created.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of created.splice(0)) await instance.stop()
  rmSync(join(tmpdir(), 'yu-knowledge-stub-root'), { recursive: true, force: true })
})

afterAll(() => {
  if (stubDir) rmSync(stubDir, { recursive: true, force: true })
  stubDir = undefined
})

describe('KnowledgeHost lifetime', () => {
  it('spawns nothing until the first explicit request', async () => {
    const instance = host()
    expect(instance.running).toBe(false)
    expect(instance.pid).toBeUndefined()
    await instance.status()
    expect(instance.running).toBe(true)
    expect(instance.pid).toBeGreaterThan(0)
  })

  it('fails clearly when the executable cannot start', async () => {
    const instance = new KnowledgeHost({
      entry: join(tmpdir(), 'definitely-not-here', 'yu-knowledge.exe'),
      root: tmpdir(),
      requestMs: 2_000
    })
    created.push(instance)
    await expect(instance.status()).rejects.toThrow(/cannot start/)
    expect(instance.running).toBe(false)
  })

  it('answers sequential and parallel requests with their own ids', async () => {
    const instance = host()
    const first = await instance.status()
    expect(first.opened).toBe(true)
    const parallel = await Promise.all([instance.status(), instance.status(), instance.status()])
    expect(parallel).toHaveLength(3)
    for (const answer of parallel) expect(answer.opened).toBe(true)
  })

  it('reads a frame split in the middle of a four-byte character', async () => {
    const instance = host()
    expect(asText(await instance.getCard('split'))).toBe('中文答案🙂')
  })

  it('surfaces helper errors as KnowledgeError with their code', async () => {
    const instance = host()
    await expect(instance.getCard('missing')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('times out and cancels instead of waiting forever', async () => {
    const instance = host({ requestMs: 120 })
    const started = Date.now()
    await expect(instance.getCard('slow')).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
    await expect(instance.status()).resolves.toMatchObject({ opened: true })
  })

  it('ignores a late answer instead of settling a newer request', async () => {
    const instance = host({ requestMs: 100 })
    await expect(instance.getCard('late')).rejects.toMatchObject({ code: 'timeout' })
    const after = await instance.getCard('after')
    expect(after.id).toBe('after')
  })

  it('fails pending work when the helper dies and starts a new one after', async () => {
    const instance = host()
    await instance.status()
    const before = instance.pid
    await expect(instance.getCard('crash')).rejects.toMatchObject({ code: 'internal' })
    expect(instance.running).toBe(false)
    await expect(instance.getCard('fresh')).resolves.toMatchObject({ id: 'fresh' })
    expect(instance.pid).not.toBe(before)
  })

  it('leaves after the idle window and comes back on demand', async () => {
    const instance = host({ idleMs: 80 })
    await instance.status()
    expect(instance.running).toBe(true)
    const deadline = Date.now() + 3_000
    while (instance.running && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    expect(instance.running).toBe(false)
    await expect(instance.status()).resolves.toMatchObject({ opened: true })
  })

  it('stops on request and rejects everything still in flight', async () => {
    const instance = host()
    await instance.status()
    const pending = expect(instance.getCard('slow')).rejects.toMatchObject({ code: 'cancelled' })
    await instance.stop()
    await pending
    expect(instance.running).toBe(false)
  })
})

describe('KnowledgeHost model callbacks', () => {
  it('answers a model request through the injected completer', async () => {
    const completer = vi.fn(async (_call: ModelCall) => '提炼结果')
    const instance = host({ completer })
    expect(asText(await instance.getCard('model'))).toBe('提炼结果')
    expect(completer).toHaveBeenCalledTimes(1)
    const call = completer.mock.calls[0][0]
    expect(call.profileId).toBe('p2')
    expect(call.effort).toBe('high')
    expect(call.maxTokens).toBe(64)
    expect(call.messages).toEqual([{ role: 'user', content: '合成内容' }])
    expect(call.signal.aborted).toBe(false)
  })

  it('reports the code the bridge failed with', async () => {
    const completer = vi.fn(async (_call: ModelCall): Promise<string> => {
      throw new KnowledgeError('model_unavailable', '没有启用的对话模型配置')
    })
    const instance = host({ completer })
    // The stub echoes the failure code back as the card title.
    expect(asText(await instance.getCard('model'))).toBe('model_unavailable')
    expect(completer).toHaveBeenCalledTimes(1)
  })

  it('aborts the model call when the host stops', async () => {
    let seen: AbortSignal | undefined
    const completer = vi.fn((call: { signal: AbortSignal }) => {
      seen = call.signal
      return new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const instance = host({ completer })
    const pending = expect(instance.getCard('model-hang')).rejects.toMatchObject({ code: 'cancelled' })
    const deadline = Date.now() + 2_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
    expect(completer).toHaveBeenCalled()
    await instance.stop()
    expect(seen?.aborted).toBe(true)
    await pending
  })
})
