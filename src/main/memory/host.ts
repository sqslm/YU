import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Settings } from '@shared/types'
import type { MemoryBackend, MemoryEntry, MemoryGraph, MemoryKind, MemoryStatus } from '@shared/memory'
import { complete } from '../providers/llm'
import { chainFor } from '../providers/chain'
import { downloadMemoryModel, memoryModelReady } from './model'
import { personalMemoryQuery } from '@shared/memory-policy'
import { memoryCompletion, MemoryReplyError } from './completion'

export class MemoryService implements MemoryBackend {
  private child: UtilityProcess | null = null
  private starting: Promise<void> | null = null
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private sequence = 0
  private llmCalls = 0
  private queue: Array<{ kind: MemoryKind; text: string; sourceId: string; at: number }> = []
  private learningBatch: typeof this.queue = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private reasons = new Set<string>()
  private get paused(): boolean { return this.reasons.size > 0 }
  private working = false
  private mutations: Promise<void> = Promise.resolve()
  private mutating = 0
  private explicitLearning = false
  private generation = 0
  private learningEpoch = 0
  private download: AbortController | null = null
  private llmAbort = new AbortController()
  private current: MemoryStatus = { state: 'off', pending: 0, modelReady: false }
  readonly modelDir: string
  constructor(private home: string, private settings: () => Settings, private busy: () => boolean, private log: (line: string) => void, private idleEnough: () => boolean = () => true) {
    this.modelDir = join(home, 'model')
  }
  learningToken(): number { return this.learningEpoch }
  status(): MemoryStatus { return { ...this.current, state: this.current.state === 'downloading' ? 'downloading' : !this.settings().memory.enabled ? 'off' : this.paused ? 'paused' : this.current.state === 'idle' && this.queue.length ? 'waiting' : this.current.state, pending: this.queue.length } }
  async configure(): Promise<void> {
    if (!this.settings().memory.enabled) { this.learningEpoch++; this.queue = []; this.stop(); this.download?.abort(); this.current.error = undefined; this.current.state = 'off'; return }
    if (!this.settings().memory.autoLearn) { this.learningEpoch++; this.queue = []; if (this.working) this.stop(); if (this.current.modelReady) this.current.error = undefined }
    if (this.download) return
    if (!this.current.modelReady) this.current.modelReady = await memoryModelReady(this.modelDir)
    this.current.state = this.current.modelReady ? 'idle' : 'off'
  }
  async prepareModel(): Promise<void> {
    if (this.download) return
    if (this.paused) { this.current.error = '录音或游戏期间已暂停记忆模型下载'; return }
    const controller = new AbortController(); this.download = controller
    this.current = { ...this.current, state: 'downloading', error: undefined, progress: 0 }
    try {
      await downloadMemoryModel(this.modelDir, controller.signal, progress => { this.current.progress = Math.round(progress) })
      this.current = { state: 'idle', modelReady: true, pending: this.queue.length }
    } catch (error) {
      this.current.state = 'error'; this.current.error = controller.signal.aborted ? '记忆模型下载已取消' : error instanceof Error ? error.message : '记忆模型下载失败'
    } finally { if (this.download === controller) this.download = null }
  }
  cancelDownload(): void { this.download?.abort() }
  private start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.child) return Promise.resolve()
    this.starting = this.launch().finally(() => { this.starting = null })
    return this.starting
  }
  private async launch(): Promise<void> {
    const generation = this.generation
    await mkdir(this.home, { recursive: true })
    if (generation !== this.generation) throw Error('记忆任务已取消')
    const child = utilityProcess.fork(join(__dirname, 'memory.js'), [], { serviceName: 'YU memory', stdio: 'pipe' })
    this.child = child
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('message', (message: any) => {
      if (this.child !== child) return
      if (message.type === 'llm') {
        const at = performance.now(), signal = this.llmAbort.signal
        const settings = this.settings(), profile = chainFor(settings, 'llm')[0]
        const paused = this.paused && !(this.explicitLearning && [...this.reasons].every(reason => reason === 'foreground'))
        if (!settings.memory.enabled || paused || !profile) { child.postMessage({ type: 'llm-result', id: message.id, error: 'Memory learning unavailable' }); return }
        void memoryCompletion(message.messages, message.kind === 'memory' ? 'memory' : 'facts', signal, messages => {
          this.log(`[memory] llm_call=${++this.llmCalls} request=${message.id}`)
          return complete({ ...settings.polish, ...profile }, { messages, temperature: 0, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), effort: 'off',
            onUsage: usage => this.log(`[memory] tokens input=${usage.inputTokens} output=${usage.outputTokens}`) })
        })
          .then(text => { if (this.child === child && !signal.aborted) child.postMessage({ type: 'llm-result', id: message.id, text }) })
          .catch(error => { if (this.child === child) child.postMessage({ type: 'llm-result', id: message.id, error: error instanceof MemoryReplyError ? '记忆模型返回了无效的结构化结果' : 'Memory model request failed' }) })
          .finally(() => this.log(`[memory] llm_ms=${Math.round(performance.now() - at)}`))
        return
      }
      const pending = this.pending.get(message.id); this.pending.delete(message.id)
      if (message.error) pending?.reject(Error(message.error)); else pending?.resolve(message.value)
    })
    child.once('exit', () => { if (this.child === child) this.stop() })
    await this.send('init', { home: this.home, modelDir: this.modelDir })
  }
  private send(method: string, payload: Record<string, unknown> = {}): Promise<any> {
    const child = this.child
    if (!child) return Promise.reject(Error('记忆服务尚未启动'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); child.postMessage({ id, method, ...payload }) })
  }
  private async request(method: string, payload: Record<string, unknown> = {}, timeout = 30000): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const generation = this.generation
    try {
      return await Promise.race([this.start().then(() => this.send(method, payload)), new Promise((_, reject) => { timer = setTimeout(() => { if (method !== 'recall') this.stop(); reject(Error('记忆处理超时')) }, timeout) })])
    } finally {
      if (timer) clearTimeout(timer)
      if (generation === this.generation) {
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => { this.idleTimer = null; this.reclaim() }, method === 'list' || method === 'graph' ? 5000 : 30000); this.idleTimer.unref()
      }
    }
  }
  async recall(kind: MemoryKind, text: string): Promise<MemoryEntry[]> {
    if (kind === 'assistant' && !personalMemoryQuery(text)) return []
    const blocked = [...this.reasons].some(reason => reason !== 'foreground')
    if (!this.settings().memory.enabled || !this.current.modelReady || blocked || this.working || this.mutating) return []
    try { return await this.request('recall', { kind, text: text.slice(0, 2000) }, 600) }
    catch { return [] }
  }
  enqueueLearning(kind: MemoryKind, text: string, sourceId: string): void {
    if (!this.settings().memory.enabled || !this.settings().memory.autoLearn || !text.trim() || /(?:他说|她说|假设|扮演|小说|示例|网页上|文件里|密码|密钥|api.?key|sk-[a-z0-9])/iu.test(text)) return
    this.queue.push({ kind, text: text.slice(0, 2000), sourceId, at: Date.now() }); this.queue = this.queue.slice(-30)
    if (!this.working) this.current.state = 'waiting'
    this.schedule()
  }
  private schedule(): void {
    if (this.current.state === 'error') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.learn() }, 30000); this.timer.unref()
  }
  retryLearning(): void {
    if (!this.settings().memory.enabled || !this.settings().memory.autoLearn || this.working || this.mutating) return
    this.current.error = undefined; this.current.state = this.queue.length ? 'waiting' : 'idle'
    if (this.queue.length) void this.learn()
  }
  private async learn(): Promise<void> {
    if (!this.queue.length || this.paused || !this.settings().memory.enabled || !this.settings().memory.autoLearn || !this.current.modelReady) return
    if (this.busy() || this.working || this.mutating || !this.idleEnough() || (this.queue.length < 3 && Date.now() - this.queue[0].at < 5 * 60000)) { this.schedule(); return }
    const generation = this.generation, batch = this.queue.splice(0, 3)
    this.learningBatch = batch
    this.working = true; this.current.state = 'working'; this.current.error = undefined
    try {
      for (const kind of ['assistant', 'style'] as const) {
        const items = batch.filter(row => row.kind === kind)
        if (items.length) await this.request('learn', { kind, text: items.map(row => row.text).join('\n').slice(0, 6000), sourceId: items.map(row => row.sourceId).join(',') }, 90000)
        if (generation !== this.generation) return
        this.learningBatch = this.learningBatch.filter(row => row.kind !== kind)
      }
      this.current.state = 'idle'; this.current.error = undefined
    } catch (error) { if (generation === this.generation) { this.queue = [...this.learningBatch, ...this.queue].slice(-30); this.current.state = 'error'; this.current.error = error instanceof Error ? error.message : '记忆学习未完成，请检查模型连接' } }
    finally { this.learningBatch = []; this.working = false; if (generation === this.generation) this.stop(); if (this.queue.length && !this.paused && this.current.state !== 'error') this.schedule() }
  }
  async list(kind: MemoryKind): Promise<MemoryEntry[]> {
    if (!this.current.modelReady) this.current.modelReady = await memoryModelReady(this.modelDir)
    return this.catalogRequest('list', { kind })
  }
  graph(kind?: MemoryKind, query = ''): Promise<MemoryGraph> { return this.catalogRequest('graph', { kind, query: query.slice(0, 200) }) }
  private async catalogRequest(method: string, payload: Record<string, unknown>): Promise<any> {
    const interrupted = this.working
    if (interrupted) this.pause('catalog')
    try { return await this.request(method, payload) }
    finally { if (interrupted) this.resume('catalog') }
  }
  reclaim(): void {
    if (this.working || this.mutating || this.pending.size || this.busy()) {
      if (this.child && !this.idleTimer) { this.idleTimer = setTimeout(() => { this.idleTimer = null; this.reclaim() }, 30000); this.idleTimer.unref() }
      return
    }
    this.stop()
    if (this.queue.length && !this.paused) this.schedule()
  }
  private mutate(method: string, kind?: MemoryKind, id?: string, text?: string, sourceId = 'manual'): Promise<void> {
    this.learningEpoch++; this.queue = []; this.mutating++
    const operation = this.mutations.then(async () => {
      if (method === 'add' && sourceId !== 'manual' && [...this.reasons].some(reason => reason !== 'foreground')) throw Error('录音或游戏期间暂不整理记忆，请结束后重试')
      this.queue = []; this.stop()
      if (method === 'add' || method === 'update') {
        if (!this.current.modelReady) throw Error('请先下载记忆模型')
        if (!text?.trim() || text.length > 2000) throw Error('记忆内容需为 1–2000 字')
      }
      this.explicitLearning = method === 'add' && sourceId !== 'manual'
      try { await this.request(method, { kind, memoryId: id, text: text?.trim(), sourceId }, this.explicitLearning ? 90000 : undefined) }
      finally { this.explicitLearning = false }
      this.current.error = undefined; this.current.state = 'idle'
    }).finally(() => { this.mutating--; if (!this.mutating) this.reclaim() })
    this.mutations = operation.catch(() => {})
    return operation
  }
  add(kind: MemoryKind, text: string, sourceId: string): Promise<void> { return this.mutate('add', kind, undefined, text, sourceId) }
  update(kind: MemoryKind, id: string, text: string): Promise<void> { return this.mutate('update', kind, id, text) }
  delete(kind: MemoryKind, id: string): Promise<void> { return this.mutate('delete', kind, id) }
  clear(): Promise<void> { return this.mutate('clear') }
  pause(reason = 'manual'): void {
    this.reasons.add(reason)
    if (this.working && this.learningBatch.length) {
      this.queue = [...this.learningBatch, ...this.queue].slice(-30)
      this.learningBatch = []
    }
    if ((reason !== 'foreground' && reason !== 'recording') || this.working) this.stop()
    if (reason !== 'foreground') this.download?.abort()
  }
  resume(reason = 'manual'): void { this.reasons.delete(reason); if (this.queue.length) this.schedule() }
  private stop(): void {
    if (this.current.state === 'working') this.current.state = 'idle'
    this.generation++; this.llmAbort.abort(); this.llmAbort = new AbortController()
    const child = this.child; this.child = null; this.starting = null
    for (const pending of this.pending.values()) pending.reject(Error('记忆任务已取消'))
    this.pending.clear(); child?.kill()
    if (this.timer) clearTimeout(this.timer); this.timer = null
    if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null
  }
  shutdown(): void { this.learningEpoch++; this.queue = []; this.download?.abort(); this.stop() }
}
