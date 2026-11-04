import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeError, type KnowledgeCard } from '@shared/knowledge'

import { KnowledgeHost, type KnowledgeHostOptions } from './host'
import type { ModelCall } from './model'

/**
 * The stubs speak the real protocol on real pipes, so the host's framing,
 * deadlines, cancellation, model bridge and process generations are exercised
 * without a provider and without touching a database. The compiled helper is
 * covered by `host.integration.test.ts`, and the closed loop with the Rust side
 * by `loop.test.ts`.
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
  if (id === 'late') return void setTimeout(() => reply(card('late')), 2500)
  if (id === 'huge') {
    // 750000 Chinese characters: fewer than 2 MiB as a JS string, more as UTF-8.
    return reply({ ...card('huge'), title: '知'.repeat(750000) })
  }
  if (id === 'huge-no-newline') {
    process.stdout.write('{"v":1,"type":"result","id":"' + frame.id + '","ok":true,"result":{"title":"' + '知'.repeat(900000))
    return
  }
  if (id === 'two-frames') {
    // Two complete frames in a single chunk: the byte limit is per frame.
    process.stdout.write(
      JSON.stringify({ v: 1, type: 'changed', scope: 'cards' }) + '\\n' +
        JSON.stringify({ v: 1, type: 'result', id: frame.id, ok: true, result: card('two-frames') }) + '\\n'
    )
    return
  }
  if (id === 'bad-error') return write({ v: 1, type: 'result', id: frame.id, ok: false })
  if (id === 'null-error') return write({ v: 1, type: 'result', id: frame.id, ok: false, error: null })
  if (id === 'typed-error')
    return write({ v: 1, type: 'result', id: frame.id, ok: false, error: { code: 1, message: [] } })
  if (id === 'null-frame') {
    process.stdout.write('null\\n')
    process.stdout.write('[1,2]\\n')
    process.stdout.write('not json\\n')
    return reply(card('after-garbage'))
  }
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
  if (id === 'model-orphan') {
    write({
      v: 1, type: 'model.request', id: 'm9', parentId: 'r999999',
      profileId: 'p2', effort: 'high', messages: [{ role: 'user', content: '无父请求' }], maxTokens: 8
    })
    return reply(card('model-orphan'))
  }
  if (id === 'model-duplicate') {
    // Both frames in one write so the duplicate is seen before any answer.
    const duplicate = { v: 1, type: 'model.request', id: 'm1', parentId: frame.id, profileId: 'p2', effort: 'high', messages: [{ role: 'user', content: '重复子ID' }], maxTokens: 8 }
    process.stdout.write(JSON.stringify(duplicate) + '\\n' + JSON.stringify(duplicate) + '\\n')
    modelWait = (answer) => reply(card(answer.text ?? 'duplicate-done'))
    return
  }
  return reply(card(id))
})
`

/** Never writes `ready`: the host's deadline has to cover the handshake. */
const SILENT = `
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', () => {})
`

/** Writes `ready` only after the deadline has already passed. */
const LATE_READY = `
setTimeout(() => {
  process.stdout.write(JSON.stringify({ v: 1, type: 'ready', schema: { knowledge: 1, profile: 1 }, fts5: true, trigram: true }) + '\\n')
}, 250)
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', () => {})
`

/** Announces readiness with the old numeric schema: the handshake must not settle. */
const PARTIAL_READY = `
import { createInterface } from 'node:readline'
process.stdout.write(JSON.stringify({ v: 1, type: 'ready', schema: 1, fts5: true, trigram: true }) + '\\n')
createInterface({ input: process.stdin }).on('line', () => {})
`

/** A helper that dies during startup: the pipe breaks under the first request. */
const EXIT = `process.exit(4)`

let stubDir: string | undefined
const scripts = new Map<string, string>()

function stubScript(body: string, name: string): string {
  stubDir ??= mkdtempSync(join(tmpdir(), 'yu-knowledge-stub-'))
  const path = scripts.get(name) ?? join(stubDir, `${name}.mjs`)
  if (!scripts.has(name)) {
    writeFileSync(path, body)
    scripts.set(name, path)
  }
  return path
}

function asText(value: KnowledgeCard): string {
  return (value as unknown as { title: string }).title
}

const created: KnowledgeHost[] = []

/**
 * A broken frame must never reach the Electron main process as an uncaught
 * exception, so the suite records them instead of letting Node print them.
 */
const thrown: unknown[] = []
const observe = (error: unknown): void => {
  thrown.push(error)
}

beforeAll(() => {
  process.on('uncaughtException', observe)
})

beforeEach(() => {
  thrown.length = 0
})

afterAll(() => {
  process.off('uncaughtException', observe)
})

function host(over: Partial<KnowledgeHostOptions> = {}, stub = STUB, name = 'stub'): KnowledgeHost {
  const script = stubScript(stub, name)
  const instance = new KnowledgeHost({
    entry: 'unused',
    root: join(tmpdir(), 'yu-knowledge-stub-root'),
    requestMs: 2_000,
    idleMs: 60_000,
    // The same pipes and the same argv the production helper gets.
    spawn: (_entry, root) =>
      spawn(process.execPath, [script, '--root', root], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams,
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
  scripts.clear()
})

describe('KnowledgeHost lifetime', () => {
  it('spawns nothing for construction or an unused status query', async () => {
    const instance = host()
    expect(instance.running).toBe(false)
    expect(instance.pid).toBeUndefined()
    await expect(instance.status()).resolves.toEqual({
      version: 1,
      running: false,
      schema: null,
      opened: false,
      fts5: null,
      trigram: null
    })
    expect(instance.running).toBe(false)
    expect(instance.pid).toBeUndefined()
  })

  it('starts on the first explicit data request and reports live values', async () => {
    const instance = host()
    expect(asText(await instance.getCard('warm'))).toBe('warm')
    expect(instance.running).toBe(true)
    expect(instance.pid).toBeGreaterThan(0)
    await expect(instance.status()).resolves.toMatchObject({
      running: true,
      opened: true,
      fts5: true,
      trigram: true,
      schema: { knowledge: 1, profile: 1 }
    })
  })

  it('fails clearly when the executable cannot start', async () => {
    const instance = new KnowledgeHost({
      entry: join(tmpdir(), 'definitely-not-here', 'yu-knowledge.exe'),
      root: tmpdir(),
      requestMs: 2_000
    })
    created.push(instance)
    await expect(instance.getCard('x')).rejects.toThrow(/cannot start/)
    expect(instance.running).toBe(false)
  })

  it('times out a helper that never becomes ready and reclaims it', async () => {
    const instance = host({ requestMs: 120 }, SILENT, 'silent')
    await expect(instance.getCard('any')).rejects.toMatchObject({ code: 'timeout' })
    // The unusable process is gone instead of idling behind every later request.
    expect(instance.running).toBe(false)
    await expect(instance.getCard('any')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('does not restart the deadline when ready arrives too late', async () => {
    const instance = host({ requestMs: 100 }, LATE_READY, 'late-ready')
    const started = Date.now()
    await expect(instance.getCard('any')).rejects.toMatchObject({ code: 'timeout' })
    // A ready that arrives after the deadline must not answer this request.
    await new Promise((done) => setTimeout(done, 300))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(instance.running).toBe(false)
  })

  it('rejects a request that was waiting for ready when the host stops', async () => {
    const instance = host({ requestMs: 5_000 }, SILENT, 'silent')
    const pending = expect(instance.getCard('any')).rejects.toMatchObject({ code: 'cancelled' })
    await instance.stop()
    await pending
    expect(instance.running).toBe(false)
  })

  it('answers sequential and parallel requests with their own ids', async () => {
    const instance = host()
    expect(asText(await instance.getCard('first'))).toBe('first')
    const parallel = await Promise.all([
      instance.getCard('a'),
      instance.getCard('b'),
      instance.getCard('c')
    ])
    expect(parallel.map(asText)).toEqual(['a', 'b', 'c'])
  })

  it('reads a frame split in the middle of a four-byte character', async () => {
    const instance = host()
    expect(asText(await instance.getCard('split'))).toBe('中文答案🙂')
  })

  it('survives frames that are not objects and keeps the stream', async () => {
    const instance = host()
    expect(asText(await instance.getCard('null-frame'))).toBe('after-garbage')
    expect(asText(await instance.getCard('still-alive'))).toBe('still-alive')
  })

  it('surfaces helper errors as KnowledgeError with their code', async () => {
    const instance = host()
    await expect(instance.getCard('missing')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('times out and cancels instead of waiting forever', async () => {
    const instance = host({ requestMs: 600 })
    const started = Date.now()
    await expect(instance.getCard('slow')).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
    await expect(instance.getCard('after')).resolves.toMatchObject({ id: 'after' })
  })

  it('ignores a late answer instead of settling a newer request', async () => {
    const instance = host({ requestMs: 2_000 })
    await expect(instance.getCard('late')).rejects.toMatchObject({ code: 'timeout' })
    // The stub recalls the abandoned request id 500 ms after the deadline.
    await new Promise((done) => setTimeout(done, 700))
    expect(asText(await instance.getCard('after'))).toBe('after')
  })

  it('fails pending work when the helper dies and starts a new one after', async () => {
    const instance = host()
    await instance.getCard('warm')
    const before = instance.pid
    await expect(instance.getCard('crash')).rejects.toMatchObject({ code: 'internal' })
    expect(instance.running).toBe(false)
    await expect(instance.getCard('fresh')).resolves.toMatchObject({ id: 'fresh' })
    expect(instance.pid).not.toBe(before)
  })

  it('reports a broken pipe as a failure instead of hanging', async () => {
    const instance = host({ requestMs: 1_000 }, EXIT, 'exit-early')
    await expect(instance.getCard('any')).rejects.toMatchObject({ code: 'internal' })
    expect(instance.running).toBe(false)
  })

  it('leaves after the idle window and comes back on demand', async () => {
    const instance = host({ idleMs: 80 })
    await instance.getCard('warm')
    expect(instance.running).toBe(true)
    const deadline = Date.now() + 3_000
    while (instance.running && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
    expect(instance.running).toBe(false)
    await expect(instance.getCard('again')).resolves.toMatchObject({ id: 'again' })
  })

  it('stops on request and rejects everything still in flight', async () => {
    const instance = host()
    await instance.getCard('warm')
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

  it('aborts the model call when the parent request times out', async () => {
    let seen: AbortSignal | undefined
    const completer = vi.fn((call: { signal: AbortSignal }) => {
      seen = call.signal
      return new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const instance = host({ completer, requestMs: 800 })
    const pending = expect(instance.getCard('model-hang')).rejects.toMatchObject({ code: 'timeout' })
    const deadline = Date.now() + 2_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(completer).toHaveBeenCalledTimes(1)
    await pending
    expect(seen?.aborted).toBe(true)
  })

  it('aborts the model call when the host stops', async () => {
    let seen: AbortSignal | undefined
    const completer = vi.fn((call: { signal: AbortSignal }) => {
      seen = call.signal
      return new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const instance = host({ completer, requestMs: 5_000 })
    const pending = expect(instance.getCard('model-hang')).rejects.toMatchObject({ code: 'cancelled' })
    const deadline = Date.now() + 2_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10))
    }
    await instance.stop()
    expect(seen?.aborted).toBe(true)
    await pending
  })

  it('ignores a model request whose parent is not in flight', async () => {
    const completer = vi.fn(async (_call: ModelCall) => '不该被调用')
    const instance = host({ completer })
    expect(asText(await instance.getCard('model-orphan'))).toBe('model-orphan')
    expect(completer).not.toHaveBeenCalled()
  })

  it('drops a duplicate model sub id and answers once', async () => {
    const completer = vi.fn(async (_call: ModelCall) => '唯一答案')
    const instance = host({ completer })
    expect(asText(await instance.getCard('model-duplicate'))).toBe('唯一答案')
    expect(completer).toHaveBeenCalledTimes(1)
  })

  it('does not write a late model answer into a replaced process', async () => {
    let release: ((text: string) => void) | undefined
    const completer = vi.fn(
      (_call: ModelCall) =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    // The deadline only has to be tight compared with the completer, which never
    // answers; it must still be generous enough to survive a respawn under load.
    const instance = host({ completer, requestMs: 2_000 })
    const first = expect(instance.getCard('model')).rejects.toMatchObject({ code: 'timeout' })
    const deadline = Date.now() + 2_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10))
    }
    await first
    await instance.stop()
    // The answer of the dead generation arrives after a new process exists.
    await expect(instance.getCard('fresh')).resolves.toMatchObject({ id: 'fresh' })
    release?.('迟到的答案')
    await new Promise((done) => setTimeout(done, 60))
    expect(asText(await instance.getCard('still-fine'))).toBe('still-fine')
  })
})

describe('KnowledgeHost framing and envelopes', () => {
  it('rejects a frame whose UTF-8 bytes exceed the transport limit', async () => {
    const instance = host({ requestMs: 8_000 })
    const failure = await instance.getCard('huge').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KnowledgeError)
    expect((failure as KnowledgeError).code).toBe('internal')
    expect((failure as KnowledgeError).message).toMatch(/oversized frame/)
    expect(thrown).toEqual([])
    // The process that broke the limit is gone, and a new one answers.
    expect(instance.running).toBe(false)
    expect(asText(await instance.getCard('after-huge'))).toBe('after-huge')
  })

  it('rejects a frame that never ends with a newline once it passes the limit', async () => {
    const instance = host({ requestMs: 8_000 })
    await expect(instance.getCard('huge-no-newline')).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringMatching(/oversized frame/)
    })
    expect(thrown).toEqual([])
    expect(instance.running).toBe(false)
    expect(asText(await instance.getCard('after-noise'))).toBe('after-noise')
  })

  it('accepts several complete frames that arrive in one chunk', async () => {
    const scopes: string[] = []
    const instance = host({ onChanged: (scope) => scopes.push(scope) })
    expect(asText(await instance.getCard('two-frames'))).toBe('two-frames')
    expect(scopes).toEqual(['cards'])
    expect(instance.running).toBe(true)
  })

  it('rejects a failure result that carries no usable error', async () => {
    for (const probe of ['bad-error', 'null-error', 'typed-error']) {
      const instance = host()
      await expect(instance.getCard(probe)).rejects.toMatchObject({
        code: 'internal',
        message: expect.stringMatching(/usable error/)
      })
      expect(instance.running).toBe(false)
    }
    expect(thrown).toEqual([])
  })

  it('does not release the handshake for an unusable ready frame', async () => {
    const instance = host({ requestMs: 2_000 }, PARTIAL_READY, 'partial-ready')
    await expect(instance.getCard('any')).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringMatching(/unusable ready/)
    })
    expect(thrown).toEqual([])
    expect(instance.running).toBe(false)
  })
})
