// Real UIA acceptance + old/new comparison, using only an owned synthetic form.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve, join, relative, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import os from 'node:os'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!process.argv.includes('--probe')) {
  if (process.platform !== 'win32') throw new Error('Windows is required')
  const baseline = option('--baseline', 'fc05bab')
  const directory = mkdtempSync(join(root, 'scripts/.uia-benchmark-'))
  try {
    const esbuild = createRequire(require.resolve('vite'))('esbuild')
    // Resolve the small dependency graph directly from Git; no working copy or
    // user data is copied, and deleted legacy sources remain reproducible.
    await esbuild.build({ entryPoints: [join(root, 'src/main/uia/child.ts')], outfile: join(directory, 'legacy.cjs'),
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'baseline', setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (!args.path.startsWith('.') && !args.path.startsWith('@shared/') && !isAbsolute(args.path)) return { path: args.path, external: true }
          let path = args.path.startsWith('@shared/') ? join(root, 'src/shared', args.path.slice(8)) : resolve(args.resolveDir || root, args.path)
          if (!extname(path)) path += '.ts'
          return { path, namespace: 'baseline' }
        })
        build.onLoad({ filter: /.*/, namespace: 'baseline' }, args => ({
          contents: execFileSync('git', ['show', `${baseline}:${relative(root, args.path).replaceAll('\\', '/')}`], { cwd: root, encoding: 'utf8' }),
          loader: args.path.endsWith('.json') ? 'json' : 'ts', resolveDir: dirname(args.path)
        }))
      } }] })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const args = [fileURLToPath(import.meta.url), '--probe', '--directory', directory, '--baseline', baseline]
    if (option('--output')) args.push('--output', resolve(option('--output')))
    const child = spawn(require('electron'), args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    const [code] = await once(child, 'exit'); if (code !== 0) process.exitCode = code ?? 1
  } finally { rmSync(directory, { recursive: true, force: true }) }
} else {
  const { app, utilityProcess } = require('electron')
  const directory = option('--directory')
  const profile = join(directory, 'profile'); mkdirSync(profile)
  app.setPath('userData', profile); app.disableHardwareAcceleration()
  // ESM entry evaluation must finish before Electron emits ready.
  app.whenReady().then(async () => {
    const koffi = require('koffi'), kernel = koffi.load('kernel32.dll')
    const open = kernel.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)')
    const memory = kernel.func('int K32GetProcessMemoryInfo(void *process, void *out, uint32_t size)')
    const times = kernel.func('int GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)')
    const close = kernel.func('int CloseHandle(void *handle)')
    const user32 = koffi.load('user32.dll')
    const foregroundWindow = user32.func('void *GetForegroundWindow()')
    const foregroundPid = user32.func('uint32_t GetWindowThreadProcessId(void *window, uint32_t *pid)')
    function assertFixtureFocus() {
      const window = foregroundWindow(), pid = Buffer.alloc(4)
      foregroundPid(window, pid)
      assert.equal(pid.readUInt32LE(), fixtureState.processId, 'the synthetic form must own foreground')
      assert.equal(String(koffi.address(window)), fixtureState.windowHandle, 'the synthetic form HWND must match')
    }
    function resources(pid) {
      const handle = open(0x410, 0, pid); if (!handle) throw new Error('Cannot open worker for measurement')
      try {
        const buffer = Buffer.alloc(96); buffer.writeUInt32LE(96)
        if (!memory(handle, buffer, 96)) throw new Error('EX2 memory measurement unavailable')
        const created = Buffer.alloc(8), exited = Buffer.alloc(8), k = Buffer.alloc(8), u = Buffer.alloc(8)
        if (!times(handle, created, exited, k, u)) throw new Error('Process CPU time unavailable')
        return { privateResidentBytes: Number(buffer.readBigUInt64LE(80)), workingSetBytes: Number(buffer.readBigUInt64LE(16)),
          committedBytes: Number(buffer.readBigUInt64LE(72)), cpuMs: Number(k.readBigUInt64LE() + u.readBigUInt64LE()) / 10000, atMs: performance.now() }
      } finally { close(handle) }
    }
    function channel(child, utility = false) {
      const finished = new Promise(resolve => child.once(utility ? 'exit' : 'close', resolve))
      const listeners = new Set()
      const deliver = event => { for (const receive of [...listeners]) receive(event) }
      child.on('error', error => console.error(error.message))
      child.stderr?.on('data', data => process.stderr.write(data))
      if (utility) child.on('message', deliver)
      else createInterface({ input: child.stdout }).on('line', line => deliver(JSON.parse(line)))
      return { child, finished, wait(predicate, budget = 5000) {
        return new Promise((resolve, reject) => {
          const finish = (error, event) => { clearTimeout(timer); listeners.delete(receive); error ? reject(error) : resolve(event) }
          const receive = event => { if (predicate(event)) finish(null, event) }
          const timer = setTimeout(() => finish(new Error('UIA probe response timed out')), budget)
          listeners.add(receive)
          finished.then(() => finish(new Error('UIA probe process closed')))
        })
      } }
    }
    let fixture, current, fixtureState, seq = 0
    const rounds = [], checks = []
    try {
      fixture = channel(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', join(root, 'tests/yu-v2/fixtures/uia-window.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
      fixtureState = await fixture.wait(e => e.type === 'fixture', 15000)
      assert.equal(fixtureState.keyboardFocus, true, 'synthetic editor must have real keyboard focus')
      async function mode(name) {
        const response = fixture.wait(e => e.type === 'fixture' && e.mode === name)
        fixture.child.stdin.write(name + '\n'); fixtureState = await response
        assert.equal(fixtureState.keyboardFocus, true, `synthetic ${name} control must have real keyboard focus`)
        await pause(60)
      }
      const target = () => ({ processId: fixtureState.processId, windowHandle: fixtureState.windowHandle, windowTitle: fixtureState.windowTitle })
      async function worker(variant) {
        const at = performance.now()
        const child = variant === 'legacy' ? utilityProcess.fork(join(directory, 'legacy.cjs'), [], { stdio: 'pipe', serviceName: 'uia-baseline' })
          : spawn(join(root, 'native/bin/yu-uia.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        current = channel(child, variant === 'legacy')
        await current.wait(e => e.type === 'ready')
        const readyMs = performance.now() - at
        return { readyMs, async read(overrides) {
          const id = ++seq, response = current.wait(e => e.type === 'result' && e.id === id)
          const request = { type: 'read', id, target: { ...target(), ...overrides } }
          if (variant === 'legacy') child.postMessage(request); else child.stdin.write(JSON.stringify(request) + '\n')
          return (await response).snapshot
        } }
      }
      const percentile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1]
      for (const variant of ['legacy', 'rust', 'rust', 'legacy']) {
        await mode('edit')
        const hook = await worker(variant)
        await mode('edit')
        assertFixtureFocus()
        const at = performance.now(), first = await hook.read()
        assert.equal(first?.value, fixtureState.expectedValue, `${variant}: editable fixture must be read`)
        const coldReadMs = performance.now() - at
        assert.equal(await hook.read({ processId: 0 }), null)
        if (variant === 'rust' && !checks.length) {
          assert.equal(first.controlType, 'edit'); assert.equal(first.controlTypeId, 50004)
          for (const name of ['readonly', 'long', 'button', 'password']) {
            await mode(name); const snapshot = await hook.read()
            if (name === 'readonly') { assert.equal(snapshot?.readOnly, true); assert.equal(snapshot.value, fixtureState.expectedValue) }
            if (name === 'long') { assert.equal(snapshot?.value, fixtureState.expectedValue.slice(-4000)); assert.equal(snapshot.valueTruncated, true) }
            if (name === 'button') {
              assert.equal(fixtureState.focusedControl, 'Button')
              assert.equal(snapshot?.controlType, 'button', JSON.stringify({ fixtureFocus: fixtureState.focusedControl, className: snapshot?.className, controlTypeId: snapshot?.controlTypeId }))
              assert.equal(snapshot.value, '')
            }
            if (name === 'password') assert.equal(snapshot, null)
            checks.push({ mode: name, passed: true })
          }
          await mode('edit')
        }
        const samples = []
        for (let i = 0; i < 25; i++) {
          const at = performance.now(), snapshot = await hook.read()
          assert.equal(snapshot?.value, fixtureState.expectedValue)
          if (i >= 5) samples.push(performance.now() - at)
        }
        const before = resources(current.child.pid); await pause(2000); const after = resources(current.child.pid)
        rounds.push({ variant, readyMs: hook.readyMs, coldReadMs, coldReadyPlusReadMs: hook.readyMs + coldReadMs,
          readP50Ms: percentile(samples, .5), readP95Ms: percentile(samples, .95), readSamples: samples,
          privateResidentBytes: after.privateResidentBytes, workingSetBytes: after.workingSetBytes, committedBytes: after.committedBytes,
          idleElapsedMs: after.atMs - before.atMs, idleCpuMs: after.cpuMs - before.cpuMs })
        current.child.kill(); await current.finished; current = null
        console.log(JSON.stringify(rounds.at(-1)))
      }
      // A real blocked provider proves pipe EOF cleanup works independently of COM.
      const hung = await worker('rust'); await mode('hang')
      let returned = false
      const blocked = hung.read().then(() => { returned = true }, () => {})
      await pause(150); assert.equal(returned, false, 'fixture must actually block the provider')
      const at = performance.now(); current.child.stdin.end(); await current.finished; await blocked
      assert.ok(performance.now() - at < 1500, 'EOF must exit even while UIA is blocked')
      checks.push({ mode: 'blocked-provider-eof', passed: true, exitMs: performance.now() - at }); current = null
      const binary = readFileSync(join(root, 'native/bin/yu-uia.exe'))
      const report = { date: new Date().toISOString(), baseline: option('--baseline'), electron: process.versions.electron,
        platform: `${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, helperBytes: binary.length, helperSha256: createHash('sha256').update(binary).digest('hex'),
        scope: 'Worker only, same owned Windows Forms editable control, isolated Electron. EX2 private resident, working set and private commit are distinct. Read latency includes UIA and IPC. No user window text is read or saved. Idle CPU timing is informational; no percentage reduction is inferred.', checks, rounds }
      if (option('--output')) writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ checks, complete: true }))
      app.quit()
    } catch (error) { console.error(error); process.exitCode = 1 }
    finally {
      if (current) { current.child.kill(); await current.finished }
      // This is our disposable form, including when its UI thread is blocked.
      if (fixture) { fixture.child.kill(); await fixture.finished }
      app.exit(process.exitCode || 0)
    }
  }).catch(error => { console.error(error); app.exit(1) })
}
