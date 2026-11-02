import { describe, expect, it } from 'vitest'
import type { QuotaConnection } from '@shared/quota'
import { filterQuotaConnections, type QuotaKindFilter } from './quotaFilter'

const labels: Record<string, string> = { llm: 'LLM', multimodal: '多模态', asr: 'ASR', tts: 'TTS', 'local-asr': '本地 ASR' }
const kindLabel = (kind: QuotaConnection['kind']): string => labels[kind] ?? kind
const nameOf = (row: QuotaConnection): string => row.name

const rows: QuotaConnection[] = [
  { kind: 'llm', id: 'a', name: 'DeepSeek 深度求索', model: 'deepseek-chat', enabled: true },
  { kind: 'llm', id: 'b', name: 'huyang', model: 'claude-v4-flash', enabled: true },
  { kind: 'multimodal', id: 'c', name: 'gemini-3.8-flash-low', model: 'gemini-3.8', enabled: true },
  { kind: 'asr', id: 'd', name: '豆包免费ASR', model: 'bigmodel', enabled: false },
  { kind: 'asr', id: 'e', name: 'llama.cpp', model: 'qwen3', enabled: false },
  { kind: 'tts', id: 'f', name: '系统声音', model: '', enabled: true },
  { kind: 'local-asr', id: 'g', name: '本地 ASR', model: 'sensevoice', enabled: true }
]
const view = (query = '', kind: QuotaKindFilter = 'all'): ReturnType<typeof filterQuotaConnections> => filterQuotaConnections(rows, query, kind, kindLabel, nameOf)

describe('filterQuotaConnections', () => {
  it('lists every connection with counts per kind in a stable order', () => {
    expect(view().counts).toEqual([
      { kind: 'llm', count: 2 }, { kind: 'multimodal', count: 1 }, { kind: 'asr', count: 2 }, { kind: 'tts', count: 1 }, { kind: 'local-asr', count: 1 }
    ])
    expect(view().rows).toHaveLength(7)
  })

  it('matches names, models and kind labels, ignoring case', () => {
    expect(view('DEEPSEEK').rows.map(row => row.id)).toEqual(['a'])
    expect(view('gemini-3.8').rows.map(row => row.id)).toEqual(['c'])
    expect(view('claude').rows.map(row => row.id)).toEqual(['b'])
    expect(view('豆包').rows.map(row => row.id)).toEqual(['d'])
    expect(view('asr').rows.map(row => row.id)).toEqual(['d', 'e', 'g'])
  })

  it('keeps chips to what the query found and drops kinds with no hit', () => {
    expect(view('asr').counts).toEqual([{ kind: 'asr', count: 2 }, { kind: 'local-asr', count: 1 }])
    expect(view('asr').matched).toBe(3)
    expect(view('asr', 'asr').matched).toBe(3)
    expect(view('asr', 'asr').rows).toHaveLength(2)
    expect(view('asr', 'asr').rows.map(row => row.id)).toEqual(['d', 'e'])
  })

  it('falls back to all when the query empties the chosen kind', () => {
    expect(view('gemini', 'asr').kind).toBe('all')
    expect(view('gemini', 'asr').rows.map(row => row.id)).toEqual(['c'])
  })

  it('reports nothing for an unmatched query without losing the list', () => {
    expect(view('没有这种连接').rows).toEqual([])
    expect(view('没有这种连接').counts).toEqual([])
    expect(view('').rows).toHaveLength(7)
  })
})
