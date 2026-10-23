import { mt } from '@shared/mainI18n'

/** Keep code and comment delimiters out of a prose-polishing request. */
export function commentSelection(text: string): { items: { line: number; text: string }[]; restore: (raw: string, transform?: (text: string) => string) => string } | null {
  const lines = text.split(/\r?\n/), endings = text.match(/\r?\n/g) ?? []
  const comments = lines.map((line, index) => {
    if (/^\s*(?:\*\/|-->)\s*$/.test(line)) return null
    const match = /^(\s*(?:\/\/+|#|--|\/\*+|\*|<!--)\s*)(.*?)(\s*(?:\*\/|-->)\s*)?$/.exec(line)
    return match && match[2].trim() ? { line: index, prefix: match[1], text: match[2], suffix: match[3] ?? '' } : null
  }).filter((row): row is NonNullable<typeof row> => row !== null)
  if (!comments.length) return null
  return { items: comments.map(({ line, text }) => ({ line, text })), restore: (raw, transform = value => value) => {
    const result: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    if (!Array.isArray(result) || result.length !== comments.length) throw new Error(mt('注释润色结果格式无效，原文未修改'))
    const edited = new Map<number, string>()
    for (const value of result) {
      if (!value || typeof value !== 'object' || !comments.some(row => row.line === value.line) || edited.has(value.line) ||
        typeof value.text !== 'string' || !value.text.trim() || /[\r\n]/.test(value.text) || /\*\/|-->/.test(value.text)) throw new Error(mt('注释润色结果格式无效，原文未修改'))
      const prose = transform(value.text)
      if (!prose.trim() || /[\r\n]|\*\/|-->/.test(prose)) throw new Error(mt('注释润色结果格式无效，原文未修改'))
      edited.set(value.line, prose)
    }
    for (const row of comments) lines[row.line] = row.prefix + edited.get(row.line)! + row.suffix
    return lines.map((line, index) => line + (endings[index] ?? '')).join('')
  } }
}
