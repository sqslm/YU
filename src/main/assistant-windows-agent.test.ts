import { beforeEach, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { askAgent } from './agent'
import { WINDOWS_TOOLS, type WindowsTools } from './tools/windows'

const mocks = vi.hoisted(() => ({ complete: vi.fn() }))
vi.mock('./providers/llm', async original => ({ ...await original<typeof import('./providers/llm')>(), complete: mocks.complete }))
const settings = mergeSettings({})
settings.search.enabled = false
Object.assign(settings.polish, { baseUrl: 'http://local.test/v1', model: 'test', apiKey: '' })
const response = (tool?: string, args: unknown = {}, text = '') => new Response(JSON.stringify({ choices: [{ message: tool ? { role: 'assistant', content: '', tool_calls: [{ id: `call-${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
beforeEach(() => vi.clearAllMocks())

it('executes dependent local steps serially with web search disabled, returning actual receipts', async () => {
  const calls: string[] = [], receipts = vi.fn()
  const windows = { run: vi.fn(async (name: string) => {
    calls.push(name)
    return { ok: true, summary: name === 'search_files' ? 'Found one real file' : 'Windows accepted the open request', data: name === 'search_files' ? { items: [{ id: 'real-id', name: 'report.pdf', path: 'C:\\owned\\report.pdf', kind: 'file' }] } : {} }
  }) } as unknown as WindowsTools
  const fetch = vi.fn().mockResolvedValueOnce(response('search_files', { extension: 'pdf' })).mockResolvedValueOnce(response('open_file', { id: 'real-id' })).mockResolvedValueOnce(response(undefined, {}, 'Opened the matching report.'))
  const result = await askAgent(settings, 'Find the newest PDF and open it', {}, undefined, undefined, { windows, allowedTools: WINDOWS_TOOLS, fetchImpl: fetch, onLocalResult: receipts, conversation: { messages: [], toolNotes: '' } })
  expect(calls).toEqual(['search_files', 'open_file'])
  expect(result.tools).toEqual(['search_files', 'open_file'])
  expect(receipts).toHaveBeenCalledTimes(2)
  expect(JSON.parse(fetch.mock.calls[1][1].body).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.stringContaining('real-id') })]))
  const offered = JSON.parse(fetch.mock.calls[0][1].body).tools.map((tool: { function: { name: string } }) => tool.function.name)
  expect(offered).not.toContain('web_search')
  expect(mocks.complete).not.toHaveBeenCalled()
})

it('uses the existing strict JSON fallback for a gateway without native tools', async () => {
  const windows = { run: vi.fn().mockResolvedValue({ ok: true, data: {}, summary: 'Actually opened folder' }) } as unknown as WindowsTools
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }))
  mocks.complete.mockResolvedValueOnce('{"tool":"open_folder","args":{"folder":"downloads"}}').mockResolvedValueOnce('{"tool":"answer","args":{}}').mockResolvedValueOnce('Folder opened.')
  const result = await askAgent(settings, 'Please show my downloads', {}, undefined, undefined, { windows, allowedTools: WINDOWS_TOOLS, fetchImpl: fetch, conversation: { messages: [], toolNotes: '' } })
  expect(windows.run).toHaveBeenCalledExactlyOnceWith('open_folder', { folder: 'downloads' }, expect.any(AbortSignal))
  expect(result.tools).toEqual(['open_folder'])
})

it('does not execute an oversized tool batch and bounds planning rounds', async () => {
  const windows = { run: vi.fn().mockResolvedValue({ ok: true, data: {}, summary: 'done' }) } as unknown as WindowsTools
  const fetch = vi.fn(async () => response('open_folder', { folder: 'downloads' }))
  mocks.complete.mockResolvedValue('Stopped at the step limit.')
  await askAgent(settings, 'Open folders repeatedly', {}, undefined, undefined, { windows, allowedTools: WINDOWS_TOOLS, fetchImpl: fetch, conversation: { messages: [], toolNotes: '' } })
  expect(windows.run).toHaveBeenCalledTimes(4)
  expect(fetch).toHaveBeenCalledTimes(5)
})
