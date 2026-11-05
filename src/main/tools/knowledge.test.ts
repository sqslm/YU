import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mergeSettings } from '@shared/defaults'
import { setMainLanguage } from '@shared/mainI18n'

import { KNOWLEDGE_TOOLS, type KnowledgeTools } from './knowledge'
import { TOOL_NAMES, availableToolNames, runTool, type ToolContext } from './registry'

/**
 * The knowledge tools are read-only lookups into the local library plus one
 * explicit re-queue. What matters here: the model can only reach them when the
 * feature is on and the round granted them, the arguments are bounded, and a
 * failure surfaces the helper's own reason instead of a cheerful empty answer.
 */

const card = (id: string, title: string) => ({ id, title, summary: `${title}的摘要`, kind: 'concept', topics: ['锁'], updatedAt: 5 })

let api: KnowledgeTools
let ctx: ToolContext

beforeEach(() => {
  api = {
    search: vi.fn().mockResolvedValue({ total: 2, items: [card('c1', '锁粒度'), card('c2', '幂等键')] }),
    get: vi.fn().mockResolvedValue({ id: 'c1', title: '锁粒度', summary: '摘要', kind: 'concept', topics: ['锁'], body: '锁的粒度决定竞争范围。', sourceIds: ['src_1'], updatedAt: 5 }),
    extractFromNote: vi.fn().mockResolvedValue({ queued: 1, groupId: 'grp_1', state: 'stabilizing' })
  }
  ctx = {
    settings: mergeSettings({}),
    question: '我之前记过锁粒度吗',
    log: vi.fn(),
    allowedTools: ['search_knowledge', 'get_knowledge', 'extract_knowledge'],
    knowledge: api,
    cache: new Map(),
    signal: new AbortController().signal,
    submittedAt: Date.now()
  }
})

afterEach(() => { setMainLanguage('zh') })

describe('knowledge tools inside an answer', () => {
  it('is advertised only while the feature is on', () => {
    for (const name of KNOWLEDGE_TOOLS) expect(TOOL_NAMES).toContain(name)
    expect(availableToolNames(ctx)).toEqual(expect.arrayContaining([...KNOWLEDGE_TOOLS]))
    const off: ToolContext = { ...ctx, knowledge: undefined }
    for (const name of KNOWLEDGE_TOOLS) expect(availableToolNames(off)).not.toContain(name)
  })

  it('refuses a search the round did not grant', async () => {
    const narrow: ToolContext = { ...ctx, allowedTools: ['get_weather'] }
    const result = await runTool('search_knowledge', { query: '锁' }, narrow)
    expect(result.ok).toBe(false)
    expect(api.search).not.toHaveBeenCalled()
  })

  it('bounds the page size and refuses a query that is too long to be a query', async () => {
    await runTool('search_knowledge', { query: '锁', limit: 50 }, ctx)
    expect(api.search).toHaveBeenCalledWith('锁', 8)
    await runTool('search_knowledge', { query: '  幂等键  ' }, ctx)
    expect(api.search).toHaveBeenLastCalledWith('幂等键', 5)
    // A whole paragraph is a question, not a search key: it is refused rather than
    // silently truncated into something the user never asked for.
    const refused = await runTool('search_knowledge', { query: '锁'.repeat(500) }, ctx)
    expect(refused.ok).toBe(false)
    expect(api.search).toHaveBeenCalledTimes(2)
  })

  it('refuses an empty query instead of listing the whole library', async () => {
    const result = await runTool('search_knowledge', { query: '   ' }, ctx)
    expect(result.ok).toBe(false)
    expect(api.search).not.toHaveBeenCalled()
  })

  it('reports a real no-match instead of an empty success', async () => {
    api.search = vi.fn().mockResolvedValue({ total: 0, items: [] })
    const result = await runTool('search_knowledge', { query: '没有这种东西' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('没有')
  })

  it('surfaces the helper failure through get_knowledge', async () => {
    api.get = vi.fn().mockRejectedValue(new Error('unknown card: c9'))
    const result = await runTool('get_knowledge', { id: 'c9' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('unknown card')
  })

  it('re-queues a note through the same entry the app uses', async () => {
    const result = await runTool('extract_knowledge', { noteId: 'n1' }, ctx)
    expect(api.extractFromNote).toHaveBeenCalledWith('n1')
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.data)).toContain('grp_1')
  })
})
