const { app, utilityProcess } = require('electron')
const path = require('node:path'), fs = require('node:fs')
const verification = path.resolve(__dirname, '../release/verification-entities')
fs.mkdirSync(verification, { recursive: true })
const home = path.join(verification, 'memory-utility-proof')
const worker = path.resolve(process.argv[2] || 'out/main/memory.js')
const model = path.resolve(process.argv[3] || path.join(verification, 'memory-model'))
const packageEnd = worker.toLowerCase().indexOf('app.asar')
const isolate = path.join(verification, 'memory-isolate.cjs')
if (packageEnd >= 0) {
  process.env.YU_MEMORY_QA_PACKAGE_ROOT = worker.slice(0, packageEnd + 'app.asar'.length)
  fs.writeFileSync(isolate, `const { registerHooks } = require('node:module')
const root = require('node:url').pathToFileURL(process.env.YU_MEMORY_QA_PACKAGE_ROOT).href.toLowerCase()
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context)
  if (result.url.includes('/node_modules/') && !result.url.toLowerCase().startsWith(root)) throw Error('QA rejected external package: ' + result.url)
  return result
} })`)
}
app.setPath('userData', home)
let child, nextId = 0, mockLearning = false, llmCalls = 0
const pending = new Map()
async function start() {
  child = utilityProcess.fork(worker, [], { serviceName: 'YU memory QA', stdio: 'pipe', execArgv: packageEnd >= 0 ? ['--require', isolate] : [] })
  child.stderr.on('data', data => fs.appendFileSync(path.join(verification, 'memory-worker-debug.log'), data))
  child.stdout.on('data', data => fs.appendFileSync(path.join(verification, 'memory-worker-debug.log'), data))
  child.on('message', message => {
    if (message.type === 'llm') {
      if (!mockLearning) throw Error('Unexpected LLM request')
      llmCalls++
      const oldFact = '用户要求写作使用简短句子', newFact = '用户现在明确要求写作详细展开，替代之前的简短偏好'
      const responses = [
        { facts: [oldFact] }, { memory: [{ id: '0', text: oldFact, event: 'ADD' }] },
        { facts: [newFact] }, { memory: [{ id: '0', text: newFact, event: 'UPDATE', old_memory: oldFact }] },
        { facts: ['用户不再有写作长度偏好'] }, { memory: [{ id: '0', text: newFact, event: 'DELETE' }] }
      ]
      const text = JSON.stringify(responses[llmCalls - 1])
      child.postMessage({ type: 'llm-result', id: message.id, text }); return
    }
    const request = pending.get(message.id); pending.delete(message.id)
    if (message.error) request?.reject(Error(message.error)); else request?.resolve(message.value)
  })
  await send('init', { home, modelDir: model })
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(Error('Worker timeout: ' + method)), 10000)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.postMessage({ id, method, ...params })
  })
}
async function stop() {
  if (!child) return
  const old = child; child = null
  await new Promise(resolve => { old.once('exit', resolve); old.kill() })
}
app.whenReady().then(async () => {
  const report = {}
  try {
    await start(); await send('clear')
    await send('add', { kind: 'assistant', text: '用户的测试项目叫星河', sourceId: 'qa-assistant' })
    await send('add', { kind: 'style', text: '用户明确要求写作使用简短句子', sourceId: 'qa-style' })
    let facts = await send('list', { kind: 'assistant' }), styles = await send('list', { kind: 'style' })
    if (facts.length !== 1 || styles.length !== 1) throw Error('Category isolation failed')
    report.categoryIsolation = true
    await stop(); await start()
    facts = await send('list', { kind: 'assistant' })
    if (facts[0]?.text !== '用户的测试项目叫星河') throw Error('Restart persistence failed')
    report.restartPersistence = true
    await send('update', { kind: 'assistant', memoryId: facts[0].id, text: '用户的测试项目已更名为青禾' })
    const recalled = await send('recall', { kind: 'assistant', text: '我的测试项目叫什么' })
    if (!recalled.some(row => row.text.includes('青禾'))) throw Error('Update retrieval failed')
    report.updatedFactRetrieved = true
    report.warmedWorker = app.getAppMetrics().find(row => row.pid === child.pid)
    await send('delete', { kind: 'assistant', memoryId: facts[0].id })
    if ((await send('list', { kind: 'assistant' })).length) throw Error('Delete failed')
    report.deleted = true
    await send('clear'); await stop(); await start()
    if ((await send('list', { kind: 'assistant' })).length || (await send('list', { kind: 'style' })).length) throw Error('Clear after restart failed')
    report.clearBothCategoriesAfterRestart = true
    mockLearning = true
    await send('learn', { kind: 'style', text: '以后写作请使用简短句子', sourceId: 'qa-llm-fixture' })
    const learned = await send('list', { kind: 'style' })
    if (!learned.some(row => row.text === '用户要求写作使用简短句子')) throw Error('SDK inference bridge failed: calls=' + llmCalls + ' learned=' + JSON.stringify(learned))
    report.sdkInferenceBridge = { mockLlmCalls: llmCalls, saved: true, limitation: 'Protocol fixture, not real LLM extraction accuracy' }
    await send('learn', { kind: 'style', text: '我改主意了，以后写作请详细展开，不要再用之前简短的风格', sourceId: 'qa-conflict-fixture' })
    const conflicted = await send('list', { kind: 'style' })
    report.automaticConflictResolution = { oldFactStillPresent: conflicted.some(row => row.text === '用户要求写作使用简短句子'), currentRows: conflicted, supported: conflicted.length === 1 }
    if (report.automaticConflictResolution.oldFactStillPresent || !report.automaticConflictResolution.supported) throw Error('Automatic update did not replace the old memory')
    await send('learn', { kind: 'style', text: '请忘记前面提到的写作长度偏好，我不再有这项要求', sourceId: 'qa-delete-fixture' })
    if ((await send('list', { kind: 'style' })).length) throw Error('Automatic delete failed')
    report.sdkAutomaticDelete = true
    mockLearning = false
    await send('clear')
    await stop(); report.utilityProcessExited = true
    fs.writeFileSync(path.join(verification, 'memory-utility-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } catch (error) { console.error(error); process.exitCode = 1 }
  finally { await stop(); if (packageEnd >= 0) fs.unlinkSync(isolate); app.exit(process.exitCode || 0) }
})
