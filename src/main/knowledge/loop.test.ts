import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { KnowledgeError } from '@shared/knowledge'

import { KnowledgeHost, type KnowledgeHostOptions } from './host'
import type { ModelCall } from './model'

/**
 * The closed loop the two halves could not prove before: the production host
 * drives a real Rust process over real pipes, that process writes a
 * `model.request` frame, the answer travels back through the host, and the Rust
 * side that asked for it answers its own parent request.
 *
 * The fixture is `native/knowledge/bin/fixture.rs`, built with
 * `--features fixture` only — it is never packaged. It is not a mock: the frame
 * reader, the `Link` and the cancellation token are the production code.
 */
const root = process.cwd()
const manifest = join(root, 'native', 'knowledge', 'Cargo.toml')
const fixturePath = join(
  root,
  'native',
  'knowledge',
  'target',
  'debug',
  process.platform === 'win32' ? 'yu-knowledge-fixture.exe' : 'yu-knowledge-fixture'
)

beforeAll(() => {
  execFileSync(
    'cargo',
    ['build', '--features', 'fixture', '--bin', 'yu-knowledge-fixture', '--manifest-path', manifest],
    { cwd: root, stdio: 'inherit' }
  )
  expect(existsSync(fixturePath)).toBe(true)
}, 600_000)

const created: KnowledgeHost[] = []
let workDir: string | undefined

function host(over: Partial<KnowledgeHostOptions> = {}): KnowledgeHost {
  workDir ??= mkdtempSync(join(tmpdir(), 'yu-knowledge-loop-'))
  const instance = new KnowledgeHost({
    entry: fixturePath,
    root: workDir,
    requestMs: 5_000,
    idleMs: 60_000,
    ...over
  })
  created.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of created.splice(0)) await instance.stop()
})

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  workDir = undefined
})

describe('the Rust helper and the host around a real model callback', () => {
  it('answers a model request that the Rust side asked for', async () => {
    const completer = vi.fn(async (_call: ModelCall) => '夹具闭环答案')
    const instance = host({ completer })
    const page = await instance.searchCards({ query: '石墨' })
    expect(page.total).toBe(1)
    expect(page.items[0].title).toBe('夹具闭环答案')
    expect(completer).toHaveBeenCalledTimes(1)
    const call = completer.mock.calls[0][0]
    expect(call.profileId).toBe('fixture-profile')
    expect(call.effort).toBe('high')
    expect(call.messages).toEqual([{ role: 'user', content: '夹具的合成问题' }])
    // The production ready frame must declare the shared object shape.
    await expect(instance.status()).resolves.toMatchObject({
      running: true,
      schema: { knowledge: 5, profile: 2 }
    })
  }, 60_000)

  it('carries a provider failure back into the Rust request', async () => {
    const completer = vi.fn(async (_call: ModelCall): Promise<string> => {
      throw new KnowledgeError('model_unavailable', '没有启用的对话模型配置')
    })
    const instance = host({ completer })
    await expect(instance.getCard('fixture-card')).rejects.toMatchObject({
      code: 'model_unavailable'
    })
  }, 60_000)

  it('aborts the model call when the Rust request times out', async () => {
    let seen: AbortSignal | undefined
    const completer = vi.fn((call: ModelCall) => {
      seen = call.signal
      return new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const instance = host({ completer, requestMs: 1_500 })
    const pending = expect(instance.searchCards({ query: '慢' })).rejects.toMatchObject({
      code: 'timeout'
    })
    // Wait for the Rust side to actually ask before asserting on the abort, so a
    // slow spawn cannot turn this into a race.
    const deadline = Date.now() + 20_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20))
    }
    await pending
    expect(seen?.aborted).toBe(true)
  }, 60_000)

  it('keeps working after the helper is stopped mid-call', async () => {
    let seen: AbortSignal | undefined
    const completer = vi.fn((call: ModelCall) => {
      if (completer.mock.calls.length > 1) return Promise.resolve('复活答案')
      seen = call.signal
      return new Promise<string>((_resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const instance = host({ completer })
    const first = expect(instance.searchCards({ query: '一' })).rejects.toMatchObject({
      code: 'cancelled'
    })
    const deadline = Date.now() + 20_000
    while (completer.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20))
    }
    expect(completer).toHaveBeenCalledTimes(1)
    const dead = instance.pid
    await instance.stop()
    await first
    expect(seen?.aborted).toBe(true)
    // A new process answers, so the stop really released the old one.
    const page = await instance.searchCards({ query: '二' })
    expect(page.items[0].title).toBe('复活答案')
    expect(instance.pid).not.toBe(dead)
  }, 60_000)

  it('drops a late answer for a reused sub id after a restart', async () => {
    const waiting: ((text: string) => void)[] = []
    const completer = vi.fn(
      (_call: ModelCall) =>
        new Promise<string>((resolve) => {
          waiting.push(resolve)
        })
    )
    const instance = host({ completer, requestMs: 2_000 })
    const first = expect(instance.searchCards({ query: '旧' })).rejects.toMatchObject({
      code: 'timeout'
    })
    const deadline = Date.now() + 20_000
    while (waiting.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20))
    }
    await first
    await instance.stop()
    // The new process reuses the sub id `m1` the fixture always sends.
    const second = instance.searchCards({ query: '新' })
    const deadline2 = Date.now() + 20_000
    while (waiting.length < 2 && Date.now() < deadline2) {
      await new Promise((done) => setTimeout(done, 20))
    }
    waiting[1]('新进程答案')
    const page = await second
    expect(page.items[0].title).toBe('新进程答案')
    // The answer of the dead generation arrives now and must change nothing.
    waiting[0]('迟到的旧答案')
    await new Promise((done) => setTimeout(done, 100))
    const third = instance.searchCards({ query: '再' })
    const deadline3 = Date.now() + 20_000
    while (waiting.length < 3 && Date.now() < deadline3) {
      await new Promise((done) => setTimeout(done, 20))
    }
    waiting[2]('仍然正常')
    expect((await third).items[0].title).toBe('仍然正常')
  }, 90_000)

  it('records the fixture binary it ran', () => {
    const size = statSync(fixturePath).size
    expect(size).toBeGreaterThan(1_000_000)
  })
})
