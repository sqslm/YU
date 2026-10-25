import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, parse } from 'node:path'
import { mt } from '@shared/mainI18n'
import type { AssistantItem } from '@shared/assistant'
import type { ToolDefinition, ToolOutcome } from './registry'
import type { PromptContext } from '@shared/prompts'
import { isCurrentWindowQuestion } from '../voice-intent'
import { FileIndex, DEFAULT_MAX_FILES, DEFAULT_TIMEOUT_MS, type ContentSearchOptions, type ContentSearchResult, type FileIndexDeps } from '../file-index'
import { searchEverything, type EverythingOptions, type EverythingResult } from '../everything'

export const WINDOWS_TOOLS = ['open_application', 'open_folder', 'open_file', 'open_url', 'search_files', 'search_file_contents', 'search_files_everything', 'get_active_window', 'get_disk_space', 'get_current_folder', 'get_current_page'] as const
const documents = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.rtf', '.mp3', '.wav', '.mp4'])
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const within = (root: string, path: string): boolean => { const part = relative(root, path); return !part.startsWith('..') && !isAbsolute(part) }

/** Only the JSON Schema keywords the model is allowed to see are honoured. */
interface FieldSchema { type: string; enum?: string[]; items?: { type: string }; maxItems?: number }

const validArgument = (field: FieldSchema, value: unknown): boolean => {
  if (field.enum && !field.enum.includes(value as string)) return false
  if (field.type === 'array') {
    if (!Array.isArray(value) || value.length > (field.maxItems ?? Number.MAX_SAFE_INTEGER)) return false
    const itemType = field.items?.type ?? 'string'
    return value.every(item => typeof item === (itemType === 'integer' ? 'number' : itemType))
  }
  return typeof value === (field.type === 'integer' ? 'number' : field.type)
}

/** Why a body scan stopped early, phrased for a card and for the model. */
const TRUNCATION_NOTE: Record<string, string> = {
  timeout: '已达到时间上限，结果不完整',
  'file-limit': '已达到扫描文件上限，结果不完整',
  'result-limit': '已达到结果上限，结果可能更多'
}

export class WindowsTools {
  private items = new Map<string, AssistantItem>()
  private recent: AssistantItem[] = []
  private permitted = new Set<string>()
  /** Lazily built so the extraction cache stays warm across tool rounds. */
  private index: FileIndex | null = null
  constructor(private deps: {
    folders: Record<'downloads' | 'desktop' | 'documents', string> | (() => Record<'downloads' | 'desktop' | 'documents', string>)
    native: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
    openPath: (path: string) => Promise<string>
    openUrl: (url: string) => Promise<void>
    /** Injected in tests so the traversal never needs a real disk. */
    fileIndex?: FileIndex
    fileSystem?: FileIndexDeps
    /** Injected in tests: replaces the whole Everything lookup. */
    everything?: (query: string, limit: number, signal?: AbortSignal) => Promise<EverythingResult>
    everythingOptions?: EverythingOptions
    /** Where a body scan looks when the model gives no roots. */
    contentRoots?: () => string[]
  }) {}

  clear(): void { this.items.clear(); this.recent = []; this.permitted.clear() }
  beginTask(): void { this.permitted = new Set(this.items.keys()) }
  operation(id: string): { name: string; args: Record<string, unknown>; title: string } {
    const item = this.items.get(id)
    if (!item) throw new Error(mt('请先查找并选择真实结果'))
    return { name: item.kind === 'application' ? 'open_application' : 'open_file', args: { id }, title: mt('打开 {{name}}', { name: item.name }) }
  }
  private remember(items: Omit<AssistantItem, 'id'>[]): AssistantItem[] {
    const list = items.map(item => ({ ...item, id: randomUUID() }))
    for (const item of list) this.items.set(item.id, item)
    while (this.items.size > 120) this.items.delete(this.items.keys().next().value!)
    this.recent = list
    if (list.length === 1) this.permitted.add(list[0].id)
    return list
  }
  /** Deliberately narrow deterministic commands: no model/network needed. */
  command(input: string): { name: string; args: Record<string, unknown> } | null {
    if (isCurrentWindowQuestion(input)) return { name: 'get_active_window', args: {} }
    // A compound request belongs to the existing tool loop, not an app-name match.
    if (/[,，;；\n]|然后|并且|同时|\b(?:and then|then|also)\b|\band (?:open|find|save|create|search|calculate)\b/iu.test(input)) return null
    const url = /^(?:请|帮我)?(?:打开|open )\s*(https?:\/\/\S+)$/i.exec(input)
    if (url) return { name: 'open_url', args: { url: url[1] } }
    const driveFolder = /^(?:请|帮我)?打开\s*([a-z])\s*盘(?:里|中|下面|下)?的?\s*(.+?)\s*(?:文件夹|目录)[。！!]?$/i.exec(input)
    if (driveFolder && !/[<>:"|?*\x00-\x1f]/.test(driveFolder[2])) return { name: 'open_folder', args: { folder: `${driveFolder[1].toUpperCase()}:\\${driveFolder[2].replace(/\//g, '\\')}` } }
    const absoluteFolder = /^(?:(?:请|帮我)?打开|open(?: the)?(?: folder)?)\s*[“"]?([a-z]:[\\/][^"”\n]*?)[”"]?\s*(?:文件夹|目录)?[。！!]?$/i.exec(input)
    if (absoluteFolder && (!extname(absoluteFolder[1]) || /文件夹|目录|\bfolder\b/i.test(input)) && !/[<>"|?*\x00-\x1f]/.test(absoluteFolder[1])) return { name: 'open_folder', args: { folder: absoluteFolder[1] } }
    const folder = /^(?:请|帮我)?打开(?:我的)?(下载(?:目录|文件夹)?|桌面|文档)(?:目录|文件夹)?[。！!]?$/i.exec(input)
      || /^open (?:my |the )?(downloads|desktop|documents)(?: folder)?[.!]?$/i.exec(input)
    if (folder) return { name: 'open_folder', args: { folder: /下载|downloads/i.test(folder[1]) ? 'downloads' : /桌面|desktop/i.test(folder[1]) ? 'desktop' : 'documents' } }
    const ordinal = /^(?:打开|open )(?:第)?(\d+|一|二|三|四|五|first|second|third)(?:个|项|个文件)?[。.!]?$/i.exec(input)
    if (ordinal) {
      const index = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, first: 1, second: 2, third: 3 } as Record<string, number>)[ordinal[1].toLowerCase()] ?? Number(ordinal[1])
      const item = this.recent[index - 1]
      return { name: item?.kind === 'application' ? 'open_application' : 'open_file', args: { id: item?.id ?? '' } }
    }
    const app = /^(?:请|帮我)?打开\s*([^。！？\n]{1,80})[。！!]?$/i.exec(input) || /^open (?:the )?([\w .+()-]{1,80})[.!]?$/i.exec(input)
    if (app && !/[\\/:]|文件夹|目录|[a-z]\s*盘|\bfolder\b|然后|再|并且|官网|网站|网页|website|webpage|homepage|official|\.(?:com|org|net)\b|and |then /i.test(app[1])) return { name: 'open_application', args: { name: app[1] } }
    return null
  }
  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: PromptContext): Promise<ToolOutcome> {
    signal?.throwIfAborted()
    const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true, summary } })
    const failed = (message: string): ToolOutcome => ({ ok: false, summary: message, error: message, data: { ok: false, error: message } })
    const schema = properties[name as keyof typeof properties] as Record<string, FieldSchema> | undefined
    if (!schema) return failed(mt('未知工具：{{name}}', { name }))
    for (const [key, value] of Object.entries(args)) {
      const field = Object.hasOwn(schema, key) ? schema[key] : undefined
      if (!field || !validArgument(field, value)) return failed(mt('工具参数无效：{{name}}', { name: key }))
    }
    const originalContext = async (action: 'explorer-folder' | 'browser-url'): Promise<Record<string, unknown>> => {
      if (!context?.windowHandle || !context.processId) throw new Error(mt('没有可用的原窗口信息，请从目标应用重新呼出助手'))
      if (action === 'explorer-folder' ? !/^explorer$/i.test(context.appName ?? '') : !/^(?:chrome|msedge|firefox|brave|vivaldi|opera|browser)$/i.test(context.appName ?? '')) throw new Error(mt('原窗口不是支持的浏览器或资源管理器'))
      return this.deps.native({ action, handle: context.windowHandle, pid: context.processId, title: context.windowTitle }, signal)
    }
    const openItem = async (item: AssistantItem): Promise<ToolOutcome> => {
      if (item.kind === 'application' && item.appId) {
        const result = await this.deps.native({ action: 'activate', appId: item.appId }, signal)
        if (result.activated !== true) return failed(mt('未找到登记的应用：{{name}}', { name: item.name }))
        return ok(mt('已向 Windows 提交打开请求：{{name}}', { name: item.name }), { appId: item.appId })
      }
      if (!item.path) return failed(mt('请先查找并选择真实结果'))
      if (item.kind === 'file' && !documents.has(extname(item.path).toLowerCase())) return failed(mt('此文件类型不支持自动打开；不会运行脚本、安装程序或未知可执行文件'))
      const current = await realpath(item.path)
      if (current.toLowerCase() !== item.path.toLowerCase()) return failed(mt('目标路径已变化，请重新查找'))
      signal?.throwIfAborted()
      const error = await this.deps.openPath(current)
      if (error) return failed(error)
      return ok(mt('已向 Windows 提交打开请求：{{name}}', { name: item.name }), { path: current })
    }
    if (name === 'open_file' || (name === 'open_application' && string(args.id))) {
      const item = this.items.get(string(args.id))
      if (!this.permitted.has(string(args.id))) return failed(mt('找到多个结果，请由用户选择后再打开'))
      if (!item || (name === 'open_file' ? item.kind !== 'file' : item.kind !== 'application')) return failed(mt('请先查找并选择真实结果'))
      return openItem(item)
    }
    if (name === 'open_application') {
      const query = string(args.name).replace(/\.exe$/i, '').toLowerCase()
      if (!query || query.length > 80 || /[\\/:\x00-\x1f]/.test(query)) return failed(mt('请输入应用名称'))
      const response = await this.deps.native({ action: 'applications' }, signal)
      const apps = (Array.isArray(response.applications) ? response.applications : []) as { name: string; path: string; appId?: string }[]
      const alias = query === 'vs code' || query === 'vscode' ? 'code' : query
      const system = /^(?:计算器|calculator)$/i.test(query) ? /Microsoft\.WindowsCalculator_|^(?:calculator|calc|计算器)$/i : /^(?:记事本|notepad)$/i.test(query) ? /Microsoft\.WindowsNotepad_|^(?:notepad|记事本)$/i : /^(?:windows\s*(?:设置|settings)|系统设置)$/i.test(query) ? /^system:settings$/ : /^(?:资源管理器|文件资源管理器|file explorer|explorer)$/i.test(query) ? /^explorer$/i : null
      const systemMatches = system ? apps.filter(item => system.test(item.appId ?? item.name)) : []
      const preferred = systemMatches.some(item => item.appId) ? systemMatches.filter(item => item.appId) : systemMatches
      const exact = preferred.length ? preferred : apps.filter(item => item.name.toLowerCase() === alias)
      const matches = exact.length ? exact : apps.filter(item => item.name.toLowerCase().includes(alias))
      const unique = [...new Map(matches.map(item => [(item.appId || item.path).toLowerCase(), item])).values()].slice(0, 20)
      const found: Omit<AssistantItem, 'id'>[] = []
      for (const item of unique) {
        if (item.appId) { found.push({ name: item.name, path: '', appId: item.appId, kind: 'application' }); continue }
        if (extname(item.path).toLowerCase() === '.exe' && !/^(?:setup|install|installer|uninstall|unins\d*|update|updater)\.exe$/i.test(basename(item.path))) {
          try { found.push({ name: item.name, path: await realpath(item.path), kind: 'application' }) } catch { /* stale registration */ }
        }
      }
      const items = this.remember(found)
      if (!items.length) return failed(mt('未找到登记的应用：{{name}}', { name: query }))
      if (items.length !== 1) return ok(mt('找到多个应用，请选择要打开的项目'), { items })
      signal?.throwIfAborted()
      return openItem(items[0])
    }
    if (name === 'get_active_window') {
      if (!context?.processId) return failed(mt('没有可用的原窗口信息，请从目标应用重新呼出助手'))
      if (/1password|keepass|bitwarden|lastpass|password/i.test(`${context.appName} ${context.appPath}`)) return failed(mt('敏感应用不允许读取上下文'))
      return ok(mt('当前窗口：{{name}}', { name: [context.appName, context.windowTitle].filter(Boolean).join(' · ') || mt('未知应用') }), { appName: context.appName, title: context.windowTitle,
        processId: context.processId, appPath: context.appPath, windowRect: context.windowRect })
    }
    if (name === 'get_disk_space') {
      const result = await this.deps.native({ action: 'disk-space' }, signal)
      return ok(mt('已读取磁盘容量'), { drives: result.drives, asOf: Date.now(), unit: 'bytes' })
    }
    if (name === 'get_current_folder') {
      const result = await originalContext('explorer-folder')
      if (!result.folder) return failed(mt('无法确定原窗口的文件夹，请提供具体路径'))
      const folder = await realpath(string(result.folder))
      return ok(mt('已读取原窗口的文件夹'), { folder })
    }
    if (name === 'get_current_page') {
      const result = await originalContext('browser-url')
      let url: URL
      try { url = new URL(string(result.url)) } catch { return failed(mt('无法读取原浏览器的网页地址，请粘贴链接')) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return failed(mt('请输入有效的 HTTP/HTTPS 网页地址'))
      return ok(mt('已读取原浏览器的网页地址'), { url: url.href, title: context?.windowTitle,
        note: mt('仅获取地址；使用网页读取工具获取公开正文，不读取浏览器登录信息。') })
    }
    if (name === 'open_url') {
      let url: URL
      try { url = new URL(string(args.url)) } catch { return failed(mt('请输入有效的 HTTP/HTTPS 网页地址')) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return failed(mt('请输入有效的 HTTP/HTTPS 网页地址'))
      signal?.throwIfAborted()
      await this.deps.openUrl(url.href)
      return ok(mt('已向 Windows 提交打开请求：{{name}}', { name: url.href }))
    }
    if (name === 'search_file_contents') {
      const query = string(args.query)
      // A body query is a phrase to look for, not a pattern: no control bytes, bounded length.
      if (!query || query.length > 120 || /[\x00-\x1f]/.test(query)) return failed(mt('请输入要搜索的正文关键词'))
      const scope = await this.contentRoots(args.roots)
      if (!('roots' in scope)) return failed(scope.error)
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit ?? 10)) || 10, 1), 20)
      const result = await this.contentSearch({ query, roots: scope.roots, limit, signal })
      signal?.throwIfAborted()
      const items = this.remember(result.hits.map(hit => ({ name: hit.name, path: hit.path, kind: 'file' as const })))
      const notes = [
        result.truncated ? TRUNCATION_NOTE[result.reason] ?? '' : '',
        result.skipped.unsupported ? mt('{{n}} 个文件类型不支持正文检索（含 PDF）', { n: result.skipped.unsupported }) : '',
        result.skipped.binary ? mt('跳过 {{n}} 个二进制文件', { n: result.skipped.binary }) : ''
      ].filter(Boolean)
      const summary = result.hits.length
        ? mt('在文件正文里找到 {{n}} 个匹配文件', { n: result.hits.length })
        : mt('没有文件正文包含「{{query}}」', { query })
      return ok(notes.length ? `${summary}；${notes.join('；')}` : summary, {
        hits: result.hits.map((hit, index) => ({ ...hit, id: items[index]?.id ?? '' })),
        items, query, scope: result.roots, scanned: result.scanned, truncated: result.truncated,
        partial: result.truncated, reason: result.reason, skipped: result.skipped,
        elapsedMs: result.elapsedMs, cache: result.cache,
        coverage: mt('按正文检索 {{roots}}，最多扫描 {{files}} 个文件、{{seconds}} 秒；不解析 PDF，不扫描整个硬盘。', {
          roots: result.roots.join('、'), files: DEFAULT_MAX_FILES, seconds: DEFAULT_TIMEOUT_MS / 1000
        })
      })
    }
    if (name === 'search_files_everything') {
      const query = string(args.query)
      if (!query || query.length > 120 || /[\x00-\x1f]/.test(query)) return failed(mt('请输入要搜索的文件名关键词'))
      const limit = Math.min(Math.max(Math.trunc(Number(args.limit ?? 20)) || 20, 1), 50)
      const found = await this.everythingSearch(query, limit, signal)
      if (!found.available) {
        // Not an error: the model is expected to retry with the built-in search,
        // and the summary has to say that out loud or it will just apologise.
        return { ok: false, summary: mt('Everything 查询接口不可用，请改用内置文件搜索'), error: found.reason,
          data: { ok: false, available: false, backend: found.backend, query, reason: found.reason, fallback: ['search_files', 'search_file_contents'] } }
      }
      const openable = found.hits.filter(hit => documents.has(extname(hit.path).toLowerCase()))
      const items = this.remember(openable.map(hit => ({ name: hit.name, path: hit.path, kind: 'file' as const })))
      const ids = new Map(items.map(item => [item.path.toLowerCase(), item.id]))
      const summary = found.hits.length
        ? mt('Everything 找到 {{n}} 个文件', { n: found.hits.length })
        : mt('Everything 里没有匹配「{{query}}」的文件', { query })
      return ok(summary, {
        hits: found.hits.map(hit => ({ ...hit, id: ids.get(hit.path.toLowerCase()) ?? '' })),
        items, query, backend: found.backend, total: found.total, partial: found.truncated,
        coverage: mt('查询 Everything 本地索引（文件名与路径，不含文件正文）；后端：{{backend}}。', { backend: found.backend === 'http' ? mt('HTTP 服务') : 'es.exe' })
      })
    }
    if (name !== 'open_folder' && name !== 'search_files') return failed(mt('未知工具：{{name}}', { name }))
    let input = string(args.folder) || 'downloads'
    if (input === 'current') {
      const result = await originalContext('explorer-folder')
      if (!result.folder) return failed(mt('无法确定原窗口的文件夹，请提供具体路径'))
      input = string(result.folder)
    }
    const folders = typeof this.deps.folders === 'function' ? this.deps.folders() : this.deps.folders
    if (!(input in folders) && !isAbsolute(input)) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    let root: string
    try { root = await realpath(folders[input as keyof typeof folders] || input) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed(mt('文件夹不存在：{{path}}', { path: input }))
      throw error
    }
    if (!isAbsolute(root) || root === parse(root).root || root.startsWith('\\\\') || !(await stat(root)).isDirectory()) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    if (name === 'open_folder') {
      signal?.throwIfAborted()
      const error = await this.deps.openPath(root)
      return error ? failed(error) : ok(mt('已向 Windows 提交打开请求：{{name}}', { name: root }), { path: root })
    }
    const query = string(args.name), extension = string(args.extension).replace(/^\./, '')
    if (query.length > 100 || /[%_\[\]\x00-\x1f]/.test(query) || (extension && !/^[a-z0-9]{1,12}$/i.test(extension))) return failed(mt('文件名或扩展名无效'))
    const types: Record<string, string[]> = { archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'], pdf: ['pdf'], document: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'], image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'] }
    const extensions = extension ? [extension] : types[string(args.type)] ?? []
    if (extension && args.type && !types[string(args.type)]?.includes(extension.toLowerCase())) return failed(mt('文件名或扩展名无效'))
    let after = string(args.after), before = string(args.before)
    if (args.day === 'today' || args.day === 'yesterday') {
      const from = new Date(); from.setHours(0, 0, 0, 0)
      if (args.day === 'yesterday') from.setDate(from.getDate() - 1)
      const end = new Date(from); end.setDate(end.getDate() + 1)
      after = from.toISOString(); before = end.toISOString()
    }
    if ([after, before].some(value => value && !Number.isFinite(Date.parse(value))) || (after && before && Date.parse(after) >= Date.parse(before))) return failed(mt('日期范围无效'))
    after = after ? new Date(after).toISOString() : ''
    before = before ? new Date(before).toISOString() : ''
    const minBytes = args.minBytes ?? 0
    if (typeof minBytes !== 'number' || !Number.isSafeInteger(minBytes) || minBytes < 0) return failed(mt('文件大小无效'))
    const result = await this.deps.native({ action: 'search', root, name: query, extension, extensions, recursive: args.recursive === true, after, before, minBytes, sort: args.sort === 'size' ? 'size' : 'modified' }, signal)
    const found: Omit<AssistantItem, 'id'>[] = []
    for (const file of (Array.isArray(result.files) ? result.files : []).slice(0, 40) as { name: string; path: string; bytes: number; modified: string }[]) {
      const path = await realpath(file.path).catch(() => '')
      if (path && within(root, path) && (await stat(path)).isFile()) found.push({ ...file, path, kind: 'file' })
    }
    signal?.throwIfAborted()
    const items = this.remember(found)
    return ok(mt('找到 {{n}} 个文件', { n: items.length }), { items, backend: result.backend,
      scope: root, partial: result.partial, indexUnavailable: result.indexUnavailable,
      coverage: args.recursive === true ? mt('查询 Windows 索引并补查最多 3 层子目录、5000 个条目、5 秒；不跟随目录链接。按修改时间筛选，不代表下载时间；不搜索文件正文。') : mt('查询 Windows 索引并补查当前目录；未索引子目录不递归扫描。按修改时间筛选，不代表下载时间；不搜索文件正文。') })
  }

  /**
   * Local folders only, for the same reason search_files refuses whole disks:
   * a body scan runs on a hard time budget and a network share would blow it.
   * Explicit roots are strict — scanning nothing and returning no hits would
   * read as "no file contains this", which is a different and worse answer.
   */
  private async contentRoots(input: unknown): Promise<{ roots: string[] } | { error: string }> {
    const invalid = mt('请选择本地的具体文件夹，不支持全盘或网络目录')
    const folders = typeof this.deps.folders === 'function' ? this.deps.folders() : this.deps.folders
    const requested = (Array.isArray(input) ? input : typeof input === 'string' ? [input] : []).map(string).filter(Boolean).slice(0, 4)
    const explicit = requested.length > 0
    const candidates = explicit ? requested : this.deps.contentRoots ? this.deps.contentRoots() : [folders.documents, folders.desktop, folders.downloads].filter(Boolean)
    const roots: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const plausible = isAbsolute(candidate) && !candidate.startsWith('\\\\')
      const real = plausible ? await realpath(candidate).catch(() => '') : ''
      const info = real ? await stat(real).catch(() => null) : null
      if (!real || !info?.isDirectory() || real === parse(real).root) {
        if (explicit) return { error: invalid }
        continue
      }
      // The three default folders often resolve to the same place (or nest), and
      // paying for the same tree twice would spend the file budget twice.
      if (seen.has(real.toLowerCase())) continue
      seen.add(real.toLowerCase())
      roots.push(real)
    }
    if (roots.length) return { roots }
    return { error: explicit ? invalid : mt('没有可检索的文档目录，请指定要搜索的文件夹') }
  }
  private async contentSearch(options: ContentSearchOptions): Promise<ContentSearchResult> {
    if (this.deps.fileIndex) return this.deps.fileIndex.search(options)
    this.index ??= new FileIndex(this.deps.fileSystem)
    return this.index.search(options)
  }
  private async everythingSearch(query: string, limit: number, signal?: AbortSignal): Promise<EverythingResult> {
    if (this.deps.everything) return this.deps.everything(query, limit, signal)
    return searchEverything(query, { ...this.deps.everythingOptions, limit, signal })
  }
}

const properties = {
  get_current_folder: {},
  get_current_page: {},
  get_active_window: {},
  get_disk_space: {},
  open_application: { name: { type: 'string' }, id: { type: 'string' } },
  open_folder: { folder: { type: 'string', description: 'downloads, desktop, documents or an explicit absolute local folder' } },
  open_file: { id: { type: 'string', description: 'Exact id from search_files results. Never invent paths or ids.' } },
  open_url: { url: { type: 'string' } },
  search_files: { folder: { type: 'string' }, name: { type: 'string' }, extension: { type: 'string' }, type: { type: 'string', enum: ['archive', 'pdf', 'document', 'image', 'audio'] }, recursive: { type: 'boolean', description: 'Only if user requests subfolders; bounded to depth 3 / 5000 entries / 5 seconds without following junctions.' }, day: { type: 'string', enum: ['today', 'yesterday'] }, after: { type: 'string', description: 'Inclusive modification instant, ISO 8601 with timezone. Prefer day for local today/yesterday.' }, before: { type: 'string', description: 'Exclusive modification instant, ISO 8601 with timezone.' }, minBytes: { type: 'integer', minimum: 0 }, sort: { type: 'string', enum: ['modified', 'size'] } },
  search_file_contents: { query: { type: 'string', description: 'Literal words to find inside file bodies (max 6 terms). Not a regular expression.' }, roots: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Absolute local folders; omit for Documents, Desktop and Downloads.' }, limit: { type: 'integer', description: 'How many matches to keep, 1-20; larger values are clamped.' } },
  search_files_everything: { query: { type: 'string', description: 'File name or path fragment. Everything matches names and paths, never file bodies.' }, limit: { type: 'integer', description: 'How many matches to keep, 1-50; larger values are clamped.' } }
}
export const WINDOWS_DEFINITIONS: ToolDefinition[] = WINDOWS_TOOLS.map(name => ({ name,
  description: ({ get_current_folder: 'Get the real original Explorer folder through Shell by the frozen window handle. Fails on unavailable or ambiguous tabs; never infer a path from the title.', get_current_page: 'Read the original browser address through native accessibility. Then use read_webpage for public content. No cookies or access to logged-in page content; ask for a link when unavailable.', get_active_window: 'Get the original foreground application snapshot captured when this task started. Does not inspect a newly focused window or read its document content.', get_disk_space: 'Read actual ready local disk total/free/used bytes through Windows. No guessed capacity values.', open_application: 'Find registered Windows desktop and Start Apps applications by name; launch a unique match directly without another confirmation. Multiple candidates require user choice by returned id.', open_folder: 'Open a requested specific local folder in Explorer directly, without another confirmation.', open_file: 'Open a requested actual document result by id directly, without another confirmation. No executables/scripts. If multiple search results, ask user to choose; never guess.', open_url: 'Open a requested HTTP/HTTPS URL directly in the default browser, without another confirmation.', search_files: 'Search real file metadata in a specific local folder, using Windows Search plus bounded folder fallback. downloads uses the saved custom folder or the Windows known folder; folder=current resolves the original Explorer window. Use type=archive for ZIP/RAR/7Z etc; recursive=true only if requested. No content search or whole-disk crawl. Date means modification date. Returns ids, paths and ordering. Use a later tool round to open a unique result.', search_file_contents: 'Find which documents actually contain given words, by reading body text: plain text plus .docx/.xlsx/.pptx (unzipped in-process). PDF bodies are NOT readable, so never claim a PDF matched. Default scope is Documents, Desktop, Downloads; bounded by file count, file size and a total time budget, and may set truncated=true. Returns matches with a snippet, newest first. Best for "which document mentioned X".', search_files_everything: 'Look a file name or path fragment up in the Everything (voidtools) index — instant, whole-disk, names and paths only, never file bodies. Prefer it over search_files/recursive for "where is the file called X". When it reports available=false the machine has no usable Everything: say so and fall back to search_files or search_file_contents in the next round.' })[name],
  parameters: { type: 'object', properties: properties[name], additionalProperties: false, required: ({ open_file: ['id'], open_url: ['url'], search_file_contents: ['query'], search_files_everything: ['query'] } as Record<string, string[]>)[name] ?? [] },
  run: (args, ctx) => ctx.windows!.run(name, args, ctx.signal, ctx.taskContext)
}))
