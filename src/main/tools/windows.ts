import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, parse } from 'node:path'
import os from 'node:os'
import { assistantAppExcluded, assistantPathAllowed, DEFAULT_ASSISTANT_ACCESS, type AssistantAccessSettings } from '@shared/assistantAccess'
import { mt } from '@shared/mainI18n'
import type { AssistantItem } from '@shared/assistant'
import type { ToolDefinition, ToolOutcome } from './registry'
import type { PromptContext } from '@shared/prompts'
import { isCurrentContentRequest, isCurrentWindowQuestion } from '../voice-intent'
import { contentExcerpt, CURRENT_CONTENT_CHARS, readDocument, readDocumentBytes } from '../document-reader'
import { readWebpage } from './read-webpage'
import { FileIndex, DEFAULT_MAX_FILES, DEFAULT_TIMEOUT_MS, type ContentSearchOptions, type ContentSearchResult, type FileIndexDeps } from '../file-index'
import { searchEverything, type EverythingOptions, type EverythingResult } from '../everything'
import { browserDownloads } from '../file-activity'
import { resolveSpokenFolder } from '../folder-resolution'
import { argumentError } from './schema'

export const WINDOWS_TOOLS = ['open_application', 'open_folder', 'open_file', 'open_url', 'search_files', 'search_file_contents', 'search_files_everything', 'get_active_window', 'get_disk_space', 'get_current_folder', 'get_current_page', 'read_current_content', 'get_system_info', 'get_system_volume', 'set_system_volume', 'search_file_activity'] as const
const documents = new Set(['.pdf', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.rtf', '.mp3', '.wav', '.mp4'])
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const within = (root: string, path: string): boolean => { const part = relative(root, path); return !part.startsWith('..') && !isAbsolute(part) }

/** Browsers commonly hide the scheme in the address bar's accessibility value. */
export function browserAddress(raw: unknown): string {
  const value = string(raw).replace(/[\u200e\u200f\u202a-\u202e]/g, '')
  if (/\s|[\x00-\x1f]/u.test(value)) return ''
  const candidate = /^https?:\/\//i.test(value) ? value : /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#]|$)/u.test(value) ? `https://${value}` : ''
  try {
    const url = new URL(candidate)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.href.length <= 8192 ? url.href : ''
  } catch { return '' }
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
    access?: () => AssistantAccessSettings
  }) {}

  private async pathAllowed(path:string):Promise<boolean> {
    const access=this.deps.access?.()??DEFAULT_ASSISTANT_ACCESS
    const excludedPaths=await Promise.all(access.excludedPaths.map(path=>realpath(path).catch(()=>path)))
    const allowedRoots=await Promise.all(access.allowedRoots.map(path=>realpath(path).catch(()=>path)))
    return assistantPathAllowed(path,{...access,excludedPaths,allowedRoots})
  }

  clear(): void { this.items.clear(); this.recent = []; this.permitted.clear() }
  beginTask(): void { this.permitted = new Set(this.items.keys()) }
  /** A saved typed result reference is an explicit selection, not a guessed ID. */
  permitWorkflowFile(id: string): void {
    if (this.items.get(id)?.kind === 'file') this.permitted.add(id)
  }
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
    const downloads=/^(?:请|帮我)?(?:查看|查询|列出|查我)?我?(今天|昨天)(?:下载了(?:哪些|什么)|下载的)文件[？?。！!]?$/u.exec(input)
    if(downloads)return {name:'search_file_activity',args:{kind:'downloads',day:downloads[1]==='今天'?'today':'yesterday'}}
    if(/^(?:请|帮我)?(?:查看|查询|列出|查我)?我?最近(?:打开|使用)(?:过的|过|的)?(?:哪些|什么)?文件[？?。！!]?$/u.test(input))return {name:'search_file_activity',args:{kind:'recent'}}
    if(/^(?:请|帮我)?(?:查(?:看|询)?|看看|告诉我)?(?:一下)?(?:我的|这台|本机|电脑|系统).{0,15}(?:CPU|处理器|内存).{0,12}[？?。!！]?$/iu.test(input)||/^内存(?:还有|剩余)多少[？?。!！]?$/u.test(input))return {name:'get_system_info',args:{}}
    const volume=/^(?:请|帮我)?(?:把|将)?(?:系统|电脑)(?:的)?音量(?:调到|调整到|设为|设置为|改成)\s*(\d{1,3})\s*(?:%|％)?[。！!]?$/u.exec(input)
    if(volume)return {name:'set_system_volume',args:{volume:Number(volume[1])}}
    if(/^(?:请|帮我)?(?:把|将)?(?:系统|电脑)(?:设为|设置为)?(?:取消静音|静音)[。！!]?$/u.test(input))return {name:'set_system_volume',args:{muted:!input.includes('取消')}}
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
    if (app && !/[\\/:]|文件夹|目录|随记|笔记|历史|提醒|待办|日程|日历|简报|[a-z]\s*盘|\bfolder\b|然后|再|并且|官网|网站|网页|website|webpage|homepage|official|\.(?:com|org|net)\b|and |then /i.test(app[1])) return { name: 'open_application', args: { name: app[1] } }
    return null
  }
  async run(name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: PromptContext, options?: { fetchImpl?: typeof fetch; allowNetwork: boolean }): Promise<ToolOutcome> {
    signal?.throwIfAborted()
    const ok = (summary: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, summary, data: { ...data, ok: true, summary } })
    const failed = (message: string): ToolOutcome => ({ ok: false, summary: message, error: message, data: { ok: false, error: message } })
    const schema = WINDOWS_DEFINITIONS.find(tool => tool.name === name)?.parameters
    const access=this.deps.access?.()??DEFAULT_ASSISTANT_ACCESS
    if(access.disabledTools.includes(name))return failed(mt('此工具已在权限设置中关闭：{{name}}',{name}))
    if(['get_active_window','get_current_folder','get_current_page','read_current_content'].includes(name) && assistantAppExcluded(context?.appName,context?.appPath,access))return failed(mt('此应用已排除上下文读取'))
    if (!schema) return failed(mt('未知工具：{{name}}', { name }))
    const invalid = argumentError(schema, args)
    if (invalid) return failed(mt('工具参数无效：{{name}}', { name: invalid }))
    if (name === 'get_system_info') {
      const cpus = os.cpus(), total = os.totalmem(), free = os.freemem()
      return ok(mt('CPU：{{cpu}}；内存 {{total}} GiB，可用 {{free}} GiB', { cpu: cpus[0]?.model || 'Unknown', total: (total/1024**3).toFixed(1), free: (free/1024**3).toFixed(1) }),
        { cpu: cpus[0]?.model ?? '', logicalProcessors: cpus.length, totalMemoryBytes: total, freeMemoryBytes: free, platform: os.platform(), arch: os.arch() })
    }
    if(name==='search_file_activity'){
      const query=string(args.query),kind=args.kind
      if(kind!=='downloads'&&kind!=='recent')return failed(mt('工具参数无效：{{name}}',{name:'kind'}))
      const downloads=kind==='downloads'?await browserDownloads(query,path=>this.pathAllowed(path)):null
      const recent=kind==='recent'?await this.deps.native({action:'recent-files'},signal):null
      const raw: Array<Record<string,unknown>>=downloads?downloads.records.map(row=>({...row})):(Array.isArray(recent?.files)?recent.files:[]) as Array<Record<string,unknown>>
      const rows:Array<Record<string,unknown>>=[]
      const now=new Date(),from=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(args.day==='yesterday'?1:0)),until=new Date(from);until.setDate(until.getDate()+1)
      for(const entry of raw){
        signal?.throwIfAborted()
        const path=await realpath(string(entry.path)).catch(()=>'')
        if(!path||!path.toLowerCase().includes(query.toLowerCase())||!await this.pathAllowed(path))continue
        const info=await stat(path).catch(()=>null)
        if(!info?.isFile())continue
        const at=Date.parse(String(entry.downloadedAt??entry.recordedAt))
        if(args.day && (!Number.isFinite(at)||at<+from||at>=+until))continue
        rows.push({...entry,path,name:basename(path),exists:true})
        if(rows.length>=30)break
      }
      if(downloads&&!downloads.sources.length)return failed(mt('无法读取浏览器下载记录，可能未安装、被占用或被权限规则排除；没有使用文件修改时间代替下载时间'))
      const items=this.remember(rows.filter(row=>documents.has(extname(String(row.path)).toLowerCase())).map(row=>({path:String(row.path),name:String(row.name),kind:'file' as const})))
      return ok(mt('查到 {{n}} 条真实文件活动记录',{n:rows.length}),{records:rows,items,sources:downloads?.sources??['Windows Recent'],unavailable:downloads?.unavailable??[],partial:rows.length>=30||Boolean(downloads?.unavailable.length),coverage:mt(kind==='downloads'?'读取 Chrome/Edge 下载数据库中的真实开始时间与来源；不读取浏览记录，不以文件修改时间推算。':'读取 Windows 最近项目快捷方式及登记时间；未登记的应用操作不在覆盖范围，时间不是文件修改时间。')})
    }
    if (name === 'get_system_volume' || name === 'set_system_volume') {
      if (name === 'set_system_volume' && (args.volume === undefined && args.muted === undefined || args.volume !== undefined && (!Number.isInteger(args.volume) || Number(args.volume)<0 || Number(args.volume)>100))) return failed(mt('请提供 0–100 的音量或静音状态'))
      const result = await this.deps.native({ action: 'system-volume', ...(name === 'set_system_volume' ? args : {}) }, signal)
      if (typeof result.volume !== 'number' || typeof result.muted !== 'boolean') return failed(mt('无法读取默认音频设备'))
      return ok(mt('系统音量 {{volume}}%，{{state}}', { volume: result.volume, state: mt(result.muted ? '已静音' : '未静音') }), result)
    }
    const restrictedFiles = access.allowedRoots.length > 0 || access.excludedPaths.length > 0
    const originalContext = async (action: 'explorer-folder' | 'browser-url' | 'current-content', readText = false, expectedPath?: string): Promise<Record<string, unknown>> => {
      if (!context?.windowHandle || !context.processId) throw new Error(mt('没有可用的原窗口信息，请从目标应用重新呼出助手'))
      if (action === 'explorer-folder' && !/^explorer$/i.test(context.appName ?? '')) throw new Error(mt('原窗口不是资源管理器'))
      if (/1password|keepass|bitwarden|lastpass|password/i.test(`${context.appName} ${context.appPath}`)) throw new Error(mt('敏感应用不允许读取上下文'))
      return this.deps.native({ action, handle: context.windowHandle, pid: context.processId, title: context.windowTitle,
        ...(action === 'current-content' && restrictedFiles && !readText ? { metadataOnly: true } : {}), ...(expectedPath ? { expectedPath } : {}) }, signal)
    }
    if (name === 'read_current_content') {
      let current = await originalContext('current-content')
      let path = string(current.path), url = browserAddress(current.url)
      const title = string(current.title) || context?.windowTitle || ''
      if (path) {
        path = await realpath(path)
        if (!await this.pathAllowed(path)) return failed(mt('此目录不在允许的文件范围内'))
        if (restrictedFiles && current.editor === true) {
          current = await originalContext('current-content', true, string(current.path))
          if (await realpath(string(current.path)) !== path) return failed(mt('目标路径已变化，请重新查找'))
        }
        const ext = extname(path).toLowerCase()
        if (['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff'].includes(ext)) {
          const bytes = await readDocumentBytes(path, 6 * 1024 * 1024, signal)
          const ocr = await this.deps.native({ action: 'ocr', png: bytes.toString('base64') }, signal)
          if (!string(ocr.text)) return failed(mt('图片中未识别到文字；图像内容分析请使用截图分析'))
          const body = contentExcerpt(string(ocr.text))
          return ok(mt('已读取当前图片文字：{{name}}', { name: basename(path) }), { path, title: basename(path), ...body, coverage: mt('Windows 本地 OCR 文字；不包含图像语义或其他页') })
        }
        const editorText = ext !== '.pdf' && string(current.text)
        const body = editorText ? contentExcerpt(editorText) : await readDocument(path, signal)
        signal?.throwIfAborted()
        return ok(mt('已读取当前文件：{{name}}', { name: basename(path) }), { path, title: basename(path), ...body, truncated: body.truncated || Boolean(editorText && current.truncated === true), coverage: mt(editorText ? '当前编辑器正文（含未保存修改）' : '已保存文件正文') })
      }
      if (url) {
        const parsed = new URL(url)
        // Prefer the actual rendered document: works with authenticated pages and
        // JS articles without exporting cookies or browser profiles.
        let body = contentExcerpt(string(current.text))
        let partial = current.truncated === true
        let coverage = mt('浏览器通过辅助功能提供的当前页面正文')
        let pageTitle = title, pageError = ''
        if (options?.allowNetwork !== false && (!body.text || partial)) {
          const page = await readWebpage(url, { signal, fetchImpl: options?.fetchImpl, maxChars: CURRENT_CONTENT_CHARS, maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, mainContent: true })
          const originalUrl = new URL(url); originalUrl.hash = ''
          const publicUrl = new URL(page.url || url); publicUrl.hash = ''
          // A logged-out redirect or shorter teaser must not replace actual
          // rendered content. GitHub's focused README can be shorter than its UI.
          const improvesBody = !body.text || publicUrl.href === originalUrl.href && ((page.text?.length ?? 0) >= body.text.length || parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+/.test(parsed.pathname))
          if (page.ok && page.text?.trim() && improvesBody) { body = { text: page.text, truncated: page.truncated === true }; partial = false; pageTitle = page.title || title; coverage = mt('当前地址的公开网页正文'); url = page.url ?? url }
          else pageError = page.error ?? ''
        }
        if (!body.text) {
          const failure = failed(mt('已获取链接 {{url}}；无法读取当前网页正文：{{reason}}', { url, reason: pageError || mt(options?.allowNetwork === false ? '本次请求禁止联网，浏览器未提供正文' : '浏览器未提供可读文本') }))
          failure.data.url = url
          return failure
        }
        const result = ok(mt('已读取当前网页：{{name}}', { name: pageTitle || url }), { url, title: pageTitle, ...body, truncated: body.truncated || partial, coverage })
        result.sources = [{ title: pageTitle || url, url, snippet: body.text.slice(0, 160) }]
        return result
      }
      if (restrictedFiles && (current.document || current.editor)) return failed(mt('无法确定当前文档路径，不能验证文件访问范围；请保存文件并重试'))
      if (string(current.text)) {
        // A restricted file scope cannot be enforced for an unidentified editor file.
        if (access.allowedRoots.length || access.excludedPaths.length) return failed(mt('无法确定当前文档路径，不能验证文件访问范围；请保存文件并重试'))
        const body = contentExcerpt(string(current.text))
        return ok(mt('已读取当前文档文本'), { title, ...body, truncated: body.truncated || current.truncated === true, coverage: mt('当前应用通过辅助功能提供的文档文本；未提供完整文件路径') })
      }
      return failed(mt('当前窗口没有提供可读网页或文档；请切到目标标签页/文件，或在资源管理器中仅选中一个文件后重新呼出助手'))
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
      if(!await this.pathAllowed(current))return failed(mt('此目录不在允许的文件范围内'))
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
      if (items.length !== 1) return ok(mt('找到多个应用，请选择要打开的项目'), { items, needsConfirmation: true })
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
      if(!await this.pathAllowed(folder))return failed(mt('此目录不在允许的文件范围内'))
      return ok(mt('已读取原窗口的文件夹'), { folder })
    }
    if (name === 'get_current_page') {
      const result = await originalContext('browser-url')
      let url: URL
      try { url = new URL(browserAddress(result.url)) } catch { return failed(mt('无法读取原浏览器的网页地址，请粘贴链接')) }
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
      const result = await this.contentSearch({ query, roots: scope.roots, limit, signal, pathAllowed:path=>this.pathAllowed(path) })
      signal?.throwIfAborted()
      const items = this.remember(result.hits.map(hit => ({ name: hit.name, path: hit.path, kind: 'file' as const })))
      const notes = [
        result.truncated ? TRUNCATION_NOTE[result.reason] ?? '' : '',
        result.skipped.unsupported ? mt('{{n}} 个文件类型不支持正文检索', { n: result.skipped.unsupported }) : '',
        result.skipped.unreadable ? mt('{{n}} 个文件未能读取（可能加密、损坏或超时）', { n: result.skipped.unreadable }) : '',
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
        coverage: mt('按正文检索 {{roots}}，最多扫描 {{files}} 个文件、{{seconds}} 秒；支持文本型 PDF，不扫描整个硬盘。', {
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
      const visible = [] as typeof found.hits
      for(const hit of found.hits){const real=await realpath(hit.path).catch(()=>hit.path);if(await this.pathAllowed(real))visible.push({...hit,path:real})}
      found.hits=visible
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
      const result = context?.task?.directory ? { folder: context.task.directory } : await originalContext('explorer-folder')
      if (!result.folder) return failed(mt('无法确定原窗口的文件夹，请提供具体路径'))
      input = string(result.folder)
    }
    const folders = typeof this.deps.folders === 'function' ? this.deps.folders() : this.deps.folders
    if (!(input in folders) && !isAbsolute(input)) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    let root: string
    let corrected=false
    try {
      const resolved=await resolveSpokenFolder(folders[input as keyof typeof folders] || input)
      if(!resolved.path){
        const candidates=[] as string[]
        for(const path of resolved.candidates??[])if(await this.pathAllowed(path))candidates.push(path)
        return candidates.length?failed(mt('有多个相近文件夹，请明确名称：{{names}}',{names:candidates.join('、')})):failed(mt('文件夹不存在：{{path}}',{path:input}))
      }
      root=resolved.path;corrected=resolved.corrected
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed(mt('文件夹不存在：{{path}}', { path: input }))
      throw error
    }
    if (!isAbsolute(root) || root === parse(root).root || root.startsWith('\\\\') || !(await stat(root)).isDirectory()) return failed(mt('请选择本地的具体文件夹，不支持全盘或网络目录'))
    if(!await this.pathAllowed(root))return failed(mt('此目录不在允许的文件范围内'))
    if (name === 'open_folder') {
      signal?.throwIfAborted()
      const error = await this.deps.openPath(root)
      return error ? failed(error) : ok(mt('已向 Windows 提交打开请求：{{name}}', { name: root }), { path: root, ...(corrected?{matchedFrom:input,matchedActual:root}:{}) })
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
      if (path && within(root, path) && await this.pathAllowed(path) && (await stat(path)).isFile()) found.push({ ...file, path, kind: 'file' })
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
    const allowed=this.deps.access?.().allowedRoots
    const candidates = explicit ? requested : this.deps.contentRoots ? this.deps.contentRoots() : allowed?.length ? allowed : [folders.documents, folders.desktop, folders.downloads].filter(Boolean)
    const roots: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const plausible = isAbsolute(candidate) && !candidate.startsWith('\\\\')
      const real = plausible ? await realpath(candidate).catch(() => '') : ''
      const info = real ? await stat(real).catch(() => null) : null
      if (real && !await this.pathAllowed(real)) { if(explicit)return {error:mt('此目录不在允许的文件范围内')};continue }
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
    const access=this.deps.access?.()
    return searchEverything(query, { ...this.deps.everythingOptions, ...(access?{port:access.everythingPort,http:access.everythingHttp,cliPath:access.everythingCli}:{}), limit, signal })
  }
}

const properties = {
  search_file_activity:{kind:{type:'string',enum:['downloads','recent']},query:{type:'string'},day:{type:'string',enum:['today','yesterday']}},
  get_system_info: {},
  get_system_volume: {},
  set_system_volume: { volume: { type: 'integer', description: 'Explicit system master volume 0-100' }, muted: { type: 'boolean' } },
  get_current_folder: {},
  get_current_page: {},
  read_current_content: {},
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
  description: ({ read_current_content: 'Read the actual original browser page or current/selected document for an explicit summary/explanation request. Resolves the frozen window via accessibility, Office or Explorer; returns body text, path/URL and truncation. Never guesses from titles. Read-only; no search or clipboard required.', search_file_activity: 'Search actual Chrome/Edge download records (kind=downloads) or Windows Recent shortcut registration records (kind=recent), optionally today/yesterday. Returns actual provenance/time, not file modification time. Missing/locked sources are reported explicitly.', get_system_info: 'Read actual CPU model, logical processors and total/free system memory. Never guess hardware.', get_system_volume: 'Read the default Windows output device master volume and mute state.', set_system_volume: 'Set master system volume 0-100 or mute/unmute only when explicitly requested, then read back actual state. This changes system output, not TTS-only volume.', get_current_folder: 'Get the real original Explorer folder through Shell by the frozen window handle. Fails on unavailable or ambiguous tabs; never infer a path from the title.', get_current_page: 'Read the original browser address through native accessibility. Then use read_webpage for public content. No cookies or access to logged-in page content; ask for a link when unavailable.', get_active_window: 'Get the original foreground application snapshot captured when this task started. Does not inspect a newly focused window or read its document content.', get_disk_space: 'Read actual ready local disk total/free/used bytes through Windows. No guessed capacity values.', open_application: 'Find registered Windows desktop and Start Apps applications by name; launch a unique match directly without another confirmation. Multiple candidates require user choice by returned id.', open_folder: 'Open a requested specific local folder in Explorer directly, without another confirmation.', open_file: 'Open a requested actual document result by id directly, without another confirmation. No executables/scripts. If multiple search results, ask user to choose; never guess.', open_url: 'Open a requested HTTP/HTTPS URL directly in the default browser, without another confirmation.', search_files: 'Search real file metadata in a specific local folder, using Windows Search plus bounded folder fallback. downloads uses the saved custom folder or the Windows known folder; folder=current resolves the original Explorer window. Use type=archive for ZIP/RAR/7Z etc; recursive=true only if requested. No content search or whole-disk crawl. Date means modification date. Returns ids, paths and ordering. Use a later tool round to open a unique result.', search_file_contents: 'Find which documents actually contain given words, by reading body text: plain text plus .docx/.xlsx/.pptx (unzipped in-process). Text-based PDF bodies are parsed in a bounded worker; scanned/encrypted/damaged PDFs may be unreadable and are reported. Default scope is Documents, Desktop, Downloads; bounded by file count, file size and a total time budget, and may set truncated=true. Returns matches with a snippet, newest first. Best for "which document mentioned X".', search_files_everything: 'Look a file name or path fragment up in the Everything (voidtools) index — instant, whole-disk, names and paths only, never file bodies. Prefer it over search_files/recursive for "where is the file called X". When it reports available=false the machine has no usable Everything: say so and fall back to search_files or search_file_contents in the next round.' })[name],
  parameters: { type: 'object', properties: properties[name], additionalProperties: false, required: ({ search_file_activity: ['kind'], open_file: ['id'], open_url: ['url'], search_file_contents: ['query'], search_files_everything: ['query'] } as Record<string, string[]>)[name] ?? [] },
  run: (args, ctx) => {
    if (name === 'read_current_content') {
      if (!isCurrentContentRequest(ctx.question)) throw new Error(mt('本次请求未要求读取当前网页或文档'))
      return ctx.windows!.run(name, args, ctx.signal, ctx.taskContext, { fetchImpl: ctx.fetchImpl, allowNetwork: !/不要联网|不用联网|无需联网|do not (?:browse|access the internet)|don.t browse|offline/iu.test(ctx.question) })
    }
    if (name === 'set_system_volume' && !ctx.workflowReplay && !/音量|静音|声音|\b(?:volume|mute|unmute)\b/iu.test(ctx.question)) throw new Error(mt('本次请求未授权修改系统音量'))
    return ctx.windows!.run(name, args, ctx.signal, ctx.taskContext)
  }
}))
