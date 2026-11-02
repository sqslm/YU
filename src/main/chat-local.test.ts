import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { ChatService } from './chat'
import { runTool } from './tools/registry'
import type { PersonalTools } from './tools/personal'
import type { LifeTools } from './tools/life'
import { LOCAL_QUERY_TOOLS } from '@shared/workspace'

const mock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./net/egress', async original => ({ ...await original<typeof import('./net/egress')>(), egressFetch: mock.fetch }))
vi.mock('./providers/llm', async original => ({ ...await original<typeof import('./providers/llm')>(), complete: vi.fn(async (_settings, request) => JSON.stringify(request.messages).includes('权限设置') ? '权限已关闭' : '随记查询') }))
const roots: string[] = [], services: ChatService[] = []
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

it.each([false, true])('queries real local notes with web search off and permission disabled=%s', async disabled => {
  const root = mkdtempSync(join(tmpdir(), 'yu-chat-local-')); roots.push(root)
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.search.enabled = false
  settings.profiles = [{ ...settings.polish, id: 'local-test', name: 'test', kind: 'llm', enabled: true, preset: '' }]
  if (disabled) settings.assistantAccess.disabledTools = ['search_notes']
  const notes = vi.fn(() => [{ id: 'actual-note', title: '周会', transcript: '上线时间是周五', polished: '', tags: [], createdAt: 1, updatedAt: 1 }])
  const personal = { notes, categories: () => [] } as unknown as PersonalTools
  let round = 0
  mock.fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init.body))
    const names = body.tools?.map((tool: any) => tool.function.name) ?? []
    expect(names).not.toContain('create_note'); expect(names).not.toContain('web_search')
    const message = round++ === 0
      ? { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"上线"}' } }] }
      : { content: disabled ? '权限已关闭' : '上线时间是周五' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  })
  const service = new ChatService(join(root, 'chats.db'), () => settings, () => {}, () => ({ personal })); services.push(service)
  const thread = service.create(null)
  await service.send(thread.id, '找一下关于上线的随记，不要联网')
  const answer = service.get(thread.id).messages.at(-1)!
  expect(answer.text).toContain(disabled ? '权限' : '周五')
  expect(answer.records).toEqual(disabled ? [] : [expect.objectContaining({ kind: 'note', id: 'actual-note', title: '周会' })])
  if (disabled) expect(notes).not.toHaveBeenCalled()
  else {
    service.close()
    const reopened = new ChatService(join(root, 'chats.db'), () => settings, () => {}); services.push(reopened)
    expect(reopened.get(thread.id).messages.at(-1)?.records?.[0].id).toBe('actual-note')
  }
})

it('keeps write operations outside the chat query allowlist', async () => {
  const saveEvent = vi.fn()
  const result = await runTool('create_event', { title: 'x', start: '明天上午十点' }, { settings: structuredClone(DEFAULT_SETTINGS), question: '创建日程', log: () => {}, life: { saveEvent } as unknown as LifeTools, allowedTools: LOCAL_QUERY_TOOLS })
  expect(result.ok).toBe(false); expect(saveEvent).not.toHaveBeenCalled()
})
