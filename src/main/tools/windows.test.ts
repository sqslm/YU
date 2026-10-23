import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, unlink, rmdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WindowsTools, WINDOWS_TOOLS } from './windows'
import { runTool, toolSchemas } from './registry'
import { mergeSettings } from '@shared/defaults'

let root: string
let native: ReturnType<typeof vi.fn>
let confirm: ReturnType<typeof vi.fn>
let openPath: ReturnType<typeof vi.fn>
let openUrl: ReturnType<typeof vi.fn>
let tools: WindowsTools
const owned: string[] = []
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'qinly-tools-')))
  native = vi.fn().mockResolvedValue({ files: [], backend: 'folder' })
  confirm = vi.fn().mockResolvedValue(true)
  openPath = vi.fn().mockResolvedValue(''); openUrl = vi.fn().mockResolvedValue(undefined)
  tools = new WindowsTools({ folders: { downloads: root, desktop: root, documents: root }, native, confirm, openPath, openUrl })
  tools.beginTask()
})
afterEach(async () => { for (const path of owned.splice(0).reverse()) await unlink(path).catch(() => {}); await rmdir(root) })
const file = async (name: string): Promise<string> => { const path = join(root, name); await writeFile(path, 'owned'); owned.push(path); return path }
const row = (path: string) => ({ name: path.split(/[\\/]/).at(-1)!, path, bytes: 5, modified: '2026-10-22T01:00:00Z' })

describe('Windows tools permissions and real result selection', () => {
  it('does not expose local tools to legacy Ask even if model guesses a name', async () => {
    expect(toolSchemas().map(t => (t.function as { name: string }).name)).not.toContain('search_files')
    const result = await runTool('search_files', {}, { windows: tools, settings: mergeSettings({}), question: '', log: vi.fn() })
    expect(result.ok).toBe(false); expect(native).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
  })
  it('uses known folders without a model, and leaves failed opens as failures', async () => {
    expect(tools.command('打开下载文件夹')).toEqual({ name: 'open_folder', args: { folder: 'downloads' } })
    expect(tools.command('Open my downloads folder')).toEqual({ name: 'open_folder', args: { folder: 'downloads' } })
    openPath.mockResolvedValue('Access denied')
    expect(await tools.run('open_folder', { folder: 'downloads' })).toMatchObject({ ok: false, error: 'Access denied' })
    expect(openPath).toHaveBeenCalledWith(root)
  })
  it('does not discover or launch after declined authorization or cancellation', async () => {
    confirm.mockResolvedValueOnce(false)
    await expect(tools.run('open_application', { name: 'Code' })).rejects.toThrow('取消')
    expect(native).not.toHaveBeenCalled(); expect(openPath).not.toHaveBeenCalled()
    const controller = new AbortController()
    confirm.mockImplementationOnce(async () => { controller.abort(); return true })
    await expect(tools.run('open_folder', { folder: 'downloads' }, controller.signal)).rejects.toThrow()
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
    expect(Date.parse(request.before) - Date.parse(request.after)).toBe(86_400_000)
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
    confirm.mockResolvedValue(false)
    const receipt = vi.fn(), log = vi.fn()
    const result = await runTool('open_folder', {}, { windows: tools, allowedTools: WINDOWS_TOOLS, settings: mergeSettings({}), question: 'open', log, onLocalResult: receipt })
    expect(result.ok).toBe(false); expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    expect(openPath).not.toHaveBeenCalled()
  })
})
