import { pinyin } from 'pinyin-pro'
import type { EntityCandidate, EntityTerm } from '@shared/entities'

const lower = (text: string): string => text.normalize('NFKC').toLocaleLowerCase()
const phones = (text: string): string => pinyin(text, { toneType: 'none', type: 'array' }).join(' ').toLowerCase()
const near = (text: string): string => text.replace(/zh/g, 'z').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/ing\b/g, 'in').replace(/eng\b/g, 'en')
const protectedParts = /```[\s\S]*?```|`[^`]*`|https?:\/\/[^\s]+|[a-zA-Z]:[\\/][^\s，。；]+|[\w.+-]+@[\w.-]+\.[a-z]+|\b[\w.-]*\d+[.\d\w-]*\b|--[\w-]+(?:=[^\s]+)?|"(?:\\.|[^"\\])*"(?=\s*:)|\b(?:true|false|null|undefined)\b|\b(?:[A-Za-z_$]*[a-z][A-Z][\w$]*|[A-Za-z_$][\w$]*_[\w$]+)\b/gu

export class EntityMatcher {
  private indexed: Array<{ row: EntityTerm; names: Array<{ text: string; key: string; phone: string; pattern: RegExp | null }> }> = []
  set(terms: EntityTerm[]): void {
    this.indexed = terms.filter(row => row.enabled).map(row => ({ row, names: [row.canonical, ...row.aliases].map(text => {
      const key = lower(text)
      return { text, key, phone: phones(text), pattern: /[\u3400-\u9fff]/u.test(key) ? null : new RegExp('(^|[^\\w])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^\\w])', 'u') }
    }) }))
  }
  hotwords(scene: string): string[] {
    const context = lower(scene)
    const relevant = (row: EntityTerm): number => Number(Boolean(row.domain && context.includes(lower(row.domain)) || row.related.some(name => context.includes(lower(name)))))
    // Unknown scene: only explicitly enabled global user terms; domain terms must match.
    return this.indexed.filter(({ row }) => !row.domain || context.includes(lower(row.domain)) || row.related.some(name => context.includes(lower(name))))
      .sort((a, b) => relevant(b.row) - relevant(a.row) || Number(b.row.userDefined) - Number(a.row.userDefined) || Number(b.row.verified) - Number(a.row.verified))
      .slice(0, 20).map(({ row }) => row.canonical).filter((word, index, all) => all.indexOf(word) === index)
  }
  candidates(text: string, scene: string): EntityCandidate[] {
    if (/按原样|逐字|明确拼写|不要.{0,12}(?:改名|改写|替换|纠正)/u.test(text)) return []
    const original = lower(text), safe = lower(text.replace(protectedParts, ' ')).slice(0, 16000)
    const spoken = ' ' + phones(safe) + ' ', context = lower(scene + ' ' + safe), nearSpoken = near(spoken)
    const result: Array<{ row: EntityCandidate; score: number }> = []
    for (const { row, names } of this.indexed) {
      const relevant = Boolean(row.domain && context.includes(lower(row.domain)) || row.related.some(name => context.includes(lower(name))))
      for (const name of names) {
        const key = name.key, globalManual = row.userDefined && !row.domain && !row.related.length
        const exact = name.pattern ? name.pattern.test(safe) : safe.includes(key)
        const phonetic = !exact && (relevant || globalManual && name.text.length >= 3) && /^[\u3400-\u9fff]{2,12}$/u.test(name.text) && nearSpoken.includes(' ' + near(name.phone) + ' ')
        if (!exact && !phonetic) continue
        if (key !== lower(row.canonical) && ['person', 'place'].includes(row.type) && !relevant && !globalManual) continue
        if (original.includes(lower(row.canonical)) && !safe.includes(lower(row.canonical))) continue
        result.push({ row: { canonical: row.canonical, type: row.type, alias: name.text, reason: exact ? name.text === row.canonical ? 'name' : 'alias' : 'phonetic', domain: row.domain, related: row.related.slice(0, 4), source: row.source, verified: row.verified, userDefined: row.userDefined }, score: (exact ? 10 : 1) + (relevant ? 3 : 0) + (row.verified ? 1 : 0) })
        break
      }
    }
    return result.sort((a, b) => b.score - a.score).slice(0, 8).map(item => item.row)
  }
}
