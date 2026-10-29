import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'

const fixture = vi.hoisted(() => ({ children: [] as any[], writes: [] as string[], hanging: false }))
vi.mock('electron', () => ({ utilityProcess: { fork: () => {
  const child = new EventEmitter() as any
  child.killed = false; child.messages = []
  child.kill = vi.fn(() => { child.killed = true })
  child.postMessage = (message: any) => {
    child.messages.push(message)
    if (fixture.hanging && message.method === 'learn') return
    queueMicrotask(() => {
      if (child.killed) return
      if (message.method === 'add' || message.method === 'learn') fixture.writes.push(message.text)
      if (message.method === 'clear') fixture.writes = []
      child.emit('message', { type: 'result', id: message.id, value: message.method === 'list' ? [...fixture.writes] : [] })
    })
  }
  fixture.children.push(child); return child
} } }))
vi.mock('./model', () => ({ memoryModelReady: async () => true, downloadMemoryModel: async () => {} }))
import { MemoryService } from './host'

let settings: Settings, service: MemoryService, busy = false, idleEnough = true
beforeEach(async () => {
  vi.useFakeTimers(); fixture.children = []; fixture.writes = []; fixture.hanging = false
  settings = structuredClone(DEFAULT_SETTINGS); settings.memory = { enabled: true, autoLearn: true }; busy = false; idleEnough = true
  service = new MemoryService('release/verification-entities/memory-host-test', () => settings, () => busy, () => {}, () => idleEnough)
  await service.configure()
})
afterEach(() => { service.shutdown(); vi.useRealTimers() })

it('stays dormant until enabled and explicitly needed', async () => {
  settings.memory.enabled = false; await service.configure()
  expect(await service.recall('assistant', '我的名字')).toEqual([])
  expect(fixture.children).toHaveLength(0)
  expect(service.status().state).toBe('off')
})
it('serializes management writes and clears pending learning before deletion', async () => {
  service.enqueueLearning('assistant', '我在杭州工作', 'turn-1')
  await Promise.all([service.add('assistant', '手动添加', 'manual'), service.clear()])
  expect(fixture.writes).toEqual([])
  expect(service.status().pending).toBe(0)
  await vi.advanceTimersByTimeAsync(11000)
  expect(fixture.writes).toEqual([])
})
it('kills a learning worker before clearing so the cancelled task cannot write back', async () => {
  fixture.hanging = true
  service.enqueueLearning('assistant', '我习惯使用中文', 'turn-2')
  await vi.advanceTimersByTimeAsync(300000)
  // Native launch reaches the filesystem asynchronously.
  for (let i = 0; i < 10 && !fixture.children.length; i++) await vi.waitFor(() => expect(fixture.children.length).toBeGreaterThan(0))
  const old = fixture.children[0]
  await service.clear()
  expect(old.kill).toHaveBeenCalled()
  expect(fixture.writes).toEqual([])
})
it('separates game and recording pauses and never learns while foreground work is busy', async () => {
  service.pause('game'); service.pause('recording'); service.resume('recording')
  expect(service.status().state).toBe('paused')
  service.enqueueLearning('style', '以后写作保持简洁', 'turn-3')
  await vi.advanceTimersByTimeAsync(11000); expect(fixture.children).toHaveLength(0)
  service.resume('game'); busy = true
  await vi.advanceTimersByTimeAsync(11000); expect(fixture.children).toHaveLength(0)
})
it('keeps an idle warmed process across recording so each voice question does not cold-start memory', async () => {
  await service.list('assistant')
  const child = fixture.children[0]
  service.pause('recording')
  expect(child.kill).not.toHaveBeenCalled()
  expect(await service.recall('assistant', '我的偏好')).toEqual([])
  service.resume('recording')
  await service.recall('assistant', '我的偏好')
  expect(fixture.children).toHaveLength(1)
  service.pause('game')
  expect(child.kill).toHaveBeenCalled()
})
it('retains interrupted learning for resume but clear discards the retained batch', async () => {
  fixture.hanging = true
  service.enqueueLearning('assistant', '我习惯用中文回答', 'paused-turn')
  await vi.advanceTimersByTimeAsync(300000)
  await vi.waitFor(() => expect(fixture.children.length).toBeGreaterThan(0))
  service.pause('game')
  expect(service.status().pending).toBe(1)
  expect(fixture.children[0].kill).toHaveBeenCalled()
  await service.clear()
  service.resume('game')
  expect(service.status().pending).toBe(0)
  await vi.advanceTimersByTimeAsync(11000)
  expect(fixture.writes).toEqual([])
})
it('resumes the interrupted batch after the game exits', async () => {
  fixture.hanging = true
  service.enqueueLearning('style', '以后写作使用短句', 'resume-turn')
  await vi.advanceTimersByTimeAsync(300000)
  await vi.waitFor(() => expect(fixture.children.length).toBeGreaterThan(0))
  service.pause('game')
  await vi.advanceTimersByTimeAsync(0)
  fixture.hanging = false
  service.resume('game')
  await vi.advanceTimersByTimeAsync(31000)
  await vi.waitFor(() => expect(fixture.writes).toEqual(['以后写作使用短句']))
})
it.each([
  '他说他叫李明', '她说她住上海', '假设我是一名老师', '扮演一位医生', '小说里我叫张三', '示例：我喜欢红色', '网页上的作者住北京', '文件里提到我在上海', '我的密码是123456', '密钥是secret',
  'API key is test', 'sk-abc123', '帮我保存他说的名字', '她说这是我的爱好', '这段是假设场景', '请扮演我的经理', '小说主角的名字', '输入示例我叫小王', '网页上说他是医生', '文件里是我的示例资料',
  '不要记录我的密码', '帮我核对密钥', 'api_key=xyz', 'apiKey xyz', '这是sk-abcdef', '代码示例：我叫测试', '她说我的项目叫星河', '他说我喜欢英文', '小说设定我住杭州', '假设我喜欢长答案',
  '角色扮演开始', '示例用户偏好短句', '网页上的个人简历', '文件里的地址', '临时密码abc', '数据库密钥xyz', 'api key: abc', 'sk-secret', '他说不要太正式', '她说要保持简洁',
  '以小说角色视角写作', '假设我负责设计', '这只是示例不是我本人', '网页上介绍一个程序员', '文件里的主角用Python', '密码不要发出去', '服务器密钥', 'api-key test', '我在读小说', '她说她的写作偏好'
])('does not auto-enqueue quoted/external/secret sample: %s', text => {
  service.enqueueLearning('assistant', text, 'independent-negative')
  expect(service.status().pending).toBe(0)
})
it('buffers up to thirty candidates without loading a model on enqueue', async () => {
  for (let i = 0; i < 40; i++) service.enqueueLearning('assistant', `我负责项目${i}`, `turn-${i}`)
  expect(service.status().pending).toBe(30)
  expect(fixture.children).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(29999)
  expect(fixture.children).toHaveLength(0)
})
it('waits for an accumulation threshold and resource availability then releases the worker after learning', async () => {
  service.enqueueLearning('assistant', '我喜欢中文', 'turn-1')
  await vi.advanceTimersByTimeAsync(30000)
  expect(fixture.children).toHaveLength(0)
  service.enqueueLearning('assistant', '我在杭州', 'turn-2')
  service.enqueueLearning('assistant', '我做产品设计', 'turn-3')
  idleEnough = false
  await vi.advanceTimersByTimeAsync(30000)
  expect(fixture.children).toHaveLength(0)
  idleEnough = true
  await vi.advanceTimersByTimeAsync(30000)
  await vi.waitFor(() => expect(fixture.writes).toEqual(['我喜欢中文\n我在杭州\n我做产品设计']))
  expect(fixture.children[0].kill).toHaveBeenCalled()
})
it('can release idle resources without invalidating a still-running Ask learning token', async () => {
  const token = service.learningToken()
  await service.list('assistant')
  await vi.advanceTimersByTimeAsync(5100)
  expect(fixture.children[0].kill).toHaveBeenCalled()
  expect(service.learningToken()).toBe(token)
  await service.clear()
  expect(service.learningToken()).not.toBe(token)
})
it('does not release a worker during foreground activity and rechecks when it becomes idle', async () => {
  await service.list('assistant')
  busy = true
  await vi.advanceTimersByTimeAsync(5100)
  expect(fixture.children[0].kill).not.toHaveBeenCalled()
  busy = false
  await vi.advanceTimersByTimeAsync(30000)
  expect(fixture.children[0].kill).toHaveBeenCalled()
})
it('interrupts background extraction to serve the catalog and retains the unfinished candidate', async () => {
  fixture.hanging = true
  service.enqueueLearning('assistant', '我喜欢设计', 'catalog-turn')
  await vi.advanceTimersByTimeAsync(300000)
  await vi.waitFor(() => expect(fixture.children.length).toBeGreaterThan(0))
  const old = fixture.children[0]
  await service.graph()
  expect(old.kill).toHaveBeenCalled()
  expect(service.status().pending).toBe(1)
})
it('cancels queued work when automatic learning is disabled without disabling recall', async () => {
  service.enqueueLearning('assistant', '我在杭州工作', 'old-turn')
  settings.memory.autoLearn = false; await service.configure()
  await vi.advanceTimersByTimeAsync(11000)
  expect(service.status().pending).toBe(0); expect(fixture.children).toHaveLength(0)
  expect(settings.memory.enabled).toBe(true)
})
