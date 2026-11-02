import { strict as assert } from 'node:assert'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const baseline = option('--baseline', 'c4d4ca5')
const modelDir = option('--memory-model', join(process.env.APPDATA, 'typeless-rebuild/memory/model'))
const output = resolve(option('--output', join(root, 'tests/yu-v2/evidence/model-workers-20261103.json')))

if (!process.argv.includes('--probe')) {
  const directory = mkdtempSync(join(root, 'scripts/.model-benchmark-'))
  try {
    const build = createRequire(require.resolve('vite'))('esbuild').build
    const old = execFileSync('git', ['show', `${baseline}:src/main/local-asr/worker.ts`], { cwd: root, encoding: 'utf8' })
    await build({ stdin: { contents: old, resolveDir: join(root, 'src/main/local-asr'), sourcefile: 'baseline-asr.ts', loader: 'ts' }, outfile: join(directory, 'before-asr.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
    const oldMemory = execFileSync('git', ['show', `${baseline}:src/main/memory/worker.ts`], { cwd: root, encoding: 'utf8' })
    await build({ stdin: { contents: oldMemory, resolveDir: join(root, 'src/main/memory'), sourcefile: 'baseline-memory.ts', loader: 'ts' }, outfile: join(directory, 'before-memory.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': join(root, 'src/shared') }, logLevel: 'silent' })
    for (const [entry, file] of [['local-asr/worker.ts', 'after-asr.cjs'], ['memory/worker.ts', 'memory.cjs'], ['memory/catalog.ts', 'catalog.cjs']]) {
      await build({ entryPoints: [join(root, 'src/main', entry)], outfile: join(directory, file), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': join(root, 'src/shared') }, logLevel: 'silent' })
    }
    writeFileSync(join(directory, 'no-sdk.cjs'), "require('node:module').registerHooks({resolve(name,context,next){if(name==='mem0ai/oss')throw Error('Read-only recall loaded Mem0');return next(name,context)}})")
    mkdirSync(join(directory, 'profile'))
    const env = { ...process.env, TEMP: directory, TMP: directory, HF_HOME: directory, TRANSFORMERS_CACHE: directory, MEM0_TELEMETRY: 'false', MEM0_DIR: join(directory, 'sdk') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [fileURLToPath(import.meta.url), '--probe', '--directory', directory, '--memory-model', modelDir, '--baseline', baseline, '--output', output], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 180_000)
    try { const [code] = await once(child, 'exit'); if (code !== 0) process.exitCode = code ?? 1 } finally { clearTimeout(timer) }
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(join(root, 'scripts')))
    rmSync(directory, { recursive: true, force: true })
  }
} else {
  const { app, utilityProcess } = require('electron')
  const directory = option('--directory')
  app.setPath('userData', join(directory, 'profile')); app.setPath('sessionData', join(directory, 'profile')); app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const koffi = require('koffi'), kernel = koffi.load('kernel32.dll')
    const open = kernel.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)'), close = kernel.func('int CloseHandle(void *handle)')
    const getMemory = kernel.func('int K32GetProcessMemoryInfo(void *handle, void *buffer, uint32_t bytes)')
    function snapshot(pid) {
      const handle = open(0x410, 0, pid)
      assert.ok(handle, 'Could not open benchmark process')
      try {
        const buffer = Buffer.alloc(96); buffer.writeUInt32LE(96)
        assert.equal(getMemory(handle, buffer, 96), 1)
        return { privateResidentBytes: Number(buffer.readBigUInt64LE(80)), workingSetBytes: Number(buffer.readBigUInt64LE(16)), committedBytes: Number(buffer.readBigUInt64LE(72)) }
      } finally { close(handle) }
    }
    const children = new Set()
    async function start(entry, home, noSdk = false) {
      mkdirSync(home, { recursive: true })
      const began = performance.now(), pending = new Map(), child = utilityProcess.fork(entry, [], { stdio: 'pipe', serviceName: 'YU model benchmark',
        execArgv: noSdk ? ['--require', join(directory, 'no-sdk.cjs')] : [],
        env: { ...process.env, MEM0_DIR: join(home, 'sdk'), YU_BENCH_BEFORE_ASR: join(directory, 'before-asr.cjs'), YU_BENCH_AFTER_ASR: join(directory, 'after-asr.cjs'), YU_BENCH_CATALOG: join(directory, 'catalog.cjs') } })
      children.add(child)
      const exited = once(child, 'exit')
      let diagnostics = ''
      child.stdout.on('data', () => {}); child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000) })
      let sequence = 0
      child.on('message', message => { const p = pending.get(message.id); if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(Error(message.error)) : p.resolve(message) } })
      child.on('exit', code => { children.delete(child); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error(`Benchmark worker exited (${code}): ${diagnostics}`)) } pending.clear() })
      const send = params => new Promise((resolve, reject) => {
        const id = ++sequence, began = performance.now(), timer = setTimeout(() => { pending.delete(id); reject(Error('Benchmark request timed out')) }, 60_000)
        pending.set(id, { timer, reject, resolve: message => resolve({ ...message, roundTripMs: performance.now() - began }) })
        child.postMessage({ id, ...params })
      })
      const spawned = child.pid ? Promise.resolve() : once(child, 'spawn')
      await spawned
      return { child, send, spawnedMs: performance.now() - began, stop: async () => { const at = performance.now(); child.kill(); await exited; return { exited: true, ms: performance.now() - at } } }
    }
    const stats = samples => {
      const values = key => samples.map(s => s[key]).sort((a, b) => a - b)
      const wall = values('roundTripMs'), operation = values('ms')
      return { p50Ms: wall[Math.floor(wall.length / 2)], p95Ms: wall[Math.ceil(wall.length * .95) - 1], operationP50Ms: operation[Math.floor(operation.length / 2)], samples }
    }
    const sample = async (worker, params, check = () => {}) => {
      check((await worker.send(params)).value)
      const samples = []
      for (let i = 0; i < 7; i++) {
        const message = await worker.send(params); check(message.value)
        samples.push({ roundTripMs: message.roundTripMs, ms: message.ms ?? null, cpuMs: message.cpuMs ?? null, conversionMs: message.value?.conversionMs ?? null })
      }
      return stats(samples)
    }
    function wav(seconds) {
      const bytes = seconds * 32000, buffer = Buffer.alloc(44 + bytes)
      buffer.write('RIFF'); buffer.writeUInt32LE(bytes + 36, 4); buffer.write('WAVEfmt ', 8)
      buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24)
      buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(bytes, 40)
      for (let at = 44; at < buffer.length; at += 2) buffer.writeInt16LE(at % 65536 - 32768, at)
      return new Uint8Array(buffer)
    }
    try {
      let cancellation
      {
        const child = utilityProcess.fork(join(root, 'tests/yu-v2/fixtures/model-worker.cjs'), [], { stdio: 'pipe', serviceName: 'YU model cancel benchmark' })
        children.add(child)
        const exited = once(child, 'exit'), result = { initialKill: null, killAfterSpawn: null }
        const deadline = setTimeout(() => child.kill(), 5000)
        child.stdout.on('data', () => {}); child.stderr.on('data', () => {})
        child.once('spawn', () => { result.killAfterSpawn = child.kill() })
        result.initialKill = child.kill()
        await exited; clearTimeout(deadline); children.delete(child)
        assert.ok(result.initialKill || result.killAfterSpawn)
        cancellation = { ...result, exited: true, note: 'Real utilityProcess early-kill/late-spawn API probe; host cancellation regression is covered separately by tests.' }
      }
      const rounds = []
      for (let round = 0; round < 2; round++) {
        // These packages carry different ONNX DLLs. Match production isolation;
        // loading both runtimes in one process would invalidate the measurement.
        const asr = await start(join(root, 'tests/yu-v2/fixtures/model-worker.cjs'), join(directory, 'asr-' + round))
        const asrEmpty = await asr.send({ action: 'snapshot' })
        const asrStages = [{ stage: 'empty-utility', memory: snapshot(asr.child.pid), js: asrEmpty.memory, spawnedMs: asr.spawnedMs }]
        const runtime = await asr.send({ action: 'asr-runtime' }); assert.equal(runtime.value.imported, true)
        asrStages.push({ stage: 'asr-runtime', operationMs: runtime.ms, memory: snapshot(asr.child.pid), js: runtime.memory })
        const pcm = []
        for (const seconds of [3, 60, 180]) {
          const audio = wav(seconds), a = await asr.send({ action: 'pcm', variant: 'before', wav: audio }), b = await asr.send({ action: 'pcm', variant: 'after', wav: audio })
          const check = value => { assert.equal(value.count, a.value.count); assert.equal(value.hash, a.value.hash) }
          check(b.value)
          for (const variant of round ? ['after', 'before'] : ['before', 'after']) pcm.push({ seconds, variant,
            intermediatePcmBytes: variant === 'before' ? seconds * 32000 : 0, ...await sample(asr, { action: 'pcm', variant, wav: audio }, check) })
        }
        const asrCleanup = await asr.stop()
        const worker = await start(join(root, 'tests/yu-v2/fixtures/model-worker.cjs'), join(directory, 'components-' + round))
        const empty = await worker.send({ action: 'snapshot' }), stages = [{ stage: 'empty-utility', memory: snapshot(worker.child.pid), js: empty.memory, spawnedMs: worker.spawnedMs }]
        for (const action of ['sdk', 'transformers', 'model']) {
          if ((action === 'transformers' || action === 'model') && !existsSync(join(modelDir, 'onnx/model_quantized.onnx'))) break
          const result = await worker.send({ action, modelDir })
          stages.push({ stage: action, roundTripMs: result.roundTripMs, operationMs: result.ms, cpuMs: result.cpuMs, memory: snapshot(worker.child.pid), js: result.memory })
          console.log(JSON.stringify({ round, completed: action }))
        }
        let inference
        if (stages.some(s => s.stage === 'model')) {
          const tokenize = await sample(worker, { action: 'tokenize' })
          const embed = await sample(worker, { action: 'embed' }, value => { assert.equal(value.dimension, 512); assert.ok(Math.abs(value.norm - 1) < 1e-4) })
          const home = join(directory, 'components-' + round)
          await worker.send({ action: 'store', home })
          const search = await sample(worker, { action: 'search' }, value => assert.equal(value.count, 5))
          const catalogSearch = await sample(worker, { action: 'catalog-search', home }, value => assert.equal(value.count, 5))
          const oracle = (await worker.send({ action: 'oracle', home })).value
          const fullMemory = snapshot(worker.child.pid), js = (await worker.send({ action: 'snapshot' })).memory
          await worker.send({ action: 'dispose' })
          inference = { tokenize, embed, search1000SyntheticRows: search, catalogSearch1000SyntheticRows: catalogSearch, oracle, fullMemory, js, afterDispose: snapshot(worker.child.pid) }
        }
        rounds.push({ round, asrStages, asrCleanup, stages, pcm, inference, cleanup: await worker.stop() })
      }
      const production = []
      if (existsSync(join(modelDir, 'onnx/model_quantized.onnx'))) for (let round = 0; round < 2; round++) {
        const home = join(directory, 'production-' + round), writer = await start(join(directory, 'before-memory.cjs'), home)
        await writer.send({ method: 'init', home, modelDir })
        const text = '用户喜欢简短直接的中文回答'
        const add = await writer.send({ method: 'add', kind: 'assistant', text, sourceId: 'manual' }); assert.equal(add.value, true)
        await writer.send({ method: 'add', kind: 'style', text: '用户明确要求写作用简短句子', sourceId: 'manual' })
        const query = { method: 'recall', kind: 'assistant', text: '我的回答风格是什么' }
        const expected = (await writer.send(query)).value
        const styleQuery = { method: 'recall', kind: 'style', text: '我的写作偏好是什么' }, expectedStyle = (await writer.send(styleQuery)).value
        await writer.stop()
        for (const variant of round ? ['after', 'before'] : ['before', 'after']) {
          const worker = await start(join(directory, variant === 'before' ? 'before-memory.cjs' : 'memory.cjs'), home, variant === 'after')
          await worker.send({ method: 'init', home, modelDir })
          const catalog = await worker.send({ method: 'list', kind: 'assistant' }), catalogMemory = snapshot(worker.child.pid)
          assert.equal(catalog.value.length, 1)
          const hash = kind => createHash('sha256').update(readFileSync(join(home, kind + '.db'))).digest('hex')
          const original = [hash('assistant'), hash('style')]
          const first = await worker.send(query); assert.deepEqual(first.value, expected)
          const recall = await sample(worker, query, value => assert.deepEqual(value, expected))
          assert.deepEqual((await worker.send(styleQuery)).value, expectedStyle)
          if (variant === 'after') assert.deepEqual([hash('assistant'), hash('style')], original)
          production.push({ round, variant, noSdkImportGuard: variant === 'after', databasesUnchanged: variant === 'after' ? true : null,
            catalogMs: catalog.roundTripMs, catalogMemory, addFirstModelAndSdkMs: add.roundTripMs,
            firstRecallMs: first.roundTripMs, recall, loadedMemory: snapshot(worker.child.pid), cleanup: await worker.stop() })
        }
        const cleaner = await start(join(directory, 'memory.cjs'), home)
        await cleaner.send({ method: 'init', home, modelDir }); await cleaner.send({ method: 'clear' })
        assert.deepEqual((await cleaner.send({ method: 'list', kind: 'assistant' })).value, [])
        assert.deepEqual((await cleaner.send({ method: 'list', kind: 'style' })).value, [])
        await cleaner.stop()
        console.log(JSON.stringify({ round, completed: 'production-memory' }))
      }
      const report = { date: new Date().toISOString(), baseline, electron: process.versions.electron, node: process.versions.node, platform: `${os.release()} ${process.arch}`, cpu: os.cpus()[0].model,
        model: existsSync(join(modelDir, 'onnx/model_quantized.onnx')) ? { bytes: readFileSync(join(modelDir, 'onnx/model_quantized.onnx')).length, sha256: createHash('sha256').update(readFileSync(join(modelDir, 'onnx/model_quantized.onnx'))).digest('hex') } : null,
        asrRecognition: { measured: false, reason: 'This probe measures runtime import and synthetic PCM conversion only, without loading an ASR recognition model or downloading models.' },
        sourceSha256: Object.fromEntries(['local-asr/worker.ts', 'memory/worker.ts', 'memory/catalog.ts', 'memory/host.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(root, 'src/main', file))).digest('hex')])),
        scope: 'Two isolated Electron utility-process rounds, with ASR and memory in separate processes. Memory component stages include prior imports; deltas are not exact model weight ownership. Private resident, working set and private commit use K32 EX2; JS metrics use process.memoryUsage. These are snapshots, not total-app/peak RAM. Synthetic text/audio and separate databases only; no user memories, recordings, network or LLMs. PCM round-trip/operation times include Float32 hashing; conversionMs excludes hashing and IPC. One warmup then seven samples; CPU timing has OS granularity. Production memory workers are bundled from baseline/current sources and readers run in interleaved order on the same synthetic stores; firstRecallMs excludes worker startup/init and OS caches are not flushed. New reader forbids Mem0 imports and checks database hashes. No application startup/LLM or ASR decoding benchmark is implied. All owned workers exit and temporary data are removed.',
        cancellation, rounds, production }
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ complete: true, output, rounds: rounds.length, production: production.length }))
    } finally {
      for (const child of children) { const exited = once(child, 'exit'); child.kill(); await exited }
    }
  }).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
}
