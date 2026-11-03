'use strict'

// Electron main-process fixture for scripts/benchmark-memory-graph.mjs.
// One process per scenario: it builds an isolated synthetic Mem0-format catalog
// with a fixed seed, then measures the graph pipeline in layers — catalog read,
// link computation, full readGraph — plus one host→worker→host round trip
// through a real memory utility process. Prints one __RESULT__ JSON line.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const v8 = require('node:v8')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')
const koffi = require('koffi')
const { app, utilityProcess } = require('electron')

const ROOT = path.resolve(__dirname, '../../..')
const rootRequire = createRequire(path.join(ROOT, 'package.json'))
const BASELINE = process.env.MEMORY_GRAPH_BASELINE ?? '00d652c'
const HOME = process.env.MEMORY_GRAPH_HOME
const WORKER = path.join(ROOT, 'out/main/memory.js')
const scenario = JSON.parse(process.env.MEMORY_GRAPH_SCENARIO ?? '{"name":"200","nodes":200}')
const NODES = scenario.nodes

const WARMUP = 3
const SAMPLES = 15
const DIMENSION = 512

app.disableHardwareAcceleration()
v8.setFlagsFromString('--expose-gc')
const collectGarbage = runInNewContext('gc')
function reclaim() { collectGarbage() }

// --- TypeScript loading ---------------------------------------------------

function compileSource(source, filename) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText
  const module = { exports: {} }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', js)
  factory(module.exports, (name) => rootRequire(name), module, filename, path.dirname(filename))
  return module.exports
}

function loadSource(text, filename) { return compileSource(text, filename) }

const baselineModule = loadSource(
  execFileSync('git', ['show', `${BASELINE}:src/main/memory/catalog.ts`], { cwd: ROOT, encoding: 'utf8' }),
  path.join(ROOT, 'src/main/memory/catalog.ts'),
)
const productionModule = loadSource(
  fs.readFileSync(path.join(ROOT, 'src/main/memory/catalog.ts'), 'utf8'),
  path.join(ROOT, 'src/main/memory/catalog.ts'),
)

// --- C: Rust batch cosine + the same JavaScript selection ------------------

const dllPath = process.env.MEMORY_GRAPH_DLL ?? ''
const rustScores = (() => {
  if (!dllPath || !fs.existsSync(dllPath)) return null
  return koffi.load(dllPath).func('int32_t yu_graph_scores(const float *vectors, size_t count, size_t dimension, _Out_ double *scores)')
})()

function createRustGraph(module) {
  return function graphLinks(rows) {
    const size = rows.length
    const dimension = rows[0]?.vector?.length ?? 0
    if (!size || !dimension || !rows.every((row) => row.vector?.length === dimension)) return module.graphLinks(rows)
    const flat = new Float32Array(size * dimension)
    for (let index = 0; index < size; index++) flat.set(rows[index].vector, index * dimension)
    const scores = new Float64Array(size * size)
    if (rustScores(flat, size, dimension, scores) !== 0) throw new Error('yu_graph_scores rejected the batch')
    const links = [], pairs = new Set()
    const sources = rows.map((row) => new Set(row.sourceId.split(',').filter((id) => id && id !== 'manual')))
    const kinds = new Uint8Array(size * size)
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        let common = false
        for (const id of sources[i]) if (sources[j].has(id)) { common = true; break }
        if (!common && scores[i * size + j] < 0.78) continue
        kinds[i * size + j] = kinds[j * size + i] = common ? 2 : 1
      }
    }
    for (let i = 0; i < size; i++) {
      const candidates = []
      for (let j = 0; j < size; j++) {
        const kind = kinds[i * size + j]
        if (!kind) continue
        candidates.push({ j, type: kind === 2 ? 'source' : 'similar', score: scores[i * size + j] })
      }
      candidates.sort((a, b) => Number(b.type === 'source') - Number(a.type === 'source') || b.score - a.score)
      for (const edge of candidates.slice(0, 3)) {
        const key = [i, edge.j].sort((a, b) => a - b).join(':')
        if (!pairs.has(key)) { pairs.add(key); links.push({ source: rows[i].id, target: rows[edge.j].id, type: edge.type, score: edge.score }) }
      }
    }
    return links
  }
}

// --- Synthetic catalog ----------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function unitVector(random) {
  const values = new Float64Array(DIMENSION)
  let norm = 0
  for (let i = 0; i < DIMENSION; i++) { const value = random() * 2 - 1; values[i] = value; norm += value * value }
  const scale = 1 / Math.sqrt(norm)
  for (let i = 0; i < DIMENSION; i++) values[i] *= scale
  return values
}

// Three concept directions keep cosine similarity inside a cluster high
// (above the 0.78 graph threshold) and across clusters low. Exact duplicates
// and equidistant pairs give the scoring order real ties to preserve.
function buildRow(index, random, bases) {
  const cluster = index % bases.length
  const duplicate = index >= NODES - 4
  const base = bases[duplicate ? 0 : cluster]
  const vector = new Float32Array(DIMENSION)
  for (let i = 0; i < DIMENSION; i++) vector[i] = duplicate ? base[i] : base[i] + (random() * 2 - 1) * 0.22
  const sources = ['', 'manual', 'turn-1', 'turn-1,turn-2', `turn-${(index % 7) + 2}`]
  const sourceId = duplicate ? 'turn-1,turn-2' : sources[index % sources.length]
  const updatedAt = `2026-10-${String(28 - Math.floor(index / 20)).padStart(2, '0')}T${String(23 - (index % 20)).padStart(2, '0')}:00:00Z`
  return { id: `mem-${String(index).padStart(3, '0')}`, vector, sourceId, text: `合成记忆 ${index}`, updatedAt }
}

function writeDatabase(file, entries) {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)')
  const insert = db.prepare('INSERT INTO vectors VALUES (?, ?, ?)')
  for (const entry of entries) {
    insert.run(entry.id, Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength), JSON.stringify({
      userId: entry.userId ?? 'local-user',
      data: entry.text,
      sourceId: entry.sourceId,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: entry.updatedAt,
    }))
  }
  db.close()
}

function buildCatalog(home) {
  fs.mkdirSync(home, { recursive: true })
  const random = mulberry32(20261103)
  const bases = [unitVector(random), unitVector(random), unitVector(random)]
  const rows = Array.from({ length: NODES + 6 }, (_, index) => buildRow(index, random, bases))
  const assistant = rows.filter((_, index) => index % 5 !== 4)
  const style = rows.filter((_, index) => index % 5 === 4)
  // Rows for another user must stay invisible: they prove the user filter runs
  // before the 200-node limit.
  for (const row of rows.slice(0, 5)) row.userId = 'other-user'
  writeDatabase(path.join(home, 'assistant.db'), assistant)
  writeDatabase(path.join(home, 'style.db'), style)
  const hash = crypto.createHash('sha256')
  for (const file of ['assistant.db', 'style.db']) hash.update(fs.readFileSync(path.join(home, file)))
  return hash.digest('hex')
}

// --- Timing helpers -------------------------------------------------------

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return { p50: quantile(0.5), p95: quantile(0.95), min: sorted[0], max: sorted[sorted.length - 1], mean }
}

// Interleaved rounds: every variant sees the same GC and JIT state as its
// neighbours, and each round contributes two samples per variant.
async function measureVariants(implementations) {
  const names = Object.keys(implementations)
  const order = [...names, ...[...names].reverse()]
  const raw = Object.fromEntries(names.map((name) => [name, []]))
  for (let round = 0; round < WARMUP; round++) for (const name of order) implementations[name]()
  for (let round = 0; round < SAMPLES; round++) {
    for (const name of order) {
      const started = performance.now()
      implementations[name]()
      raw[name].push(performance.now() - started)
    }
  }
  const measured = {}
  for (const name of names) {
    const cpuBefore = process.cpuUsage()
    for (let index = 0; index < 30; index++) implementations[name]()
    const cpu = process.cpuUsage(cpuBefore)
    measured[name] = { wall: stats(raw[name]), cpuMsPerCall: (cpu.user + cpu.system) / 1000 / 30, raw: raw[name] }
  }
  return measured
}

function memory() {
  const usage = process.memoryUsage()
  const info = app.getAppMetrics?.().find((metric) => metric.pid === process.pid)
  return {
    heapUsedKb: Math.round(usage.heapUsed / 1024),
    externalKb: Math.round(usage.external / 1024),
    arrayBuffersKb: Math.round(usage.arrayBuffers / 1024),
    rssKb: Math.round(usage.rss / 1024),
    privateKb: Math.round((info?.memory?.privateBytes ?? 0)),
  }
}

// --- Layer attribution (measurement replica, not production code) ---------

function attribute(rows) {
  const size = rows.length
  let started = performance.now()
  const sourceSets = rows.map((row) => new Set(row.sourceId.split(',').filter((id) => id && id !== 'manual')))
  const vectors = rows.map((row) => row.vector && Float64Array.from(row.vector))
  const norms = vectors.map((vector) => Math.sqrt(vector ? vector.reduce((sum, value) => sum + value * value, 0) : 0))
  const setupMs = performance.now() - started
  const kinds = new Uint8Array(size * size)
  const scores = new Float64Array(size * size)
  started = performance.now()
  let pairs = 0
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      let common = false
      for (const id of sourceSets[i]) { if (sourceSets[j].has(id)) { common = true; break } }
      const a = vectors[i], b = vectors[j]
      let score = 0
      if (a && b && a.length === b.length && norms[i] && norms[j]) {
        for (let n = 0; n < a.length; n++) score += a[n] * b[n]
        score /= norms[i] * norms[j]
      }
      if (!common && score < 0.78) continue
      pairs++
      kinds[i * size + j] = kinds[j * size + i] = common ? 2 : 1
      scores[i * size + j] = scores[j * size + i] = score
    }
  }
  const pairsMs = performance.now() - started
  started = performance.now()
  const seen = new Set()
  let edges = 0
  for (let i = 0; i < size; i++) {
    const candidates = []
    for (let j = 0; j < size; j++) {
      const kind = kinds[i * size + j]
      if (!kind) continue
      candidates.push({ j, type: kind === 2 ? 'source' : 'similar', score: scores[i * size + j] })
    }
    candidates.sort((a, b) => Number(b.type === 'source') - Number(a.type === 'source') || b.score - a.score)
    for (const edge of candidates.slice(0, 3)) {
      const key = [i, edge.j].sort((a, b) => a - b).join(':')
      if (!seen.has(key)) { seen.add(key); edges++ }
    }
  }
  const selectMs = performance.now() - started
  return { spentMs: { setup: Number(setupMs.toFixed(3)), pairs: Number(pairsMs.toFixed(3)), select: Number(selectMs.toFixed(3)) }, pairs, edges }
}

// --- Host→worker→host round trip -----------------------------------------

function forkWorker() {
  const child = utilityProcess.fork(WORKER, [], { serviceName: 'YU memory benchmark', stdio: 'pipe' })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  const pending = new Map()
  let sequence = 0
  child.on('message', (message) => {
    if (message?.type === 'result') { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(Error(message.error)) : entry?.resolve(message.value) }
  })
  const send = (method, payload = {}) => {
    const id = ++sequence
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.postMessage({ id, method, ...payload }) })
  }
  return { child, send, ready: new Promise((resolve) => child.once('spawn', resolve)) }
}

async function measureWorker() {
  if (!fs.existsSync(WORKER)) throw new Error(`missing ${WORKER}; run pnpm build first`)
  const worker = forkWorker()
  await worker.ready
  const started = performance.now()
  await worker.send('init', { home: HOME, modelDir: path.join(HOME, 'model') })
  const initMs = performance.now() - started
  const first = performance.now()
  const initial = await worker.send('graph', {})
  const coldMs = performance.now() - first
  const raw = []
  let bytes = 0
  for (let index = 0; index < WARMUP; index++) await worker.send('graph', {})
  const cpuBefore = process.cpuUsage()
  for (let index = 0; index < SAMPLES; index++) {
    const at = performance.now()
    const value = await worker.send('graph', {})
    raw.push(performance.now() - at)
    bytes = JSON.stringify(value).length
  }
  const cpu = process.cpuUsage(cpuBefore)
  worker.child.kill()
  return {
    initMs,
    coldMs,
    wall: stats(raw),
    cpuMsPerCall: (cpu.user + cpu.system) / 1000 / SAMPLES,
    payloadBytes: bytes,
    nodes: initial.nodes.length,
    links: initial.links.length,
    digest: crypto.createHash('sha256').update(JSON.stringify(initial)).digest('hex'),
    raw,
  }
}

// --- Main -----------------------------------------------------------------

async function main() {
  const catalogHashBefore = buildCatalog(HOME)
  const variants = { A: baselineModule, B: productionModule }
  variants.A.readGraph(HOME); variants.B.readGraph(HOME)

  const rowsForLinks = (() => {
    const groups = ['assistant', 'style'].map((kind) => variants.A.readCatalog(HOME, kind, 200, '', true))
    const rows = groups.flatMap((group) => group.rows).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')).slice(0, 200)
    return rows
  })()

  const metrics = { catalog: {}, links: {}, graph: {} }
  const rustGraphLinks = rustScores ? createRustGraph(productionModule) : null
  const graphWith = (links) => () => {
    const groups = ['assistant', 'style'].map((kind) => productionModule.readCatalog(HOME, kind, 200, '', true))
    const rows = groups.flatMap((group) => group.rows).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')).slice(0, 200)
    return { nodes: rows.map(({ vector: _vector, ...row }) => row), links: links(rows), total: groups.reduce((sum, group) => sum + group.total, 0), limit: 200 }
  }
  const workloads = {
    catalog: { A: () => variants.A.readCatalog(HOME, 'assistant', 200, '', true), B: () => variants.B.readCatalog(HOME, 'assistant', 200, '', true) },
    links: { A: () => variants.A.graphLinks(rowsForLinks), B: () => variants.B.graphLinks(rowsForLinks) },
    graph: { A: () => variants.A.readGraph(HOME), B: () => variants.B.readGraph(HOME) },
  }
  if (rustGraphLinks) {
    workloads.links.C = () => rustGraphLinks(rowsForLinks)
    workloads.graph.C = graphWith(rustGraphLinks)
  }
  for (const [metric, implementations] of Object.entries(workloads)) {
    metrics[metric] = await measureVariants(implementations)
  }

  const memoryBefore = memory()
  const worker = await measureWorker()
  const memoryAfter = memory()

  const linksA = JSON.stringify(variants.A.readGraph(HOME).links)
  const linksB = JSON.stringify(variants.B.readGraph(HOME).links)
  const linksC = rustGraphLinks ? JSON.stringify(graphWith(rustGraphLinks)().links) : null
  const nodesA = JSON.stringify(variants.A.readGraph(HOME).nodes.map((node) => node.id))
  const nodesB = JSON.stringify(variants.B.readGraph(HOME).nodes.map((node) => node.id))
  const catalogHashAfter = (() => {
    const hash = crypto.createHash('sha256')
    for (const file of ['assistant.db', 'style.db']) hash.update(fs.readFileSync(path.join(HOME, file)))
    return hash.digest('hex')
  })()

  const payload = {
    kind: 'memory-graph',
    baseline: BASELINE,
    scenario,
    measuredAt: new Date().toISOString(),
    seed: 20261103,
    dimension: DIMENSION,
    rows: rowsForLinks.length,
    attribution: attribute(rowsForLinks),
    metrics,
    worker,
    verification: {
      linksMatch: linksA === linksB,
      linksMatchRust: linksC === null ? null : linksC === linksA,
      nodesMatch: nodesA === nodesB,
      edges: JSON.parse(linksA).length,
      catalogReadOnly: catalogHashBefore === catalogHashAfter,
      catalogHash: catalogHashBefore,
    },
    rust: rustGraphLinks ? { dll: dllPath, bytes: fs.statSync(dllPath).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex') } : null,
    memory: { before: memoryBefore, after: memoryAfter },
    runtime: { electron: process.versions.electron, node: process.versions.node, v8: process.versions.v8 },
  }
  process.stdout.write(`__RESULT__${JSON.stringify(payload)}\n`)
  setTimeout(() => app.exit(0), 50)
}

app.whenReady().then(main).catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  app.exit(1)
})
