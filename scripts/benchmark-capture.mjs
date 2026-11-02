import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const baseline = option('--baseline') ?? '872e5b5'
const output = resolve(root, option('--output') ?? 'tests/yu-v2/evidence/rust-capture-20261103.json')
const crate = resolve(root, 'native/capture')
const dll = resolve(root, 'native/bin/yu-capture.dll')
// The crate is a measured candidate rather than a shipped helper, so the benchmark builds it itself.
const build = spawnSync('cargo', ['build', '--release', '--locked', '--offline'], { cwd: crate, stdio: 'inherit', windowsHide: true })
if (build.error) throw new Error('Rust MSVC toolchain is required: ' + build.error.message)
if (build.status !== 0) process.exit(build.status ?? 1)
mkdirSync(dirname(dll), { recursive: true })
copyFileSync(resolve(crate, 'target/release/yu_capture.dll'), dll)

const fixture = resolve(root, 'tests/yu-v2/fixtures/capture-electron.cjs')
const baselineSource = execFileSync('git', ['show', `${baseline}:src/main/capture-screen.ts`], { cwd: root, encoding: 'utf8', windowsHide: true })

const scenarios = [
  { name: '720p', width: 1280, height: 720 },
  { name: '1080p', width: 1920, height: 1080 },
]

const profileRoot = mkdtempSync(join(root, 'scripts', '.capture-benchmark-'))
const results = []
try {
  for (const scenario of scenarios) {
    const env = {
      ...process.env,
      CAPTURE_DLL: dll,
      CAPTURE_BASELINE: baseline,
      CAPTURE_SCENARIO: JSON.stringify(scenario),
      TEMP: profileRoot,
      TMP: profileRoot,
    }
    delete env.ELECTRON_RUN_AS_NODE
    const started = performance.now()
    const result = spawnSync(require('electron'), [fixture], {
      env,
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    })
    if (result.status !== 0) throw new Error(`${scenario.name}: ${result.stderr || result.error?.message || 'fixture failed'}`)
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('__RESULT__'))
    if (!line) throw new Error(`${scenario.name}: no result line: ${result.stdout.slice(0, 400)}${result.stderr.slice(0, 400)}`)
    const payload = JSON.parse(line.slice('__RESULT__'.length))
    payload.wallSeconds = Number(((performance.now() - started) / 1000).toFixed(1))
    results.push(payload)
  }
} finally {
  if (dirname(realpathSync(profileRoot)) === realpathSync(resolve(root, 'scripts'))) {
    rmSync(profileRoot, { recursive: true, force: true })
  }
}

// The page paints RGBA; GDI hands back BGRA.
const expectedPixel = (x, y) => [(x * 13 + y * 17) & 255, (x * 11 + y * 7) & 255, (x * 5 + y * 3) & 255, 255]
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])

const verification = []
for (const scenario of results) {
  const hashes = new Set(Object.values(scenario.verification.hashes).map((entry) => entry.sha256))
  const probes = Object.entries(scenario.verification.probes)
  const failures = []
  if (hashes.size !== 1) failures.push(`variant buffers differ: ${[...hashes].join(', ')}`)
  const production = scenario.verification.production
  if (!production?.matchesMeasured) failures.push('src/main/capture-screen.ts output differs from the measured implementations')
  for (const [name, probe] of probes) {
    const width = scenario.scenario.width
    const height = scenario.scenario.height
    const checks = [
      ['red', [0, 0, 255, 255]],
      ['green', [0, 255, 0, 255]],
      ['blue', [255, 0, 0, 255]],
      ['white', [255, 255, 255, 255]],
      ['firstBodyRow', expectedPixel(3, 120)],
      ['lastRowOddColumn', expectedPixel(width - 1, height - 1)],
    ]
    for (const [key, expected] of checks) {
      if (!same(probe[key], expected)) failures.push(`${name}.${key} ${JSON.stringify(probe[key])} != ${JSON.stringify(expected)}`)
    }
    for (const sample of [...probe.bottomRowSamples, ...probe.rowShifts]) {
      if (!same(sample.actual, sample.expected)) failures.push(`${name} at ${sample.x},${sample.y} ${JSON.stringify(sample.actual)} != ${JSON.stringify(sample.expected)}`)
    }
    if (!probe.alphaOpaque) failures.push(`${name} has transparent pixels`)
  }
  verification.push({
    scenario: scenario.scenario.name,
    ok: failures.length === 0,
    failures,
    sha256: [...hashes][0] ?? null,
    production,
    leaks: scenario.leak,
  })
}

const pct = (from, to) => Number((((from - to) / from) * 100).toFixed(1))
const compare = (scenario, metric) => {
  const entry = scenario.metrics[metric]
  const cpu = scenario.cpuBatches[metric]
  return {
    metric,
    A: { p50: entry.A.wall.p50, p95: entry.A.wall.p95, cpuPerCall: cpu.A.cpuMsPerCall },
    B: { p50: entry.B.wall.p50, p95: entry.B.wall.p95, cpuPerCall: cpu.B.cpuMsPerCall },
    C: { p50: entry.C.wall.p50, p95: entry.C.wall.p95, cpuPerCall: cpu.C.cpuMsPerCall },
    rustVsCachedP50Pct: pct(entry.B.wall.p50, entry.C.wall.p50),
    rustVsCachedP95Pct: pct(entry.B.wall.p95, entry.C.wall.p95),
    baselineVsCachedP50Pct: pct(entry.A.wall.p50, entry.B.wall.p50),
  }
}

const comparisons = results.map((scenario) => ({
  scenario: scenario.scenario.name,
  scenarios: {
    buffer: compare(scenario, 'buffer'),
    image: compare(scenario, 'image'),
    thumbnail: compare(scenario, 'thumbnail'),
    scroll: compare(scenario, 'scroll'),
  },
}))

const leaksOk = verification.every((entry) => Object.values(entry.leaks).every((leak) => leak.deltaGdi <= 0 && leak.deltaUser <= 0))
const pixelsOk = verification.every((entry) => entry.ok)
const bufferRows = comparisons.flatMap((entry) => [entry.scenarios.buffer])
const adoptP50 = bufferRows.every((entry) => entry.rustVsCachedP50Pct >= 10)
const adoptP95 = bufferRows.every((entry) => entry.rustVsCachedP95Pct >= -5)
const decision = pixelsOk && leaksOk && adoptP50 && adoptP95 ? 'adopt' : 'reject'

const binary = readFileSync(dll)
const report = {
  date: new Date().toISOString(),
  baseline,
  baselineSourceSha256: createHash('sha256').update(baselineSource).digest('hex'),
  node: process.version,
  electron: require('electron/package.json').version,
  platform: `${release()} ${process.arch}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  dll: { path: 'native/bin/yu-capture.dll', bytes: statSync(dll).size, sha256: createHash('sha256').update(binary).digest('hex') },
  scope:
    'Three implementations of the same GDI rectangle capture inside one Electron main process, on one synthetic opaque top-level window that is painted, made topmost and captured by its own content bounds (1920x1080 display, 100% scale). A is the 872e5b5 TypeScript (Koffi bindings re-created per call, NativeImage result); B keeps the same bindings cached and returns the raw BGRA buffer; C calls the Rust DLL. Interleaved A/B/C/C/B/A order, three warmups then thirty samples per variant per metric. Metrics: buffer (A adds toBitmap), image (nativeImage.createFromBitmap for B/C), thumbnail (capture + resize to 640 wide + toBitmap, i.e. the open() path without PNG or renderer wait), scroll (capture + ScrollCapture.add + preview, so scroll matching time is included but unchanged between variants). Excluded: PNG encoding, renderer/desktopCapturer round trips, UI composition waits, multi-display stitching, 4K real capture (no 4K display here), mixed DPI, UAC/RDP/locked-session behaviour, first DLL load (measured outside the samples), and Windows 11 corner rounding is disabled with DwmSetWindowAttribute so the whole client area is captured. Thirty samples per variant; p95 is nearest-rank. CPU cost is a separate 100-call batch per variant because process.cpuUsage() has 15.6 ms granularity. After the samples, the shipping module src/main/capture-screen.ts is loaded from the working tree and its captureScreenPixels/captureScreen output is compared byte-for-byte with the measured implementations.',
  scenarios: results,
  verification,
  comparisons,
  adoption: {
    decision,
    criteria: {
      pixelsMatch: pixelsOk,
      noGdiOrUserHandleGrowth: leaksOk,
      p50ImprovementAtLeast10PctVsCachedBindings: adoptP50,
      p95NotWorseThanCachedBindingsBy5Pct: adoptP95,
    },
  },
  excluded: ['4K real capture', 'multi-display canvas', 'mixed DPI', 'UAC/RDP/locked session', 'PNG encoding', 'renderer round trip'],
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')

const rows = comparisons.flatMap((entry) =>
  Object.entries(entry.scenarios).map(([metric, value]) => ({
    scenario: entry.scenario,
    metric,
    'A p50/p95': `${value.A.p50}/${value.A.p95}`,
    'B p50/p95': `${value.B.p50}/${value.B.p95}`,
    'C p50/p95': `${value.C.p50}/${value.C.p95}`,
    'C vs B p50 %': value.rustVsCachedP50Pct,
    'C vs B p95 %': value.rustVsCachedP95Pct,
    'cpu A/B/C': `${value.A.cpuPerCall}/${value.B.cpuPerCall}/${value.C.cpuPerCall}`,
  })),
)
console.log(`capture benchmark -> ${output}`)
console.table(rows)
console.log(
  JSON.stringify({
    decision,
    verification: verification.map(({ scenario, ok, failures, production }) => ({ scenario, ok, failures, production })),
    dll: report.dll,
  }),
)
