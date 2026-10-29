export type MemoryReplyKind = 'facts' | 'memory'

/** Extract one complete object; never repair broken JSON or choose between multiple answers. */
function parseReply(input: string): unknown {
  const raw = input.trim().replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/u, '')
  try { return JSON.parse(raw) } catch { /* The object may be surrounded by presentation text. */ }
  if (raw.includes('<think>') || raw.includes('</think>')) throw Error('Unfinished memory reasoning')
  const start = raw.indexOf('{')
  if (start < 0) throw Error('Missing memory object')
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      if (/[{}\[\]]/u.test(raw.slice(0, start) + raw.slice(i + 1))) throw Error('Ambiguous memory objects')
      return JSON.parse(raw.slice(start, i + 1))
    }
  }
  throw Error('Incomplete memory object')
}

/** Bound model output before it reaches the SDK's older schema validator. */
export function validateMemoryReply(input: string, expected?: MemoryReplyKind): string {
  if (input.length > 64000) throw Error('Memory response too large')
  const value = parseReply(input) as Record<string, any>
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid memory response')
  const text = (raw: unknown, allowEmpty = false): string => {
    if (typeof raw !== 'string' || !allowEmpty && !raw.trim() || raw.length > 2000) throw Error('Invalid memory text')
    return raw
  }
  if (expected !== 'memory' && Array.isArray(value.facts) && value.memory === undefined && value.facts.length <= 20) return JSON.stringify({ facts: value.facts.map((fact: unknown) => text(fact)) })
  if (expected === 'facts' || !Array.isArray(value.memory) || value.memory.length > 20 || value.facts !== undefined) throw Error('Invalid memory actions')
  return JSON.stringify({ memory: value.memory.flatMap((row: any) => {
    if (!row || typeof row !== 'object' || !['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(row.event)) throw Error('Invalid memory action')
    if (row.event === 'NONE') return []
    // ADD ids are unused by Mem0; update/delete must identify an explicit SDK-local target.
    const id = row.event === 'ADD' ? '0' : String(row.id ?? '')
    if (!/^\d{1,8}$/u.test(id)) throw Error('Invalid memory target')
    return [{ id, event: row.event, text: row.event === 'DELETE' ? text(row.text ?? '', true) : text(row.text), ...(row.old_memory != null ? { old_memory: text(row.old_memory, true) } : {}) }]
  }) })
}
