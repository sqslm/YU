/**
 * Header lines from the settings textarea (`X-Thing: value` per line).
 *
 * Lives apart from the ASR client because four modules need it — the OpenAI-shaped
 * client, the LLM client, the model lister, and the vendor adapter contracts — and
 * one of those (the adapter contract) is imported *by* the client. Keeping it here
 * is what stops `asr/types.ts` from importing `asr.ts` and making the adapter
 * registries undefined at init time.
 */
export function parseHeaderLines(extra?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (extra ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return out
}
