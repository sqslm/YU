import type { ScreenshotTextRegion } from './screenshot'
import { mt } from './mainI18n'

/** Join wrapped lines, keeping headings, list items and separate columns apart. */
export function groupScreenshotLines(lines: ScreenshotTextRegion[]): ScreenshotTextRegion[] {
  const regions: ScreenshotTextRegion[] = []
  for (const line of lines) {
    const previous = regions.at(-1)
    const fontSize = previous?.fontSize ?? previous?.height ?? line.height
    if (previous && previous.height < fontSize * 1.4 && Math.abs(line.y - previous.y) < fontSize * .4 &&
        line.x >= previous.x + previous.width && line.x - previous.x - previous.width < fontSize * 3) {
      previous.width = line.x + line.width - previous.x
      const bottom = Math.max(previous.y + previous.height, line.y + line.height)
      previous.y = Math.min(previous.y, line.y)
      previous.height = bottom - previous.y
      previous.fontSize = fontSize
      previous.text += ` ${line.text}`
      continue
    }
    const gap = previous ? line.y - previous.y - previous.height : Infinity
    const listItem = /^(?:\d+[.)、]|[-•●▪])\s*/u.test(line.text)
    if (previous && !listItem && gap >= 0 && gap < Math.min(fontSize, line.height) * .85 &&
        Math.abs(line.x - previous.x) < fontSize * 1.8 && Math.abs(line.height - fontSize) < fontSize * .35) {
      const right = Math.max(previous.x + previous.width, line.x + line.width)
      previous.x = Math.min(previous.x, line.x)
      previous.width = right - previous.x
      previous.height = line.y + line.height - previous.y
      previous.fontSize = fontSize
      previous.text += `\n${line.text}`
    } else regions.push({ ...line })
  }
  return regions
}

/** IDs bind translated text to trusted OCR geometry; model coordinates are never used. */
export function parseScreenshotTranslation(value: string, regions: ScreenshotTextRegion[]): ScreenshotTextRegion[] {
  let rows: unknown
  try { rows = JSON.parse(value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')) }
  catch { throw new Error(mt('翻译结果不完整，请重试')) }
  if (!Array.isArray(rows) || rows.length !== regions.length) throw new Error(mt('翻译结果不完整，请重试'))
  const translated = new Map<number, string>()
  for (const row of rows) {
    if (!row || !Number.isInteger(row.id) || row.id < 0 || row.id >= regions.length || translated.has(row.id) ||
        typeof row.text !== 'string' || !row.text.trim() || row.text.length > 100_000) throw new Error(mt('翻译结果不完整，请重试'))
    translated.set(row.id, row.text.trim())
  }
  return regions.map((region, id) => ({ ...region, text: translated.get(id)! }))
}
