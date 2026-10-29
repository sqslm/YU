/** Bound model output before it reaches the SDK's older schema validator. */
export function validateMemoryReply(input: string): string {
  if (input.length > 64000) throw Error('Memory response too large')
  const value = JSON.parse(input.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid memory response')
  const text = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.length > 2000) throw Error('Invalid memory text')
    return raw
  }
  if (Array.isArray(value.facts) && value.memory === undefined && value.facts.length <= 20) return JSON.stringify({ facts: value.facts.map(text) })
  if (!Array.isArray(value.memory) || value.memory.length > 20 || value.facts !== undefined) throw Error('Invalid memory actions')
  return JSON.stringify({ memory: value.memory.map((row: any) => {
    if (!row || typeof row !== 'object' || !['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(row.event)) throw Error('Invalid memory action')
    const id = String(row.id ?? '0')
    if (!/^\d{1,8}$/u.test(id)) throw Error('Invalid memory target')
    return { id, event: row.event, text: text(row.text), ...(row.old_memory != null ? { old_memory: text(row.old_memory) } : {}) }
  }) })
}
