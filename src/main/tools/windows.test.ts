import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, unlink, rmdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WindowsTools, WINDOWS_TOOLS } from './windows'
import { runTool, toolSchemas } from './registry'
import { mergeSettings } from '@shared/defaults'

let root: string
let native: ReturnType<typeof vi.fn<(request: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>>>
let openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
let openUrl: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
let tools: WindowsTools
const owned: string[] = []
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'qinly-tools-')))
  native = vi.fn().mockResolvedValue({ files: [], backend: 'folder' })
  openPath = vi.fn().mockResolvedValue(''); openUrl = vi.fn().mockResolvedValue(undefined)
  tools = new WindowsTools({ folders: { downloads: root, desktop: root, documents: root }, native, openPath, openUrl })
  tools.beginTask()
})
afterEach(async () => { for (const path of owned.splice(0).reverse()) await unlink(path).catch(() => {}); await rmdir(root) })
const file = async (name: string): Promise<string> => { const path = join(root, name); await writeFile(path, 'owned'); owned.push(path); return path }
const row = (path: string) => ({ name: path.split(/[\\/]/).at(-1)!, path, bytes: 5, modified: '2026-10-22T01:00:00Z' })

describe('Windows tools permissions and real result selection', () => {
  it('leaves compound requests to the tool loop instead of using the whole sentence as an app name', () => {
    expect(tools.command('打开计算器，帮我算一下 258 乘以 36。')).toBeNull()
    expect(tools.command('Open Calculator and calculate 258 times 36.')).toBeNull()
    expect(tools.command('打开计算器。')).toEqual({ name: 'open_application', args: { name: '计算器' } })
  })
  it('uses a custom Downloads getter on each task and requests bounded recursion and archive extensions', async () => {
    let folder = root
    const dynamic = new WindowsTools({ folders: () => ({ downloads: folder, desktop: root, documents: root }), native, openPath, openUrl })
    await dynamic.run('search_files', { type: 'archive', recursive: true })
    expect(native.mock.calls[0][0]).toMatchObject({ root, recursive: true, extensions: expect.arrayContaining(['zip', 'rar', '7z']) })
    folder = join(root, 'nonexistent-download-folder')
    await expect(dynamic.run('search_files', {})).rejects.toThrow()
    expect(native).toHaveBeenCalledTimes(1)
  })
  it('resolves Explorer by its original handle and does not silently substitute Downloads', async () => {
    const context = { appName: 'explorer', processId: 42, windowHandle: '1234', windowTitle: 'Project' }
    native.mockResolvedValueOnce({ folder: root }).mockResolvedValueOnce({ files: [] })
    expect((await tools.run('search_files', { folder: 'current' }, undefined, context)).ok).toBe(true)
    expect(native.mock.calls[0][0]).toEqual({ action: 'explorer-folder', handle: '1234', pid: 42, title: 'Project' })
    expect(native.mock.calls[1][0].root).toBe(root)
    await expect(tools.run('get_current_folder', {}, undefined, { ...context, appName: 'code' })).rejects.toThrow('原窗口不是')
  })
  it('reads only a real browser URL directly and respects cancellation', async () => {
    const context = { appName: 'chrome', processId: 42, windowHandle: '1234', windowTitle: 'Web page' }
    native.mockResolvedValueOnce({ url: 'https://example.com/page' }).mockResolvedValueOnce({ url: null })
    expect((await tools.run('get_current_page', {}, undefined, context)).data.url).toBe('https://example.com/page')
    expect((await tools.run('get_current_page', {}, undefined, context)).ok).toBe(false)
    native.mockClear()
    const controller = new AbortController(); controller.abort()
    await expect(tools.run('get_current_page', {}, controller.signal, context)).rejects.toThrow()
    expect(native).not.toHaveBeenCalled()
  })
  it.each(['计算器', 'Calculator'])('activates a discovered packaged calculator for %s without guessing an exe path or prompting again', async name => {
    const appId = 'Microsoft.WindowsCalculator_registered!App'
    native.mockResolvedValueOnce({ applications: [{ name: 'Localized Calculator', path: '', appId }] }).mockResolvedValueOnce({ activated: true })
    expect((await tools.run('open_application', { name })).ok).toBe(true)
    expect(native).toHaveBeenLastCalledWith({ action: 'activate', appId }, undefined)
    expect(openPath).not.toHaveBeenCalled()
  })
  it('uses only the frozen original window metadata and refuses absent/sensitive targets', async () => {
    expect(await tools.run('get_active_window', {}, undefined, { appName: 'code', windowTitle: 'Project', processId: 123 }))
      .toMatchObject({ ok: true, data: { appName: 'code', title: 'Project', processId: 123 } })
    expect((await tools.run('get_active_window', {})).ok).toBe(false)
    expect((await tools.run('get_active_window', {}, undefined, { appName: '1Password', processId: 123 })).ok).toBe(false)
    expect(native).not.toHaveBeenCalled()
  })
  it('reads actual disk data through the fixed native bridge without a model-calculated capacity', async () => {
    native.mockResolvedValue({ drives: [{ name: 'C:\\', totalBytes: 100, freeBytes: 60, usedBytes: 40 }] })
    expect(await tools.run('get_disk_space', {})).toMatchObject({ ok: true, data: { drives: [{ totalBytes: 100, freeBytes: 60, usedBytes: 40 }], unit: 'bytes' } })
    expect(native).toHaveBeenCalledWith({ action: 'disk-space' }, undefined)
  })
  it('opens a requested website without asking for authorization again', async () => {
    expect((await tools.run('open_url', { url: 'https://example.com/' })).ok).toBe(true)
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/')
  })
  it('opens a requested registered application without another confirmation', async () => {
    const path = await file('Example.exe')
    native.mockResolvedValue({ applications: [{ name: 'Example', path }] })
    expect((await tools.run('open_application', { name: 'Example' })).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(path)
  })
  it('opens a requested folder without another confirmation', async () => {
    expect((await tools.run('open_folder', { folder: 'downloads' })).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(root)
  })
  it('opens a selected real document without repeating the search authorization', async () => {
    const path = await file('selected.pdf')
    native.mockResolvedValue({ files: [row(path)] })
    const found = await tools.run('search_files', {})
    const id = (found.data.items as { id: string }[])[0].id
    expect((await tools.run('open_file', { id })).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(path)
  })
  it('does not expose local tools to legacy Ask even if model guesses a name', async () => {
    expect(toolSchemas().map(t => (t.function as { name: string }).name)).not.toContain('search_files')
    const result = await runTool('search_files', {}, { windows: tools, settings: mergeSettings({}), question: '', log: vi.fn() })
    expect(result.ok).toBe(false); expect(native).not.toHaveBeenCalled()
  })
  it('uses known folders without a model, and leaves failed opens as failures', async () => {
    expect(tools.command('打开下载文件夹')).toEqual({ name: 'open_folder', args: { folder: 'downloads' } })
    expect(tools.command('Open my downloads folder')).toEqual({ name: 'open_folder', args: { folder: 'downloads' } })
    openPath.mockResolvedValue('Access denied')
    expect(await tools.run('open_folder', { folder: 'downloads' })).toMatchObject({ ok: false, error: 'Access denied' })
    expect(openPath).toHaveBeenCalledWith(root)
  })
  it('searches requested metadata directly and respects cancelled opening tasks', async () => {
    expect((await tools.run('search_files', {})).ok).toBe(true)
    expect(native).toHaveBeenCalledOnce(); native.mockClear()
    expect(openPath).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(tools.run('open_folder', { folder: 'downloads' }, controller.signal)).rejects.toThrow()
    await expect(tools.run('open_url', { url: 'https://example.com' }, controller.signal)).rejects.toThrow()
    await expect(tools.run('open_application', { name: 'Code' }, controller.signal)).rejects.toThrow()
    expect(native).not.toHaveBeenCalled(); expect(openUrl).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })
  it('does not launch if cancelled while application discovery is in flight', async () => {
    const path = await file('Code.exe'), controller = new AbortController()
    native.mockImplementation(async () => { controller.abort(); return { applications: [{ name: 'Code', path }] } })
    await expect(tools.run('open_application', { name: 'Code' }, controller.signal)).rejects.toThrow()
    expect(openPath).not.toHaveBeenCalled()
  })
  it('launches only a real unique registered application, deduplicating aliases', async () => {
    const path = await file('Code.exe')
    native.mockResolvedValue({ applications: [{ name: 'Code', path }, { name: 'Code', path }] })
    expect((await tools.run('open_application', { name: 'VS Code' })).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(path)
    expect((await tools.run('open_application', { name: 'Missing App' })).ok).toBe(false)
    expect(openPath).toHaveBeenCalledTimes(1)
  })
  it('keeps ambiguous applications as candidates until a new explicit user choice', async () => {
    const one = await file('Code.exe'), two = await file('CodeInsiders.exe')
    native.mockResolvedValue({ applications: [{ name: 'Visual Studio Code', path: one }, { name: 'Visual Studio Code Insiders', path: two }] })
    const result = await tools.run('open_application', { name: 'Visual Studio Code' })
    // Exact match takes precedence; broaden to a truly ambiguous substring.
    expect(result.ok).toBe(true)
    openPath.mockClear()
    const ambiguous = await tools.run('open_application', { name: 'Visual Studio' })
    const items = ambiguous.data.items as { id: string }[]
    expect(items).toHaveLength(2); expect(openPath).not.toHaveBeenCalled()
    expect((await tools.run('open_application', { id: items[0].id })).ok).toBe(false)
    tools.beginTask()
    const command = tools.command('打开第二个')!
    expect((await tools.run(command.name, command.args)).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(two)
  })
  it('requires user selection for multiple files and rejects fabricated ids, scripts and expired results', async () => {
    const one = await file('one.pdf'), two = await file('two.txt'), script = await file('script.ps1')
    native.mockResolvedValue({ files: [row(one), row(two), row(script)], backend: 'folder' })
    const result = await tools.run('search_files', {})
    const items = result.data.items as { id: string }[]
    expect((await tools.run('open_file', { id: items[0].id })).ok).toBe(false)
    tools.beginTask()
    expect((await tools.run('open_file', { id: 'invented' })).ok).toBe(false)
    expect((await tools.run('open_file', { id: items[2].id })).ok).toBe(false)
    expect((await tools.run('open_file', { id: items[1].id })).ok).toBe(true)
    expect(openPath).toHaveBeenCalledExactlyOnceWith(two)
    tools.clear(); expect(() => tools.operation(items[0].id)).toThrow()
  })
  it('opens a unique document result in the next step, preserving its metadata', async () => {
    const path = await file('report.pdf'); native.mockResolvedValue({ files: [row(path)], backend: 'windows-search+folder' })
    const result = await tools.run('search_files', { day: 'yesterday', sort: 'size', minBytes: 1 })
    const request = native.mock.calls[0][0]
    expect(Date.parse(request.before as string) - Date.parse(request.after as string)).toBe(86_400_000)
    expect(request).toMatchObject({ root, action: 'search', minBytes: 1, sort: 'size' })
    const items = result.data.items as { id: string }[]
    expect((await tools.run('open_file', { id: items[0].id })).ok).toBe(true)
  })
  it('blocks path escapes, whole-drive requests and network/shell URL schemes', async () => {
    for (const url of ['file:///C:/x.exe', 'powershell:calc', 'https://user:secret@example.com', 'javascript:alert(1)']) expect((await tools.run('open_url', { url })).ok).toBe(false)
    expect(openUrl).not.toHaveBeenCalled()
    expect((await tools.run('search_files', { folder: 'relative' })).ok).toBe(false)
    expect((await tools.run('search_files', { name: "x%' OR 1=1" })).ok).toBe(false)
    expect((await tools.run('search_files', { after: 'nonsense' })).ok).toBe(false)
    expect((await tools.run('open_folder', { folder: 123 })).ok).toBe(false)
    expect((await tools.run('open_application', { name: 'Code', command: 'calc.exe' })).ok).toBe(false)
    expect((await tools.run('search_files', { sort: 'random' })).ok).toBe(false)
    expect(native).not.toHaveBeenCalled()
  })
  it('does not follow a result junction outside the authorized folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'qinly-outside-'))
    const target = join(outside, 'outside.txt'); await writeFile(target, 'owned')
    const link = join(root, 'escape')
    try {
      await symlink(outside, link, 'junction')
      native.mockResolvedValue({ files: [row(join(link, 'outside.txt'))] })
      const result = await tools.run('search_files', {})
      expect(result.data.items).toEqual([])
    } finally { await rmdir(link).catch(() => {}); await unlink(target); await rmdir(outside) }
  })
  it('reports real failures in receipts without writing sensitive metadata to logs', async () => {
    openPath.mockResolvedValue('Access denied')
    const receipt = vi.fn(), log = vi.fn()
    const result = await runTool('open_folder', {}, { windows: tools, allowedTools: WINDOWS_TOOLS, settings: mergeSettings({}), question: 'open', log, onLocalResult: receipt })
    expect(result.ok).toBe(false); expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(openPath).toHaveBeenCalledWith(root)
    expect(log.mock.calls.every(([line]) => !line.includes(root))).toBe(true)
  })
})


it('does not confuse website names or domains with registered applications', () => {
  for (const query of ['帮我打开卡巴斯基的官方网站', 'Open the official Kaspersky website', '打开 github.com']) expect(tools.command(query)).toBeNull()
  expect(tools.command('打开 VS Code')).toEqual({ name: 'open_application', args: { name: 'VS Code' } })
})
it('opens official URLs only from explicit input or actual tool evidence', async () => {
  const base = { settings: mergeSettings({}), windows: tools, allowedTools: WINDOWS_TOOLS, question: '帮我打开卡巴斯基的官方网站', log: vi.fn(), cache: new Map() }
  expect((await runTool('open_url', { url: 'https://invented.example' }, base)).ok).toBe(false)
  expect(openUrl).not.toHaveBeenCalled()
  base.cache.set('web_search?query=official', Promise.resolve({ ok: true, data: {}, summary: 'Found', sources: [{ title: 'Official site', url: 'https://official.example/', snippet: '' }] }))
  expect((await runTool('open_url', { url: 'https://official.example/' }, base)).ok).toBe(true)
  expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://official.example/')
})
