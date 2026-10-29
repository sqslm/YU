// Run with Electron's ELECTRON_RUN_AS_NODE=1; no credentials or real user data.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const model = path.resolve(process.argv[2])
const output = path.resolve(process.argv[3])
const home = path.join(path.dirname(output), 'memory-evaluation')
process.env.MEM0_TELEMETRY = 'false'
process.env.MEM0_DIR = path.join(home, 'sdk')

async function run() {
  fs.mkdirSync(home, { recursive: true })
  const modelBytes = fs.readFileSync(path.join(model, 'onnx/model_quantized.onnx'))
  if (crypto.createHash('sha256').update(modelBytes).digest('hex') !== '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc') throw Error('Model checksum mismatch')
  const requests = []
  globalThis.fetch = async url => { requests.push(String(url)); throw Error('Network is disabled for this evaluation') }
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  const at = performance.now(), extractor = await pipeline('feature-extraction', model, { device: 'cpu', dtype: 'q8', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
  const embed = async text => Array.from((await extractor(text, { pooling: 'cls', normalize: true, truncation: true, max_length: 512 })).data)
  const { Memory } = require('mem0ai/oss')
  const config = {
    disableHistory: true,
    embedder: { provider: 'langchain', config: { model: { embedQuery: embed, embedDocuments: texts => Promise.all(texts.map(embed)) } } },
    vectorStore: { provider: 'memory', config: { dbPath: path.join(home, 'assistant.db'), dimension: 512 } },
    llm: { provider: 'langchain', config: { model: { invoke() { throw Error('This test does not substitute an LLM for extraction accuracy') } } } }
  }
  const memory = new Memory(config), userId = 'synthetic-zh-evaluation'
  await memory.deleteAll({ userId })
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/main/memory/fixtures/zh-evaluation.json'), 'utf8'))
  for (const fact of fixtures.facts) await memory.add(fact.text, { userId, infer: false, metadata: { sourceId: 'fixture-' + fact.id } })
  const policyText = fs.readFileSync(path.join(__dirname, '../src/shared/memory-policy.ts'), 'utf8')
  const policyBody = policyText.match(/return (.+)\n/)[1]
  const personalQuery = new Function('text', 'return ' + policyBody)
  const rows = []
  for (const fact of fixtures.facts) for (const query of fact.queries) {
    const start = performance.now(), result = await memory.search(query, { userId, limit: 5 })
    rows.push({ kind: 'positive', query, expected: fact.text, matched: result.results.some(row => row.memory === fact.text), ms: performance.now() - start, results: result.results })
  }
  for (const query of fixtures.negativeQueries) {
    const result = personalQuery(query) ? await memory.search(query, { userId, limit: 5 }) : { results: [] }
    rows.push({ kind: 'negative', query, matched: result.results.length === 0, results: result.results })
  }
  const stored = await memory.getAll({ userId, limit: 10000 })
  const project = stored.results.find(row => row.memory === fixtures.facts[3].text)
  if (!project) throw Error('Missing seeded project memory')
  for (let i = 0; i < 10; i++) {
    const text = `用户正在开发的桌面应用名称已经改为青禾第${i}版`
    await memory.update(project.id, text)
    const after = await new Memory(config).getAll({ userId, limit: 10000 })
    rows.push({ kind: 'update', expected: text, matched: after.results.some(row => row.id === project.id && row.memory === text) && !after.results.some(row => row.id === project.id && row.memory === fixtures.facts[3].text) })
  }
  await memory.delete(project.id)
  const afterDelete = await new Memory(config).getAll({ userId, limit: 10000 })
  if (afterDelete.results.some(row => row.id === project.id)) throw Error('Deleted memory survived reopening')
  await memory.deleteAll({ userId })
  if ((await new Memory(config).getAll({ userId })).results.length) throw Error('Clear failed')
  const report = { sdk: 'mem0ai@2.4.6', electron: process.versions.electron, cases: rows.length,
    summary: ['positive', 'negative', 'update'].map(kind => ({ kind, total: rows.filter(row => row.kind === kind).length, matched: rows.filter(row => row.kind === kind && row.matched).length })),
    deletedAndClearedAfterReopen: true, forbiddenNetworkRequests: requests, totalMs: performance.now() - at,
    limitation: 'Real local ONNX retrieval and SDK persistence/update evaluation on independent synthetic Chinese facts. infer:false seeds fixtures; negative queries use the same host privacy intent gate; automatic LLM fact extraction accuracy is not measured.', rows }
  fs.writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, rows: undefined }))
  await extractor.dispose()
  if (requests.length) throw Error('Unexpected network request')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
