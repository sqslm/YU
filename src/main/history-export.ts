import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { HistoryEntry, NoteExportFormat } from '@shared/types'
import type { HistoryStore } from './history'
import { isSafeLink } from '@shared/links'
import { mt } from '@shared/mainI18n'

function stamp(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Export content, without local audio paths, provider credentials or sync bookkeeping. */
export function formatHistoryExport(entries: readonly HistoryEntry[], format: NoteExportFormat): string {
  const md = format === 'markdown'
  const heading = (level: number, text: string): string => md ? `${'#'.repeat(level)} ${text}` : text
  const literal = (text: string): string => {
    const line = text.replace(/[\r\n]+/g, ' ')
    return md ? line.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&') : line
  }
  const modes = { dictation: '听写', ask: '问答', translate: '翻译' }
  const sections = entries.map(entry => {
    const metadata = [
      `${mt('模式')}：${mt(modes[entry.mode])}`,
      ...(entry.app ? [`${mt('应用')}：${literal(entry.app)}`] : []),
      ...(entry.promptName ? [`${mt('卡片')}：${literal(entry.promptName)}`] : []),
      `${mt('录音时长')}：${mt('{{n}} 秒', { n: Math.round(entry.durationMs / 1000) })}`
    ].map(line => md ? `- ${line}` : line).join('\n')
    const sources = (entry.sources ?? []).flatMap((source, index) => isSafeLink(source.url)
      ? [`${index + 1}. ${literal(source.title)} — ${literal(source.url)}`] : [])
    return [
      heading(2, stamp(entry.createdAt)), metadata,
      heading(3, mt('原始转写')), entry.transcript || mt('（无内容）'),
      heading(3, mt('识别结果')), entry.final,
      ...(sources.length ? [heading(3, mt('来源')), sources.join('\n')] : [])
    ].join('\n\n')
  })
  return `${heading(1, mt('历史记录导出'))}\n\n${sections.join('\n\n---\n\n')}\n`
}

/** Explicit IDs preserve the renderer's current filters and order, across every visible page. */
export async function exportHistory(store: Pick<HistoryStore, 'get'>, ids: string[], format: NoteExportFormat): Promise<{ path: string; count: number } | null> {
  if (format !== 'markdown' && format !== 'text') throw new Error(mt('不支持的导出格式'))
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error(mt('请选择要导出的历史记录'))
  const entries = [...new Set(ids)].map(id => {
    const entry = store.get(id)
    if (!entry) throw new Error(mt('部分记录已不存在，请刷新后重试'))
    return entry
  }).filter(entry => !entry.error?.trim() && entry.final.trim() && (!entry.status || entry.status === 'completed' || entry.status === 'archived'))
  if (!entries.length) throw new Error(mt('当前筛选没有可导出的正常记录'))
  const extension = format === 'markdown' ? 'md' : 'txt'
  const selected = await dialog.showSaveDialog({
    title: mt('导出历史记录'),
    defaultPath: `${mt('历史记录')}-${stamp(Date.now()).replace(/[ :]/g, '-')}.${extension}`,
    filters: [{ name: format === 'markdown' ? 'Markdown' : mt('纯文本'), extensions: [extension] }]
  })
  if (selected.canceled || !selected.filePath) return null
  await writeFile(selected.filePath, formatHistoryExport(entries, format), 'utf8')
  return { path: selected.filePath, count: entries.length }
}
