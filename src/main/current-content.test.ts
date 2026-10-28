import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directVoiceIntent, needsAssistantContext } from './voice-intent'
import { browserAddress, WindowsTools, WINDOWS_TOOLS } from './tools/windows'
import { DEFAULT_ASSISTANT_ACCESS } from '@shared/assistantAccess'
import { mergeSettings } from '@shared/defaults'
import { askAgent } from './agent'
import { runTool } from './tools/registry'
import { createTask } from './task-context'

const context = { windowHandle: '123', processId: 456, windowTitle: 'Actual document', appName: 'ego' }
const mocks = vi.hoisted(() => ({ complete: vi.fn() }))
vi.mock('./providers/llm', async original => ({ ...await original<typeof import('./providers/llm')>(), complete: mocks.complete }))
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }) })
const make = (native = vi.fn(), access = DEFAULT_ASSISTANT_ACCESS) => new WindowsTools({ native, folders: { downloads: '', desktop: '', documents: '' }, openPath: vi.fn(), openUrl: vi.fn(), access: () => access })

it('never summarizes YU itself when its card or settings owns the foreground', async () => {
  const native = vi.fn().mockResolvedValue({ text: 'Ask 对话：请总结我的网页' })
  const result = await make(native).run('read_current_content', {}, undefined, { ...context, processId: process.pid, appName: 'YU', windowTitle: '语' })
  expect(result.ok).toBe(false)
  expect(native).not.toHaveBeenCalled()
})

it('uses the external window frozen before recording while retaining the original insertion target', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://github.com/Niko1221/Strata', text: 'Run powerful AI on your own computer.', title: 'Strata' })
  const own = { windowHandle: '700', processId: process.pid, appName: 'YU', windowTitle: '语' }
  const task = createTask('wake', own)
  task.contentTarget = Object.freeze({ ...context })
  const result = await make(native).run('read_current_content', {}, undefined, { ...own, task })
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ handle: '123', pid: 456, title: 'Actual document' }), undefined)
  expect(result.data.url).toBe('https://github.com/Niko1221/Strata')
  expect(task.target.windowHandle).toBe('700')
})

it('retains the captured browser link when fetching the body fails', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://example.com/article' })
  const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
  const result = await make(native).run('read_current_content', {}, undefined, context, { fetchImpl, allowNetwork: true })
  expect(result.ok).toBe(false)
  expect(result.data.url).toBe('https://example.com/article')
  expect(result.summary).toContain('https://example.com/article')
})

it.each(['总结选中的文字', '总结刚才的回答', '明天提醒我总结当前文档', '给 Agent 写提示词：总结当前网页', '不要总结这个网页', 'How do I summarize documents?', 'Summarize the selected text', 'Do not read this document'])('does not authorize a current-window read from another intent: %s', async question => {
  const native = vi.fn()
  const result = await runTool('read_current_content', {}, { settings: mergeSettings({}), question, windows: make(native), allowedTools: WINDOWS_TOOLS, taskContext: context, log: () => {} })
  expect(result.ok).toBe(false)
  expect(native).not.toHaveBeenCalled()
})

it.each([
  ['github.com/sqslm/YU', 'https://github.com/sqslm/YU'],
  ['http://example.com/article', 'http://example.com/article'],
  ['\u200ehttps://example.com/', 'https://example.com/'],
  ['javascript:alert(1)', ''], ['search words', ''], ['https://user:secret@example.com', ''], ['file:///C:/private.txt', '']
])('normalizes real browser address values safely: %s', (input, output) => expect(browserAddress(input)).toBe(output))

it('uses public article content when the browser has only an address and never needs a search key', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'github.com/example/project' })
  const fetch = vi.fn().mockResolvedValue(new Response('<html><title>Project</title><nav>Site menus</nav><main>Files<article>This project transcribes meetings and stores decisions.</article>Footer</main></html>', { headers: { 'content-type': 'text/html' } }))
  const result = await make(native).run('read_current_content', {}, undefined, context, { fetchImpl: fetch, allowNetwork: true })
  expect(result.ok).toBe(true)
  expect(result.data.text).toBe('This project transcribes meetings and stores decisions.')
  expect(result.sources?.[0].url).toBe('https://github.com/example/project')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('reads the rendered body offline without fetching or exporting browser cookies', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://example.com/account/article', text: 'Actual visible article', truncated: false })
  const fetch = vi.fn()
  const result = await make(native).run('read_current_content', {}, undefined, context, { fetchImpl: fetch, allowNetwork: false })
  expect(result.data.text).toBe('Actual visible article')
  expect(result.data.truncated).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('does not fetch when the human explicitly forbids network access', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://example.com/article' }), fetch = vi.fn()
  const result = await runTool('read_current_content', {}, { settings: mergeSettings({}), question: '不要联网，总结当前网页', windows: make(native), allowedTools: WINDOWS_TOOLS, taskContext: context, fetchImpl: fetch, log: () => {} })
  expect(result.ok).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('retains accessible text when the public URL cannot be fetched', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://github.com/example/private', text: 'Actual private project body', truncated: true })
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
  const result = await make(native).run('read_current_content', {}, undefined, context, { fetchImpl: fetch, allowNetwork: true })
  expect(result.ok).toBe(true)
  expect(result.data.text).toBe('Actual private project body')
  expect(result.data.truncated).toBe(true)
})

it('does not replace rendered article text with a public sign-in redirect', async () => {
  const native = vi.fn().mockResolvedValue({ url: 'https://example.com/article', text: 'Actual article seen by the user', truncated: true })
  const response = new Response('<html><main>' + 'Sign in to continue. '.repeat(20) + '</main></html>', { headers: { 'content-type': 'text/html' } })
  Object.defineProperty(response, 'url', { value: 'https://example.com/login' })
  const fetch = vi.fn().mockResolvedValue(response)
  const result = await make(native).run('read_current_content', {}, undefined, context, { fetchImpl: fetch, allowNetwork: true })
  expect(result.data.text).toBe('Actual article seen by the user')
  expect(result.data.truncated).toBe(true)
})

it('shows partial coverage in the actual receipt as well as in model data', async () => {
  const native = vi.fn().mockResolvedValue({ text: 'Actual text', truncated: true }), onLocalResult = vi.fn()
  await runTool('read_current_content', {}, { settings: mergeSettings({}), question: '总结当前文档', windows: make(native), allowedTools: WINDOWS_TOOLS, taskContext: context, onLocalResult, log: () => {} })
  expect(onLocalResult).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('仅读取了部分') }))
})

it('bounds current text and identifies unsaved document coverage', async () => {
  const native = vi.fn().mockResolvedValue({ text: 'word '.repeat(20_000) })
  const result = await make(native).run('read_current_content', {}, undefined, context)
  expect((result.data.text as string).length).toBe(48_000)
  expect(result.data.truncated).toBe(true)
  expect(result.data.coverage).toContain('未提供完整文件路径')
})

it('fails explicitly on missing original windows, cancellation and unavailable bodies', async () => {
  const native = vi.fn().mockResolvedValue({})
  await expect(make(native).run('read_current_content', {})).rejects.toThrow('原窗口')
  const controller = new AbortController(); controller.abort()
  await expect(make(native).run('read_current_content', {}, controller.signal, context)).rejects.toThrow()
  expect(native).not.toHaveBeenCalled()
  expect((await make(native).run('read_current_content', {}, undefined, context)).ok).toBe(false)
})

it.each(['帮我总结一下这个网页', '介绍一下当前 GitHub 项目是干嘛的', '总结当前打开的文件', '总结选中的文件', '总结一下', 'Summarize the current document', 'Summarize the selected file', 'Explain this repository'])('routes current content to assistant tools: %s', text => {
  expect(directVoiceIntent(text)).toEqual({ kind: 'assistant' })
  expect(needsAssistantContext(text)).toBe(false)
})

it.each(['ego', 'msedge', 'firefox', 'custom-browser'])('gets the actual address without a process whitelist: %s', async appName => {
  const native = vi.fn().mockResolvedValue({ url: 'https://github.com/sqslm/YU' })
  expect((await make(native).run('get_current_page', {}, undefined, { ...context, appName })).ok).toBe(true)
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ action: 'browser-url', handle: '123', pid: 456 }), undefined)
})

it('reads the current file body rather than searching its title', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'yu-current-'))); dirs.push(dir)
  const path = join(dir, 'report.md'); await writeFile(path, '# Actual project\nThis tool records meeting decisions.')
  const native = vi.fn().mockResolvedValue({ path })
  const result = await make(native).run('read_current_content', {}, undefined, context)
  expect(result.ok).toBe(true)
  expect(result.data.text).toContain('records meeting decisions')
  expect(result.data.path).toBe(await realpath(path))
})

it('honors file and application exclusions before sending any text to the model', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'yu-current-'))); dirs.push(dir)
  const path = join(dir, 'private.txt'); await writeFile(path, 'private text')
  const native = vi.fn().mockResolvedValue({ path, text: 'private text' })
  const tools = make(native, { ...DEFAULT_ASSISTANT_ACCESS, excludedPaths: [dir] })
  expect((await tools.run('read_current_content', {}, undefined, context)).ok).toBe(false)
  const excluded = make(native, { ...DEFAULT_ASSISTANT_ACCESS, excludedApps: ['ego'] })
  native.mockClear()
  expect((await excluded.run('read_current_content', {}, undefined, context)).ok).toBe(false)
  expect(native).not.toHaveBeenCalled()
})

it('reads image bytes through existing local OCR only after checking file permissions', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'yu-current-'))); dirs.push(dir)
  const path = join(dir, 'scan.png'); await writeFile(path, 'owned image fixture')
  const native = vi.fn().mockResolvedValueOnce({ path }).mockResolvedValueOnce({ text: 'Invoice total: 1200' })
  const result = await make(native).run('read_current_content', {}, undefined, context)
  expect(result.data.text).toBe('Invoice total: 1200')
  expect(native.mock.calls[1][0]).toEqual({ action: 'ocr', png: Buffer.from('owned image fixture').toString('base64') })
})

it('checks the actual Office path before requesting unsaved editor text under a directory grant', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'yu-current-'))); dirs.push(dir)
  const path = join(dir, 'report.docx'); await writeFile(path, 'saved fixture')
  const native = vi.fn().mockResolvedValueOnce({ path, editor: true }).mockResolvedValueOnce({ path, editor: true, text: 'Actual unsaved edit' })
  const result = await make(native, { ...DEFAULT_ASSISTANT_ACCESS, allowedRoots: [dir] }).run('read_current_content', {}, undefined, context)
  expect(result.data.text).toBe('Actual unsaved edit')
  expect(native.mock.calls[0][0]).toMatchObject({ metadataOnly: true })
  expect(native.mock.calls[1][0]).not.toHaveProperty('metadataOnly')
})

it('does not read a newly focused window when the frozen target is stale', async () => {
  const native = vi.fn().mockRejectedValue(new Error('Original window has changed or closed')), fetch = vi.fn()
  const result = await runTool('read_current_content', {}, { settings: mergeSettings({}), question: '总结当前网页', windows: make(native), allowedTools: WINDOWS_TOOLS, taskContext: context, fetchImpl: fetch, log: () => {} })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('Original window has changed')
  expect(native).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('does not call native readers when the tool is disabled', async () => {
  const native = vi.fn()
  const result = await make(native, { ...DEFAULT_ASSISTANT_ACCESS, disabledTools: ['read_current_content'] }).run('read_current_content', {}, undefined, context)
  expect(result.ok).toBe(false)
  expect(native).not.toHaveBeenCalled()
})

it('summarizes actual current content with web search disabled, keeping the article ending', async () => {
  const settings = mergeSettings({}); settings.search.enabled = false
  Object.assign(settings.polish, { baseUrl: 'https://model.test/v1', model: 'test' })
  const text = '正文内容。'.repeat(1600) + 'ENDING: experimental result is negative.'
  const run = vi.fn().mockResolvedValue({ ok: true, summary: 'Read actual page', data: { text, url: 'https://example.com/article', title: 'Article', truncated: false } })
  const windows = { run } as unknown as WindowsTools
  const fetch = vi.fn()
  mocks.complete.mockResolvedValueOnce('实验结果为负。')
  const result = await askAgent(settings, '帮我总结一下这个网页', context, undefined, undefined, { windows, allowedTools: WINDOWS_TOOLS, fetchImpl: fetch })
  expect(run).toHaveBeenCalledWith('read_current_content', {}, expect.any(AbortSignal), expect.objectContaining({ windowHandle: '123' }), expect.anything())
  expect(fetch).not.toHaveBeenCalled()
  expect(mocks.complete).toHaveBeenCalledTimes(1)
  expect(mocks.complete.mock.calls[0][1].messages.some((m: { content: string }) => m.content.includes('ENDING: experimental result is negative.'))).toBe(true)
  expect(result.text).toContain('实验结果为负')
})

it('reports the summary model failure without retrying with an ungrounded plain answer', async () => {
  mocks.complete.mockClear(); mocks.complete.mockRejectedValueOnce(new Error('provider unavailable'))
  const settings = mergeSettings({}); settings.search.enabled = false
  const run = vi.fn().mockResolvedValue({ ok: true, summary: 'Read', data: { text: 'Actual content' } })
  const result = await askAgent(settings, '总结当前文档', context, undefined, undefined, { windows: { run } as unknown as WindowsTools, allowedTools: WINDOWS_TOOLS })
  expect(result.taskState).toBe('failed')
  expect(result.text).toContain('模型未能完成总结')
  expect(mocks.complete).toHaveBeenCalledTimes(1)
})

it('does not include the focused YU conversation as document context when summarizing an external page', async () => {
  mocks.complete.mockClear(); mocks.complete.mockResolvedValueOnce('Actual project explanation')
  const run = vi.fn().mockResolvedValue({ ok: true, summary: 'Read', data: { title: 'Strata', url: 'https://github.com/Niko1221/Strata', text: 'Run powerful AI on your own computer.' } })
  await askAgent(mergeSettings({}), '帮我总结这个网页', { ...context, appName: 'YU', windowTitle: '语', fieldContent: 'UNRELATED_ASK_DIALOGUE', textBefore: 'UNRELATED_ASK_DIALOGUE' }, undefined, undefined,
    { windows: { run } as unknown as WindowsTools, allowedTools: WINDOWS_TOOLS })
  const messages = JSON.stringify(mocks.complete.mock.calls[0][1].messages)
  expect(messages).toContain('Run powerful AI on your own computer.')
  expect(messages).not.toContain('UNRELATED_ASK_DIALOGUE')
})

it('summarizes the previous answer for a bare card follow-up instead of reading a new window', async () => {
  mocks.complete.mockClear(); mocks.complete.mockResolvedValueOnce('A short version of the previous answer.')
  const run = vi.fn()
  const result = await askAgent(mergeSettings({}), '总结一下', context, undefined, undefined, {
    reset: false, windows: { run } as unknown as WindowsTools, allowedTools: WINDOWS_TOOLS,
    conversation: { messages: [{ role: 'user', content: 'Explain this project' }, { role: 'assistant', content: 'Actual prior project explanation' }], toolNotes: '' }
  })
  expect(run).not.toHaveBeenCalled()
  expect(result.text).toContain('short version')
  expect(JSON.stringify(mocks.complete.mock.calls[0][1].messages)).toContain('Actual prior project explanation')
})
