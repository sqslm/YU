import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { windowsNative } from './windows-native'

const fixture = resolve('tests/yu-v2/fixtures/uia-provider.ps1')
const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const children: ChildProcessWithoutNullStreams[] = []
const lines = (text: string): string[] => text.split(/\r?\n/)

interface Fixture {
  handle: string
  pid: number
  title: string
  file?: string
  send: (command: object) => void
  events: { type: string; id?: string; name?: string; controlType?: string }[]
}

/** Value getter calls the fixture actually observed, one event per read. */
const reads = (fixtureRun: Fixture): Fixture['events'] => fixtureRun.events.filter(event => event.type === 'value-read')

/** Owned, non-activating provider: the fixture creates and owns this window. */
function start(mode: string): Promise<Fixture> {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const events: { type: string; id?: string; name?: string; controlType?: string }[] = []
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
        let event: { type: string; handle?: string; pid?: number; title?: string; file?: string }
        try { event = JSON.parse(line) } catch { continue }
        events.push(event)
        if (event.type !== 'ready') continue
        clearTimeout(timer)
        ready({
          handle: String(Number(BigInt(event.handle ?? '0'))),
          pid: Number(event.pid),
          title: String(event.title),
          file: event.file,
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

/**
 * Helpers spawned by this test worker. Filtering on the parent pid keeps the assertions stable
 * when other test files on the same machine run their own helpers at the same time.
 */
const childrenOf = (parentPid: number): number[] => {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='yu-windows.exe'\" | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return lines(String(result.stdout))
    .map(line => line.trim().split(','))
    .filter(parts => parts.length === 2 && Number(parts[1]) === parentPid)
    .map(parts => Number(parts[0]))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}

const owned = (): number[] => childrenOf(process.pid)

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Waits for the helper started by the pending request, so a blocked provider is released promptly. */
const waitForHelper = async (before: Set<number>, timeoutMs = 20_000): Promise<number[]> => {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const running = owned().filter(pid => !before.has(pid))
    if (running.length > 0) return running
    if (performance.now() > deadline) return []
    await new Promise(done => setTimeout(done, 250))
  }
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
  pending.catch(() => {})
  const running = await waitForHelper(before)
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
  pending.catch(() => {})
  await waitForHelper(before)
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
  pending.catch(() => {})
  const running = await waitForHelper(before)
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
  // Sixty requests leave headroom: the sampler misses a few helpers when the
  // machine is busy, and the contract is thirty observed pids, not every one.
  for (let index = 0; index < 60; index++) {
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
}, 180_000)

it.skipIf(process.platform !== 'win32')('retires the helper when its own parent dies after a complete request', async () => {
  // The helper is given a request and an EOF on stdin before its parent dies,
  // so this is the parent-death path, not the "stdin never closed" one.
  const fixtureRun = await start('address-edit')
  fixtureRun.send({ command: 'block' })
  await settle(fixtureRun, 'blocking')
  const body = JSON.stringify({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  const parent = spawn(process.execPath, ['-e', [
    'const { spawn } = require("node:child_process")',
    'const child = spawn(process.argv[1], ["--parent-pid", String(process.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })',
    'child.stdout.on("data", () => {})',
    'child.stdin.end(process.argv[2] + String.fromCharCode(10))',
    'setInterval(() => {}, 1000)',
  ].join('\n'), resolve('native/bin/yu-windows.exe'), body], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(parent)
  await settle(fixtureRun, 'blocked')
  const helper = childrenOf(parent.pid as number)
  expect(helper).toHaveLength(1)
  expect(alive(helper[0])).toBe(true)
  expect(alive(parent.pid as number)).toBe(true)
  process.kill(parent.pid as number)
  const deadline = performance.now() + 10_000
  while (alive(helper[0]) && performance.now() < deadline) await new Promise(done => setTimeout(done, 100))
  expect(alive(helper[0])).toBe(false)
  fixtureRun.send({ command: 'unblock' })
  await settle(fixtureRun, 'unblocked')
}, 90_000)

it.skipIf(process.platform !== 'win32')('reads the address bar value once and never an excluded candidate', async () => {
  const address = await start('address-edit')
  expect(await windowsNative({ action: 'browser-url', handle: address.handle, pid: address.pid, title: address.title })).toMatchObject({ url: 'https://example.com/a' })
  expect(reads(address).filter(event => event.id === 'addressEditBox')).toHaveLength(1)

  // A page-level field that names itself like the address bar sits behind the
  // Document boundary: the walk rejects it, so its value must never be read.
  const pseudo = await start('pseudo-address')
  const result = await windowsNative({ action: 'browser-url', handle: pseudo.handle, pid: pseudo.pid, title: pseudo.title })
  expect(result).toEqual({ title: pseudo.title, truncated: false })
  expect(reads(pseudo).filter(event => event.controlType === 'Edit')).toHaveLength(0)
}, 90_000)

it.skipIf(process.platform !== 'win32')('never touches an excluded candidate whose value blocks', async () => {
  const fixtureRun = await start('excluded-value-blocked')
  const started = performance.now()
  const result = await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  const elapsed = performance.now() - started
  expect(result).toEqual({ title: fixtureRun.title, truncated: false })
  // Reading that value would wait out the fixture's two-second gate.
  expect(elapsed).toBeLessThan(1_500)
  expect(reads(fixtureRun).filter(event => event.controlType === 'Edit')).toHaveLength(0)
  expect(fixtureRun.events.some(event => event.type === 'value-blocked')).toBe(false)
}, 60_000)

it.skipIf(process.platform !== 'win32')('ignores a candidate that exposes no ValuePattern at all', async () => {
  const fixtureRun = await start('no-value-pattern')
  const result = await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  expect(result).toEqual({ title: fixtureRun.title, truncated: false })
  // Structure was inspected, but no value could be read.
  expect(reads(fixtureRun)).toHaveLength(0)
}, 60_000)

it.skipIf(process.platform !== 'win32')('skips the document value in metadata mode without an address bar', async () => {
  const bare = await start('metadata-document')
  const skipped = await windowsNative({ action: 'browser-url', handle: bare.handle, pid: bare.pid, title: bare.title, metadataOnly: true })
  expect(skipped).toEqual({ title: bare.title, truncated: false })
  expect(reads(bare)).toHaveLength(0)

  // With an address bar present the old rule still lets one unique document URL win.
  const both = await start('metadata-override')
  const overridden = await windowsNative({ action: 'browser-url', handle: both.handle, pid: both.pid, title: both.title, metadataOnly: true })
  expect(overridden).toEqual({ title: both.title, url: 'https://example.com/from-doc', truncated: false })
  expect(reads(both).filter(event => event.controlType === 'Document')).toHaveLength(1)
}, 90_000)

it.skipIf(process.platform !== 'win32')('turns a file address into the exact local path of a real file', async () => {
  const fixtureRun = await start('file-url')
  expect(fixtureRun.file).toBeTruthy()
  const expected = String(fixtureRun.file)
  const result = await windowsNative({ action: 'browser-url', handle: fixtureRun.handle, pid: fixtureRun.pid, title: fixtureRun.title })
  expect(result).toEqual({ title: fixtureRun.title, path: expected, truncated: false })
  // The fixture names the file with Chinese, a space and a literal percent sign.
  expect(expected).toContain('中文 100%')
  expect(existsSync(expected)).toBe(true)
}, 60_000)
