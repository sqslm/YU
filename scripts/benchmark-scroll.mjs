import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { createRequire } from 'node:module'
import { cpus, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const baseline = option('--baseline') ?? 'd3d4008'
const output = resolve(root, option('--output') ?? 'tests/yu-v2/evidence/rust-scroll-20261103.json')
const old = spawnSync('git', ['show', `${baseline}:src/main/scroll-capture.ts`], { cwd: root, encoding: 'utf8', windowsHide: true })
if (old.status !== 0) throw new Error(old.stderr || 'Could not read baseline')
const source = old.stdout.replaceAll('\r\n', '\n')
function load(source, filename) {
  const exports = {}
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  compileFunction(js, ['exports', 'require'], { filename })(exports, name => {
    if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => root } }
    if (name.startsWith('.')) { const path = resolve(dirname(filename), name + '.ts'); return load(readFileSync(path, 'utf8'), path) }
    return require(name)
  })
  return exports
}
const before = load(source + '\nexport { matchScroll }\n', 'baseline-scroll-capture.ts')
// Keep the alternative out of production: identical scores, but a compact mask
// for just the columns that difference() actually reads. Fail if the baseline drifts.
function replace(text, from, to) { assert.ok(text.includes(from), 'Baseline changed; review the sparse-mask comparison'); return text.replaceAll(from, to) }
let sparseSource = replace(source,
  'const changed = new Uint8Array(width * height)\n  for (let pixel = 0; pixel < changed.length; pixel++) {\n    const i = pixel * 4\n    changed[pixel] = Number(Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]) > 12)\n  }',
  'const margin = Math.max(1, Math.floor(width * .03)), stride = Math.max(1, Math.floor(width / 64))\n  const columns = Math.max(0, Math.ceil((width - margin * 2) / stride)), changed = new Uint8Array(columns * height)\n  for (let y = 0; y < height; y++) for (let column = 0; column < columns; column++) {\n    const i = (y * width + margin + column * stride) * 4\n    changed[y * columns + column] = Number(Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]) > 12)\n  }')
sparseSource = replace(sparseSource, 'const overlap = height - offset - bottom, margin = Math.max(1, Math.floor(width * .03))', 'const overlap = height - offset - bottom, margin = Math.max(1, Math.floor(width * .03))\n  const columns = Math.max(0, Math.ceil((width - margin * 2) / Math.max(1, Math.floor(width / 64))))')
sparseSource = replace(sparseSource, 'changed[a / 4]', 'changed[(y + offset) * columns + Math.floor((x - margin) / Math.max(1, Math.floor(width / 64)))]')
sparseSource = replace(sparseSource, 'changed[b / 4]', 'changed[y * columns + Math.floor((x - margin) / Math.max(1, Math.floor(width / 64)))]')
const sparse = load(sparseSource + '\nexport { matchScroll }\n', 'sparse-scroll-capture.ts')
const after = load(readFileSync(resolve(root, 'src/main/scroll-capture.ts'), 'utf8'), resolve(root, 'src/main/scroll-capture.ts'))
const native = load(readFileSync(resolve(root, 'src/main/scroll-match.ts'), 'utf8'), resolve(root, 'src/main/scroll-match.ts'))
const variants = { typescript: before, sparseTypescript: sparse, rust: { ...after, ...native } }
const coldStart = performance.now()
native.matchScroll(Buffer.alloc(4), Buffer.alloc(4), 1, 1)
const firstDllCallMs = performance.now() - coldStart

const profile = mkdtempSync(resolve(root, 'scripts/.scroll-benchmark-'))
let electronValidation
try {
  const env = { ...process.env, TEMP: profile, TMP: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [resolve(root, 'tests/yu-v2/fixtures/scroll-electron.cjs'), resolve(root, 'native/bin/yu-scroll.dll'), profile], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Electron FFI probe failed')
  electronValidation = JSON.parse(result.stdout.trim())
} finally {
  assert.equal(dirname(realpathSync(profile)), realpathSync(resolve(root, 'scripts')))
  rmSync(profile, { recursive: true, force: true })
}

function page(width, height, top, seed = 7, fixed = false) {
  const pixels = Buffer.alloc(width * height * 4, 255)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = ((y + top) * 1337 + x * 311 + seed * 97) >>> 0
    const shade = (Math.imul(value ^ (value >>> 5), 13)) & 255, i = (y * width + x) * 4
    pixels[i] = shade; pixels[i + 1] = (shade + seed) & 255; pixels[i + 2] = (shade * 3) & 255
  }
  if (fixed) { pixels.fill(40, 0, width * Math.floor(height / 10) * 4); pixels.fill(80, width * Math.floor(height * .9) * 4) }
  return pixels
}

let checks = 0
for (let seed = 1; seed <= 400; seed++) {
  const width = seed % 257 + 1, height = seed * 37 % 199 + 1, top = seed % 5 === 0 ? 0 : seed % height
  const previous = page(width, height, seed % 7 === 0 ? top : 0, seed, seed % 3 === 0)
  const next = page(width, height, seed % 7 === 0 ? 0 : top, seed % 11 === 0 ? seed + 5 : seed, seed % 3 === 0)
  if (seed % 4 === 0) for (let i = 0; i < Math.min(next.length, width * 4 * 7); i++) next[i] = (next[i] + i * 7) & 255
  const originalA = Buffer.from(previous), originalB = Buffer.from(next)
  const expected = before.matchScroll(previous, next, width, height)
  assert.deepEqual(native.matchScroll(previous, next, width, height), expected, `native differential seed ${seed}`)
  assert.deepEqual(sparse.matchScroll(previous, next, width, height), expected, `sparse differential seed ${seed}`)
  assert.deepEqual(previous, originalA); assert.deepEqual(next, originalB); checks++
}
for (const fixed of [false, true]) {
  const captures = Object.values(variants).map(api => new api.ScrollCapture(320, 200))
  for (let i = 0; i <= 20; i++) {
    const frame = page(320, 200, i * 37, 7, fixed)
    const expected = captures[0].add(frame)
    for (const capture of captures.slice(1)) {
      assert.equal(capture.add(frame), expected)
      assert.equal(capture.height, captures[0].height); assert.equal(capture.frames, captures[0].frames)
      assert.deepEqual(capture.pixels(), captures[0].pixels()); assert.deepEqual(capture.preview(), captures[0].preview())
    }
    checks++
  }
}

const stats = samples => {
  const sorted = samples.map(s => s.wallMs).sort((a, b) => a - b)
  const cpu = samples.map(s => s.cpuMs).sort((a, b) => a - b)
  return { p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], cpuP50Ms: cpu[Math.floor(cpu.length / 2)], samples }
}
function measure(run, warmup = 3, count = 7) {
  for (let i = 0; i < warmup; i++) run()
  const samples = []
  for (let i = 0; i < count; i++) {
    const cpu = process.cpuUsage(), start = performance.now()
    run()
    const wallMs = performance.now() - start, used = process.cpuUsage(cpu)
    samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000 })
  }
  return stats(samples)
}

async function pipeCost(frame) {
  // A persistent one-frame binary send/ack, no algorithm or process startup.
  // Node is only a transport probe, not a Rust worker implementation.
  const code = `let bytes=0;process.stdout.write('R');process.stdin.on('data',chunk=>{bytes+=chunk.length;if(bytes===${frame.length}){bytes=0;process.stdout.write('D')}else if(bytes>${frame.length})process.exit(2)})`
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit')
  const deadline = setTimeout(() => child.kill(), 15_000)
  try {
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(15_000) })
    const samples = []
    for (let i = 0; i < 8; i++) {
      const response = once(child.stdout, 'data', { signal: AbortSignal.timeout(15_000) }), start = performance.now()
      child.stdin.write(frame)
      const [ack] = await response
      assert.equal(ack.toString(), 'D')
      if (i) samples.push({ wallMs: performance.now() - start, cpuMs: null })
    }
    return { ...stats(samples), cpuP50Ms: null, note: 'Node binary send/ack transport only; one warmup, seven samples; excludes startup and algorithm; CPU not measured.' }
  } finally {
    child.stdin.end(); child.kill(); await exited; clearTimeout(deadline)
  }
}

const rounds = [], profiles = [], transfers = []
for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
  const previous = page(width, height, 0), next = page(width, height, 271), unrelated = page(width, height, 0, 99)
  for (const name of ['typescript', 'sparseTypescript', 'rust', 'rust', 'sparseTypescript', 'typescript']) {
    const api = variants[name]
    const match = measure(() => assert.equal(api.findScrollOffset(previous, next, width, height), 271))
    const unchanged = measure(() => assert.equal(api.findScrollOffset(previous, previous, width, height), 0))
    const unmatched = measure(() => assert.equal(api.findScrollOffset(previous, unrelated, width, height), null))
    const addAndPreview = measure(() => {
      const capture = new api.ScrollCapture(width, height)
      capture.add(previous); assert.equal(capture.add(next), 'added'); capture.preview()
    })
    rounds.push({ width, height, variant: name, match, unchanged, unmatched, addAndPreview })
  }
  transfers.push({ width, height, bytesPerFrame: next.length,
    copyBothFrames: measure(() => { const a = Buffer.from(previous), b = Buffer.from(next); assert.equal(a.length + b.length, previous.length * 2) }),
    oneFramePipe: await pipeCost(next),
    maskBytes: { typescript: width * height, sparseTypescriptAndRust: Math.max(0, Math.ceil((width - 2 * Math.max(1, Math.floor(width * .03))) / Math.max(1, Math.floor(width / 64)))) * height } })
  const session = new Session(); session.connect()
  try {
    await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 100 }); await session.post('Profiler.start')
    for (let i = 0; i < 30; i++) before.findScrollOffset(previous, next, width, height)
    const { profile } = await session.post('Profiler.stop')
    const counts = new Map()
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    profiles.push({ width, height, samplingIntervalUs: 100, sampleCount: profile.samples?.length,
      functions: profile.nodes.filter(node => node.callFrame.url === 'baseline-scroll-capture.ts').map(node => ({ function: node.callFrame.functionName, selfSamples: counts.get(node.id) ?? 0, positionTicks: node.positionTicks ?? [] })) })
  } finally { session.disconnect() }
}
const binary = readFileSync(resolve(root, 'native/bin/yu-scroll.dll'))
const report = { date: new Date().toISOString(), baseline, node: process.version, platform: `${release()} ${process.arch}`, cpu: cpus()[0].model,
  dllBytes: binary.length, dllSha256: createHash('sha256').update(binary).digest('hex'), baselineSourceSha256: createHash('sha256').update(source).digest('hex'), checks, firstDllCallMs, electronValidation,
  scope: 'Synthetic BGRA frames only; no screen capture, user pixels or persisted images. Seven samples per operation after three warmups in interleaved rounds. Timings include JS/FFI matching and, separately, chunk copying plus raw preview sampling; exclude GDI capture, PNG encoding, UI, first DLL load and application startup. CPU is process CPU with OS accounting granularity. Mask sizes follow allocations, not total-app or peak RAM. Pipe timings use a separate persistent Node send/ack probe, not a Rust backend. V8 samples cover the baseline after timing, with transpiled source line numbers.',
  rounds, transfers, profiles }
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, checks, rounds: rounds.map(({ width, height, variant, match, addAndPreview }) => ({ width, height, variant, matchP50Ms: match.p50Ms, addPreviewP50Ms: addAndPreview.p50Ms })) }))
