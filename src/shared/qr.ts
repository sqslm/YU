/** Only explicit web links get an Open button; all other payloads remain text. */
export function qrWebUrl(text: string): string | null {
  if (typeof text !== 'string' || text.length > 8192) return null
  try {
    const url = new URL(text.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
  } catch { return null }
}
