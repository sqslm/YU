// Component profiling only. No user memories, microphones, network or LLM calls.
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')
const port = process.parentPort
let sdk, extractor, embedding, memory, vectorStore, before, after
const text = '用户喜欢简短直接的中文回答'
async function embed(query) {
  return Array.from((await extractor(query, { pooling: 'cls', normalize: true, truncation: true, max_length: 512 })).data)
}
async function command(data) {
  switch (data.action) {
    case 'snapshot': return true
    case 'asr-runtime': {
      const runtime = require('sherpa-onnx-node')
      return { imported: typeof runtime.OfflineRecognizer === 'function' }
    }
    case 'pcm': {
      before ??= require(process.env.YU_BENCH_BEFORE_ASR)
      after ??= require(process.env.YU_BENCH_AFTER_ASR)
      const began = performance.now()
      const samples = (data.variant === 'before' ? before : after).wavToSamples(data.wav)
      const conversionMs = performance.now() - began
      return { count: samples.length, conversionMs, hash: createHash('sha256').update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex') }
    }
    case 'sdk': sdk = require('mem0ai/oss'); return true
    case 'transformers': {
      const transformers = await import('@huggingface/transformers')
      transformers.env.allowRemoteModels = false
      transformers.env.allowLocalModels = true
      return true
    }
    case 'model': {
      const { pipeline } = await import('@huggingface/transformers')
      extractor = await pipeline('feature-extraction', data.modelDir, { device: 'cpu', dtype: 'q8', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
      return true
    }
    case 'tokenize': return { length: extractor.tokenizer(text, { truncation: true, max_length: 512 }).input_ids.size }
    case 'embed': {
      embedding = await embed(text)
      return { dimension: embedding.length, norm: Math.sqrt(embedding.reduce((n, x) => n + x * x, 0)) }
    }
    case 'store': {
      const dbPath = join(data.home, 'assistant.db')
      vectorStore = new sdk.MemoryVectorStore({ dbPath, dimension: 512 })
      const vectors = Array.from({ length: 1000 }, (_, i) => Array.from({ length: 512 }, (_, j) => i === 999 ? 0 : embedding[j] + ((i * 97 + j * 37) % 101 - 50) / 500))
      await vectorStore.insert(vectors, Array.from({ length: 1000 }, (_, i) => 'synthetic-' + i),
        Array.from({ length: 1000 }, (_, i) => ({ data: text, sourceId: 'synthetic-source', userId: i % 10 ? 'local-user' : 'other-user' })))
      memory = new sdk.Memory({ disableHistory: true, enableGraph: false,
        embedder: { provider: 'langchain', config: { model: { embedQuery: embed, embedDocuments: queries => Promise.all(queries.map(embed)) } } },
        vectorStore: { provider: 'memory', config: { dbPath, dimension: 512 } },
        llm: { provider: 'langchain', config: { model: { invoke() { throw Error('Benchmark forbids LLM requests') } } } } })
      return { rows: 1000 }
    }
    case 'search': return { count: (await memory.search(text, { userId: 'local-user', limit: 5 })).results.length }
    case 'catalog-search': {
      const { searchCatalog } = require(process.env.YU_BENCH_CATALOG)
      return { count: searchCatalog(data.home, 'assistant', await embed(text)).length }
    }
    case 'oracle': {
      const { searchCatalog } = require(process.env.YU_BENCH_CATALOG)
      const queries = [embedding, embedding.map(x => -x), Array(512).fill(0), ...Array.from({ length: 13 }, (_, i) => Array.from({ length: 512 }, (_, j) => ((i * 1237 + j * 7919) % 997 - 499) / 997))]
      for (const query of queries) {
        const expected = await vectorStore.search(query, 5, { userId: 'local-user' })
        const actual = searchCatalog(data.home, 'assistant', query)
        assert.deepEqual(actual.map(row => row.id), expected.map(row => row.id))
        for (let i = 0; i < actual.length; i++) {
          assert.equal(actual[i].text, expected[i].payload.data)
          assert.equal(actual[i].sourceId, expected[i].payload.sourceId)
          assert.ok(Object.is(actual[i].score, expected[i].score) || Math.abs(actual[i].score - expected[i].score) < 1e-12)
        }
      }
      return { cases: queries.length, rows: 1000, idsMetadataAndScoresEqual: true }
    }
    case 'dispose': await extractor.dispose(); extractor = null; return true
    default: throw Error('Unknown benchmark action')
  }
}
let serial = Promise.resolve()
port.on('message', ({ data }) => {
  serial = serial.then(async () => {
    const cpu = process.cpuUsage(), start = performance.now()
    try {
      const value = await command(data), ms = performance.now() - start, used = process.cpuUsage(cpu)
      port.postMessage({ id: data.id, value, ms, cpuMs: (used.user + used.system) / 1000, memory: process.memoryUsage() })
    } catch (error) { port.postMessage({ id: data.id, error: error.message }) }
  })
})
port.postMessage({ type: 'ready' })
