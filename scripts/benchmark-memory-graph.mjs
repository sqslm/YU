#!/usr/bin/env node

// Compares the memory graph pipeline across implementations inside a real
// Electron memory worker: A = catalog.ts at the baseline commit, B = the working
// tree. Each scenario builds its own synthetic catalog, so no user data is read.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const fixture = resolve(root, 'tests/yu-v2/fixtures/memory-graph-electron.cjs')
const crate = resolve(root, 'native/memory-graph')
const dll = resolve(root, 'native/bin/yu-graph-scores.dll')

// The crate is a measured candidate, so the benchmark builds it itself.
const build = spawnSync('cargo', ['build', '--release', '--locked', '--offline'], { cwd: crate, stdio: 'inherit', windowsHide: true })
if (build.error) throw new Error(`Rust MSVC toolchain is required: ${build.error.message}`)
if (build.status !== 0) process.exit(build.status ?? 1)
mkdirSync(dirname(dll), { recursive: true })
copyFileSync(resolve(crate, 'target/release/yu_graph_scores.dll'), dll)

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const baseline = argument('baseline', '00d652c')
const output = resolve(root, argument('output', 'tests/yu-v2/evidence/rust-memory-graph-20261103.json'))
const scenarios = [
  { name: '20', nodes: 20 },
  { name: '80', nodes: 80 },
  { name: '200', nodes: 200 },
]

function runScenario(scenario) {
  const home = realpathSync(mkdtempSync(resolve(tmpdir(), 'yu-memory-graph-')))
  try {
    const env = { ...process.env, MEMORY_GRAPH_SCENARIO: JSON.stringify(scenario), MEMORY_GRAPH_BASELINE: baseline, MEMORY_GRAPH_HOME: home, MEMORY_GRAPH_DLL: dll }
    delete env.ELECTRON_RUN_AS_NODE
    env.TEMP = home
    env.TMP = home
    const result = spawnSync(require('electron'), [fixture], { cwd: root, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
    if (result.error) throw result.error
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('__RESULT__'))
    if (!line) throw new Error(`${scenario.name}: no result line: ${result.stdout.slice(-800)}${result.stderr.slice(-2000)}`)
    return JSON.parse(line.slice('__RESULT__'.length))
  } finally {
    const resolved = realpathSync(home)
    if (!resolved.startsWith(realpathSync(tmpdir()))) throw new Error(`refusing to delete ${resolved}`)
    rmSync(resolved, { recursive: true, force: true })
  }
}

const percent = (from, to) => (from ? ((to - from) / from) * 100 : 0)
const round = (value) => Math.round(value * 1000) / 1000
const delta = (value) => Math.round(value * 10) / 10

const report = {
  kind: 'rust-memory-graph',
  date: new Date().toISOString(),
  baseline,
  scope: [
    'catalog/links/graph are measured on a synthetic catalog inside a real Electron main process, with the versions loaded straight from git and the working tree.',
    'A = graphLinks at the baseline commit, B = current TypeScript, C = current TypeScript with the Rust cosine helper (built by this script, never shipped).',
    'Rounds interleave A/B/C/C/B/A with three warmup rounds and fifteen measured rounds, so every variant sees thirty samples of the same JIT and GC state.',
    'worker timings fork the real out/main/memory.js utility process; coldMs includes process start plus init.',
    'memory figures come from app.getAppMetrics() private bytes and process.memoryUsage(); production and benchmark-process numbers are reported separately.',
    'not measured: renderer layout, force simulation, the 250ms filter debounce, PNG export and any ask/model latency.',
  ],
  scenarios: [],
}
for (const scenario of scenarios) {
  const measured = runScenario(scenario)
  const table = []
  for (const [metric, implementations] of Object.entries(measured.metrics)) {
    const a = implementations.A.wall
    const b = implementations.B.wall
    const c = implementations.C?.wall
    table.push({
      scenario: scenario.name,
      metric,
      'A p50': round(a.p50),
      'A p95': round(a.p95),
      'B p50': round(b.p50),
      'B p95': round(b.p95),
      'B vs A p50%': delta(percent(a.p50, b.p50)),
      'C p50': c ? round(c.p50) : '-',
      'C p95': c ? round(c.p95) : '-',
      'C vs B p50%': c ? delta(percent(b.p50, c.p50)) : '-',
      'C vs B p95%': c ? delta(percent(b.p95, c.p95)) : '-',
      'A cpu': round(implementations.A.cpuMsPerCall),
      'B cpu': round(implementations.B.cpuMsPerCall),
      'C cpu': c ? round(implementations.C.cpuMsPerCall) : '-',
    })
  }
  report.scenarios.push({ scenario, measured, table })
  console.log(`\n[${scenario.name} nodes] rows ${measured.rows} edges ${measured.verification.edges} linksMatch ${measured.verification.linksMatch} linksMatchRust ${measured.verification.linksMatchRust} readOnly ${measured.verification.catalogReadOnly}`)
  console.table(table)
  const { spentMs, pairs, edges } = measured.attribution
  console.log(`layers(ms) setup ${spentMs.setup} pairs ${spentMs.pairs} select ${spentMs.select} pairs ${pairs} edges ${edges}`)
  console.log(`worker first ${round(measured.worker.coldMs)}ms init ${round(measured.worker.initMs)}ms hot p50 ${round(measured.worker.wall.p50)}ms p95 ${round(measured.worker.wall.p95)}ms payload ${measured.worker.payloadBytes}B nodes ${measured.worker.nodes}`)
  console.log(`memory before ${JSON.stringify(measured.memory.before)} after ${JSON.stringify(measured.memory.after)}`)
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nwrote ${output}`)
if (report.scenarios.some((entry) => !entry.measured.verification.linksMatch || !entry.measured.verification.catalogReadOnly)) {
  console.error('verification failed')
  process.exitCode = 1
}
