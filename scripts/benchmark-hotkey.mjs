// Compare the pre-migration worker and Rust in an isolated Electron process.
// Only F8 is bound; injected input is enabled only in this probe's children.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import os from 'node:os'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? fallback : process.argv[index + 1]
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

if (!process.argv.includes('--probe')) {
  if (process.platform !== 'win32') throw new Error('This benchmark requires Windows')
  const baseline = option('--baseline', '17521ae660ac05335e3073f6e2e9261bfef71c4d')
  const directory = mkdtempSync(join(root, 'scripts/.hotkey-benchmark-'))
  try {
    for (const file of ['child.ts', 'keys.ts', 'swallow.ts']) {
      const source = execFileSync('git', ['show', `${baseline}:src/main/hotkey/${file}`], { cwd: root })
      writeFileSync(join(directory, file), source)
    }
    const esbuild = createRequire(require.resolve('vite'))('esbuild')
    await esbuild.build({ entryPoints: [join(directory, 'child.ts')], outfile: join(directory, 'legacy.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['koffi'], logLevel: 'silent' })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const args = [fileURLToPath(import.meta.url), '--probe', '--directory', directory, '--baseline', baseline, '--idle-ms', option('--idle-ms', '10000')]
    if (option('--output')) args.push('--output', resolve(option('--output')))
    const child = spawn(require('electron'), args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    const [code] = await once(child, 'exit')
    if (code !== 0) process.exitCode = code ?? 1
  } finally {
    // Only this invocation's generated source and isolated profile are removed.
    rmSync(directory, { recursive: true, force: true })
  }
} else {
  const { app, utilityProcess } = require('electron')
  const directory = option('--directory')
  const profile = join(directory, 'profile')
  mkdirSync(profile)
  app.setPath('userData', profile)
  app.disableHardwareAcceleration()
  // Do not await readiness at ESM top level: Electron waits for the entry module
  // to finish loading before emitting ready.
  app.whenReady().then(async () => {
  const koffi = require('koffi')
  const sendInput = koffi.load('user32.dll').func('uint32_t SendInput(uint32_t nInputs, void *inputs, int size)')
  function key(down) {
    const input = Buffer.alloc(40)
    input.writeUInt32LE(1, 0); input.writeUInt16LE(0x77, 8)
    input.writeUInt32LE(down ? 0 : 2, 12)
    if (sendInput(1, input, 40) !== 1) throw new Error('SendInput was blocked')
  }
  function snapshot(pid) {
    // PrivateMemorySize64 is private COMMITTED bytes, not private working set.
    const code = `$p=Get-Process -Id ${pid}; [pscustomobject]@{atMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cpuMs=$p.TotalProcessorTime.TotalMilliseconds;privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64}|ConvertTo-Json -Compress`
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true }))
  }
  const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]
  let current
  try {
    const rounds = []
    for (const variant of ['legacy', 'rust', 'rust', 'legacy']) {
      const began = performance.now()
      const child = variant === 'legacy'
        ? utilityProcess.fork(join(directory, 'legacy.cjs'), [], { env: { ...process.env, TYPELESS_ALLOW_INJECTED: '1' }, stdio: 'pipe', serviceName: 'hotkey-baseline' })
        : spawn(join(root, 'native/bin/yu-hotkey.exe'), [], { env: { ...process.env, TYPELESS_ALLOW_INJECTED: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      // Capture termination before it can happen (including ENOENT -> close).
      const finished = new Promise(resolve => child.once(variant === 'legacy' ? 'exit' : 'close', resolve))
      current = { child, finished }
      child.on('error', error => console.error(error))
      child.stderr?.on('data', data => process.stderr.write(data))
      const listeners = new Set()
      const deliver = event => { for (const listener of [...listeners]) listener(event) }
      if (variant === 'legacy') child.on('message', deliver)
      else createInterface({ input: child.stdout }).on('line', line => deliver(JSON.parse(line)))
      function waitFor(type) {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { listeners.delete(receive); reject(new Error(`${variant}: timeout waiting for ${type}`)) }, 5000)
          const receive = event => { if (event.type === type) { clearTimeout(timeout); listeners.delete(receive); resolve(event) } }
          listeners.add(receive)
        })
      }
      await waitFor('ready')
      const readyMs = performance.now() - began
      const config = { type: 'config', bindings: { dictation: ['F8'] }, pasteLast: [], activation: 'hold' }
      if (variant === 'legacy') child.postMessage(config)
      else child.stdin.write(JSON.stringify(config) + '\n')
      await pause(500)
      const before = snapshot(child.pid)
      await pause(Number(option('--idle-ms', '10000')))
      const after = snapshot(child.pid)
      const samples = []
      for (let i = 0; i < 25; i++) {
        const started = waitFor('start'), at = performance.now()
        key(true); await started
        const elapsed = performance.now() - at
        const stopped = waitFor('stop'); key(false); await stopped
        if (i >= 5) samples.push(elapsed)
        await pause(20)
      }
      const elapsedMs = after.atMs - before.atMs
      rounds.push({ variant, readyMs, idleElapsedMs: elapsedMs, cpuMs: after.cpuMs - before.cpuMs,
        cpuPercentOneCore: (after.cpuMs - before.cpuMs) / elapsedMs * 100,
        privateBytes: after.privateBytes, workingSetBytes: after.workingSetBytes,
        injectedKeyToStartP50Ms: quantile(samples, .5), injectedKeyToStartP95Ms: quantile(samples, .95), latencySamples: samples })
      child.kill(); await finished; current = null
      console.log(JSON.stringify(rounds.at(-1)))
    }
    const report = { date: new Date().toISOString(), baseline: option('--baseline'), electron: process.versions.electron,
      platform: `${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, helperBytes: statSync(join(root, 'native/bin/yu-hotkey.exe')).size,
      helperSha256: createHash('sha256').update(readFileSync(join(root, 'native/bin/yu-hotkey.exe'))).digest('hex'),
      scope: 'Worker only, isolated Electron without app windows/models. Private bytes are committed bytes. Latency is injected F8 -> host receives start, including OS/hook/IPC; excludes microphone/model/UI and physical keyboard. CPU percent is relative to one core.', rounds }
    console.log(JSON.stringify(report, null, 2))
    if (option('--output')) writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n')
    app.quit()
  } catch (error) {
    // Balance a probe key even on timeout, then release the hook.
    key(false)
    if (current) { current.child.kill(); await current.finished }
    console.error(error)
    app.exit(1)
  }
  }).catch(error => { console.error(error); app.exit(1) })
}
