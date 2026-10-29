const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../release/verification-entities')
const model = path.resolve(process.argv[2] || path.join(root, 'memory-model'))
fs.mkdirSync(path.join(root, 'memory-proof'), { recursive: true })
process.env.MEM0_TELEMETRY = 'false'
process.env.MEM0_DIR = path.join(root, 'memory-proof')
async function run() {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = false
  const loadedAt = performance.now()
  const extractor = await pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
  async function embed(text) { return Array.from((await extractor(text, { pooling: 'cls', normalize: true })).data) }
  const embedding = await embed('用户喜欢简短直接的中文回答')
  console.log('model ready', embedding.length)
  const { Memory, MemoryVectorStore } = require('mem0ai/oss')
  const config = {
    disableHistory: true,
    embedder: { provider: 'langchain', config: { model: { embedQuery: embed, embedDocuments: xs => Promise.all(xs.map(embed)) } } },
    vectorStore: { provider: 'memory', config: { dbPath: path.join(root, 'memory-proof', 'assistant.db'), dimension: 512 } },
    llm: { provider: 'langchain', config: { model: { invoke() { throw Error('No LLM is used in this persistence proof') } } } }
  }
  const memory = new Memory(config)
  await memory.deleteAll({ userId: 'qa-user' })
  await memory.add('用户喜欢简短直接的中文回答', { userId: 'qa-user', infer: false })
  const at = performance.now()
  const result = await memory.search('我的回答风格是什么', { userId: 'qa-user', limit: 5 })
  const second = new Memory(config)
  const persisted = await second.getAll({ userId: 'qa-user' })
  const report = { electron: process.versions.electron, embeddingDimension: embedding.length, modelAndFirstEmbeddingMs: at - loadedAt,
    sdkSearchMs: performance.now() - at, matches: result.results.map(x => x.memory), persisted: persisted.results.length }
  const vectors = new MemoryVectorStore({ dbPath: path.join(root, 'memory-proof', 'benchmark.db'), dimension: 512 })
  const benchmarkConfig = { ...config, vectorStore: { provider: 'memory', config: { dbPath: path.join(root, 'memory-proof', 'benchmark.db'), dimension: 512 } } }
  const count = 10000
  await vectors.insert(Array.from({length:count}, () => embedding), Array.from({length:count}, (_, i) => 'qa-'+i), Array.from({length:count}, (_, i) => ({data:'测试项目'+i+'的用户希望回答简短直接，优先给出中文结论。', userId:'qa-bench'})))
  const benchmark = new Memory(benchmarkConfig)
  const samples = []
  for(let i=0;i<21;i++){const started=performance.now();await benchmark.search('我希望怎样的回答风格', {userId:'qa-bench',limit:5});if(i)samples.push(performance.now()-started)}
  samples.sort((a,b)=>a-b)
  report.fullSdkBenchmark={count,queries:20,p95Ms:samples[18],averageMs:samples.reduce((a,b)=>a+b,0)/samples.length,rssBytes:process.memoryUsage().rss,note:'Synthetic volume test with real Chinese embedding; not a semantic accuracy benchmark'}
  fs.writeFileSync(path.join(root, 'memory-compat.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  await extractor.dispose()
}
run().catch(error => { console.error(error); process.exitCode = 1 })
