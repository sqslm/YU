import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { windowsNative } from './windows-native'

const fixture = resolve('tests/yu-v2/fixtures/uia-provider.ps1')
const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const children: ChildProcessWithoutNullStreams[] = []
const lines = (text: string): string[] => text.split(/\r?\n/)

interface Fixture { handle: string; pid: number; title: string; send: (command: object) => void; events: { type: string }[] }

/** Owned, non-activating provider: the fixture creates and owns this window. */
function start(mode: string): Promise<Fixture> {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const events: { type: string }[] = []
  let buffered = ''
  return new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`fixture ${mode} did not become ready`)), 30_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const parts = lines(buffered)
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        let event: { type: string; handle?: string; pid?: number; title?: string }
        try { event = JSON.parse(line) } catch { continue }
        events.push(event)
        if (event.type !== 'ready') continue
        clearTimeout(timer)
        ready({
          handle: String(Number(BigInt(event.handle ?? '0'))),
          pid: Number(event.pid),
          title: String(event.title),
          events,
          send: command => child.stdin.write(`${JSON.stringify(command)}\n`),
        })
      }
    })
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`fixture ${mode} exited early (${code})`)) })
  })
}

/** Waits for the fixture's acknowledgement of a command. */
function settle(fixtureRun: Fixture, type: string): Promise<void> {
  const deadline = performance.now() + 20_000
  return new Promise((done, fail) => {
    const poll = (): void => {
      if (fixtureRun.events.some(event => event.type === type)) return done()
      if (performance.now() > deadline) return fail(new Error(`fixture never reported ${type}`))
      setTimeout(poll, 25)
    }
    poll()
  })
}

/** Helper processes that were already running before this suite started. */
const preexisting = new Set<number>()

const owned = (): number[] => {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq yu-windows.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return lines(String(result.stdout)).map(line => Number(line.split('","')[1]?.replace(/"/g, ''))).filter(pid => Number.isInteger(pid) && pid > 0)
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.stdin.write('{"command":"quit"}\n'); child.stdin.end() } catch {}
    await new Promise(done => setTimeout(done, 50))
    if (child.exitCode === null) child.kill()
  }
})

it.skipIf(process.platform !== 'win32')('reads the address of the owned provider through the production runner', async () => {
  const fixtureRun = await start('address-edit')
  const result = await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  expect(result).toEqual({ title: fixtureRun.title, url: 'https://example.com/a', truncated: false })
}, 45_000)

it.skipIf(process.platform !== 'win32')('rejects a live window once its title or owner pid no longer match', async () => {
  const fixtureRun = await start('address-edit')
  await expect(windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: `${fixtureRun.title} (stale)` })).rejects.toThrow('Original window has changed or closed')
  await expect(windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid + 1, title: fixtureRun.title })).rejects.toThrow('Original window has changed or closed')
  fixtureRun.send({ command: 'retitle', title: 'uia fixture - retitled' })
  await settle(fixtureRun, 'title')
  await expect(windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })).rejects.toThrow('Original window has changed or closed')
  expect(await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: 'uia fixture - retitled' })).toMatchObject({ title: 'uia fixture - retitled', url: 'https://example.com/a' })
}, 60_000)

it.skipIf(process.platform !== 'win32')('rechecks the window after a slow read and refuses a title that changed meanwhile', async () => {
  const fixtureRun = await start('address-edit')
  fixtureRun.send({ command: 'block' })
  await settle(fixtureRun, 'blocking')
  const before = new Set(owned())
  const pending = windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  await new Promise(done => setTimeout(done, 1_000))
  const running = owned().filter(pid => !before.has(pid))
  expect(running).toHaveLength(1)
  fixtureRun.send({ command: 'retitle', title: 'uia fixture - changed during read' })
  fixtureRun.send({ command: 'unblock' })
  await expect(pending).rejects.toThrow('Original window has changed or closed')
  expect(running.filter(pid => alive(pid))).toHaveLength(0)
}, 60_000)

it.skipIf(process.platform !== 'win32')('refuses a window destroyed while the provider was blocked', async () => {
  const fixtureRun = await start('address-edit')
  fixtureRun.send({ command: 'block' })
  await settle(fixtureRun, 'blocking')
  const before = new Set(owned())
  const pending = windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  await new Promise(done => setTimeout(done, 1_000))
  fixtureRun.send({ command: 'destroy' })
  fixtureRun.send({ command: 'unblock' })
  await expect(pending).rejects.toThrow()
  expect(owned().filter(pid => !before.has(pid) && alive(pid))).toHaveLength(0)
}, 60_000)

it.skipIf(process.platform !== 'win32')('cancels a blocked read, kills that helper and leaves the next request independent', async () => {
  const fixtureRun = await start('address-edit')
  fixtureRun.send({ command: 'block' })
  await settle(fixtureRun, 'blocking')
  const before = new Set(owned())
  const controller = new AbortController()
  const pending = windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title }, controller.signal)
  await new Promise(done => setTimeout(done, 1_000))
  const running = owned().filter(pid => !before.has(pid))
  expect(running).toHaveLength(1)
  controller.abort()
  await expect(pending).rejects.toThrow('Cancelled')
  await new Promise(done => setTimeout(done, 500))
  expect(running.filter(pid => alive(pid))).toHaveLength(0)
  fixtureRun.send({ command: 'unblock' })
  await settle(fixtureRun, 'unblocked')
  expect(await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })).toMatchObject({ url: 'https://example.com/a' })
}, 60_000)

it.skipIf(process.platform !== 'win32')('times out a blocked read after the production budget and kills that helper', async () => {
  const fixtureRun = await start('address-edit')
  fixtureRun.send({ command: 'block' })
  await settle(fixtureRun, 'blocking')
  const before = new Set(owned())
  const started = performance.now()
  await expect(windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })).rejects.toThrow('Windows operation timed out')
  const elapsed = performance.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(14_000)
  expect(elapsed).toBeLessThan(20_000)
  const running = owned().filter(pid => !before.has(pid))
  await new Promise(done => setTimeout(done, 500))
  expect(running.filter(pid => alive(pid))).toHaveLength(0)
  fixtureRun.send({ command: 'unblock' })
  await settle(fixtureRun, 'unblocked')
}, 90_000)

it.skipIf(process.platform !== 'win32')('retires the helper of consecutive requests, observing at least thirty distinct pids', async () => {
  // A hundred candidate edits keeps each helper alive long enough to be seen;
  // one long-lived PowerShell streams helper pids so sampling costs the event
  // loop nothing while the requests run.
  const fixtureRun = await start('edits-101')
  for (const pid of owned()) preexisting.add(pid)
  const seen = new Set<number>()
  const sampler = spawn(powershell, ['-NoProfile', '-Command', "while ($true) { ((Get-Process -Name yu-windows -ErrorAction SilentlyContinue).Id -join ','); Start-Sleep -Milliseconds 5 }"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(sampler)
  let buffered = ''
  sampler.stdout.setEncoding('utf8')
  sampler.stdout.on('data', (chunk: string) => {
    buffered += chunk
    const parts = lines(buffered)
    buffered = parts.pop() ?? ''
    for (const part of parts) for (const text of part.split(',')) {
      const pid = Number(text)
      if (Number.isInteger(pid) && pid > 0 && !preexisting.has(pid)) seen.add(pid)
    }
  })
  for (let index = 0; index < 40; index++) {
    const result = await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
    expect(result).toMatchObject({ url: 'https://example.com/edit', truncated: false })
  }
  sampler.kill()
  // Positive control: a live process is reported alive by the same probe.
  expect(alive(process.pid)).toBe(true)
  // The sampler observes most, not all, of the short-lived helpers.
  expect(seen.size).toBeGreaterThanOrEqual(30)
  expect([...seen].filter(pid => alive(pid))).toHaveLength(0)
  expect(owned().filter(pid => !preexisting.has(pid) && alive(pid))).toHaveLength(0)
}, 120_000)
