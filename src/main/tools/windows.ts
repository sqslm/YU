import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, parse } from 'node:path'
import { mt } from '@shared/mainI18n'
import type { AssistantItem } from '@shared/assistant'
import type { ToolDefinition, ToolOutcome } from './registry'

export const WINDOWS_TOOLS = ['open_application', 'open_folder', 'open_file', 'open_url', 'search_files'] as const
const documents = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.rtf', '.mp3', '.wav', '.mp4'])
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const within = (root: string, path: string): boolean => { const part = relative(root, path); return !part.startsWith('..') && !isAbsolute(part) }

export class WindowsTools {
  private items = new Map<string, AssistantItem>()
  private recent: AssistantItem[] = []
  private permitted = new Set<string>()
  constructor(private deps: {
    folders: Record<'downloads' | 'desktop' | 'documents', string>
    native: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
    confirm: (description: string, signal?: AbortSignal) => Promise<boolean>
    openPath: (path: string) => Promise<string>
    openUrl: (url: string) => Promise<void>
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
    const url = /^(?:请|帮我)?(?:打开|open )\s*(https?:\/\/\S+)$/i.exec(input)
    if (url) return { name: 'open_url', args: { url: url[1] } }
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
    if (app && !/[\\/:]|然后|再|并且|官网|网站|网页|website|webpage|homepage|official|\.(?:com|org|net)\b|and |then /i.test(app[1])) return { name: 'open_application', args: { name: app[1] } }
    return null
  }
  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    signal?.throwIfAborted()
    const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true, summary } })
    const failed = (message: string): ToolOutcome => ({ ok: false, summary: message, error: message, data: { ok: false, error: message } })
    const schema = properties[name as keyof typeof properties] as Record<string, { type: string; enum?: string[] }> | undefined
    if (!schema) return failed(mt('未知工具：{{name}}', { name }))
    for (const [key, value] of Object.entries(args)) {
      const field = Object.hasOwn(schema, key) ? schema[key] : undefined
      if (!field || typeof value !== (field.type === 'integer' ? 'number' : field.type) || (field.enum && !field.enum.includes(value as string))) return failed(mt('工具参数无效：{{name}}', { name: key }))
    }
    const approve = async (text: string): Promise<void> => {
      if (!await this.deps.confirm(text, signal)) throw new Error(mt('已取消本次系统操作'))
      signal?.throwIfAborted()
    }
    const openItem = async (item: AssistantItem): Promise<ToolOutcome> => {
      if (!item.path) return failed(mt('请先查找并选择真实结果'))
      if (item.kind === 'file' && !documents.has(extname(item.path).toLowerCase())) return failed(mt('此文件类型不支持自动打开；不会运行脚本、安装程序或未知可执行文件'))
      const current = await realpath(item.path)
      if (current.toLowerCase() !== item.path.toLowerCase()) return failed(mt('目标路径已变化，请重新查找'))
      await approve(mt('打开以下目标：\n{{path}}', { path: current }))
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
      await approve(mt('查找本机登记的应用并打开唯一匹配项：{{name}}。匹配名称和路径可能发送给配置的模型。', { name: query }))
      const response = await this.deps.native({ action: 'applications' }, signal)
      const apps = (Array.isArray(response.applications) ? response.applications : []) as { name: string; path: string }[]
      const alias = query === 'vs code' || query === 'vscode' ? 'code' : query
      const exact = apps.filter(item => item.name.toLowerCase() === alias)
      const matches = exact.length ? exact : apps.filter(item => item.name.toLowerCase().includes(alias))
      const unique = [...new Map(matches.map(item => [item.path.toLowerCase(), item])).values()].slice(0, 20)
      const found: Omit<AssistantItem, 'id'>[] = []
      for (const item of unique) if (extname(item.path).toLowerCase() === '.exe' && !/^(?:setup|install|installer|uninstall|unins\d*|update|updater)\.exe$/i.test(basename(item.path))) {
        try { found.push({ name: item.name, path: await realpath(item.path), kind: 'application' }) } catch { /* stale registration */ }
      }
      const items = this.remember(found)
      if (!items.length) return failed(mt('未找到登记的应用：{{name}}', { name: query }))
      if (items.length !== 1) return ok(mt('找到多个应用，请选择要打开的项目'), { items })
      signal?.throwIfAborted()
      const error = await this.deps.openPath(items[0].path)
      return error ? failed(error) : ok(mt('已向 Windows 提交打开请求：{{name}}', { name: items[0].name }), { path: items[0].path })
    }
    if (name === 'open_url') {
      let url: URL
      try { url = new URL(string(args.url)) } catch { return failed(mt('请输入有效的 HTTP/HTTPS 网页地址')) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return failed(mt('请输入有效的 HTTP/HTTPS 网页地址'))
      await approve(mt('在默认浏览器打开：\n{{path}}', { path: url.href }))
      await this.deps.openUrl(url.href)
      return ok(mt('已向 Windows 提交打开请求：{{name}}', { name: url.href }))
    }
    if (name !== 'open_folder' && name !== 'search_files') return failed(mt('未知工具：{{name}}', { name }))
    const input = string(args.folder) || 'downloads'
    if (!(input in this.deps.folders) && !isAbsolute(input)) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    const root = await realpath(this.deps.folders[input as keyof typeof this.deps.folders] || input)
    if (!isAbsolute(root) || root === parse(root).root || root.startsWith('\\\\') || !(await stat(root)).isDirectory()) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    if (name === 'open_folder') {
      await approve(mt('打开以下目标：\n{{path}}', { path: root }))
      const error = await this.deps.openPath(root)
      return error ? failed(error) : ok(mt('已向 Windows 提交打开请求：{{name}}', { name: root }), { path: root })
    }
    const query = string(args.name), extension = string(args.extension).replace(/^\./, '')
    if (query.length > 100 || /[%_\[\]\x00-\x1f]/.test(query) || (extension && !/^[a-z0-9]{1,12}$/i.test(extension))) return failed(mt('文件名或扩展名无效'))
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
    await approve(mt('仅查询以下目录的文件名、路径、修改时间和大小；这些元数据可能发送给配置的模型。不会读取文件内容。\n{{path}}', { path: root }))
    const result = await this.deps.native({ action: 'search', root, name: query, extension, after, before, minBytes, sort: args.sort === 'size' ? 'size' : 'modified' }, signal)
    const found: Omit<AssistantItem, 'id'>[] = []
    for (const file of (Array.isArray(result.files) ? result.files : []).slice(0, 40) as { name: string; path: string; bytes: number; modified: string }[]) {
      const path = await realpath(file.path).catch(() => '')
      if (path && within(root, path) && (await stat(path)).isFile()) found.push({ ...file, path, kind: 'file' })
    }
    signal?.throwIfAborted()
    const items = this.remember(found)
    return ok(mt('找到 {{n}} 个文件', { n: items.length }), { items, backend: result.backend,
      scope: root, partial: result.partial, indexUnavailable: result.indexUnavailable,
      coverage: mt('查询 Windows 索引并补查当前目录；未索引子目录不递归扫描。按修改时间筛选，不代表下载时间；不搜索文件正文。') })
  }
}

const properties = {
  open_application: { name: { type: 'string' }, id: { type: 'string' } },
  open_folder: { folder: { type: 'string', description: 'downloads, desktop, documents or an explicit absolute local folder' } },
  open_file: { id: { type: 'string', description: 'Exact id from search_files results. Never invent paths or ids.' } },
  open_url: { url: { type: 'string' } },
  search_files: { folder: { type: 'string' }, name: { type: 'string' }, extension: { type: 'string' }, day: { type: 'string', enum: ['today', 'yesterday'] }, after: { type: 'string', description: 'Inclusive modification instant, ISO 8601 with timezone. Prefer day for local today/yesterday.' }, before: { type: 'string', description: 'Exclusive modification instant, ISO 8601 with timezone.' }, minBytes: { type: 'integer', minimum: 0 }, sort: { type: 'string', enum: ['modified', 'size'] } }
}
export const WINDOWS_DEFINITIONS: ToolDefinition[] = WINDOWS_TOOLS.map(name => ({ name,
  description: ({ open_application: 'Find registered Windows applications by name; launch only a unique match. Multiple candidates require user choice by returned id.', open_folder: 'Open a specific local folder in Explorer.', open_file: 'Open an actual document result by id. No executables/scripts. If multiple search results, ask user to choose; never guess.', open_url: 'Open an HTTP/HTTPS URL in the default browser, after user authorization.', search_files: 'Search real file metadata in a specific local folder, using Windows Search plus immediate-directory fallback. No content search or whole-disk crawl. Date means modification date. Returns ids, paths and ordering. Use a later tool round to open a unique result.' })[name],
  parameters: { type: 'object', properties: properties[name], additionalProperties: false, required: name === 'open_file' ? ['id'] : name === 'open_url' ? ['url'] : [] },
  run: (args, ctx) => ctx.windows!.run(name, args, ctx.signal)
}))
