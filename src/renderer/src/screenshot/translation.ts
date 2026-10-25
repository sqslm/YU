import type { ScreenshotTextRegion, ScreenshotTranslation } from '@shared/screenshot'

const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif'

/** Use the existing text column and free line spacing before reducing the font. */
export function layoutTranslation(regions: ScreenshotTextRegion[], width: number, height: number,
  measure: (text: string, size: number) => number): Array<ScreenshotTextRegion & { size: number; lines: string[]; overflow: boolean }> {
  return regions.map(region => {
    const initial = Math.max(1, region.fontSize ?? region.height)
    const aligned = regions.filter(other => Math.abs(other.x - region.x) < initial && other !== region)
    let right = Math.min(width, Math.max(region.x + region.width, ...aligned.map(other => other.x + other.width)))
    if (!aligned.length) right = Math.min(width, Math.max(right, region.x + initial * 8))
    const maxBottom = Math.min(height, region.y + Math.max(region.height, initial * 3.6))
    for (const other of regions) if (other !== region && other.x >= region.x + region.width && other.y < maxBottom && other.y + other.height > region.y) right = Math.min(right, other.x - 3)
    let bottom = maxBottom
    for (const other of regions) if (other !== region && other.y >= region.y + region.height && other.x < right && other.x + other.width > region.x) bottom = Math.min(bottom, other.y - 2)
    const boxWidth = Math.max(1, right - region.x), boxHeight = Math.max(region.height, bottom - region.y)
    const minimum = Math.min(initial, Math.max(10, initial * .65))
    let size = initial, lines: string[] = []
    for (;;) {
      lines = wrapTranslation(region.text, boxWidth, text => measure(text, size))
      if (lines.length * size * 1.15 <= boxHeight || size <= minimum) break
      size = Math.max(minimum, size - .5)
    }
    const overflow = lines.length * size * 1.15 > boxHeight
    const usedHeight = Math.min(boxHeight, Math.max(region.height, lines.length * size * 1.15))
    if (overflow) {
      lines = lines.slice(0, Math.max(1, Math.floor(boxHeight / (size * 1.15))))
      let last = lines.at(-1) ?? ''
      while (last && measure(last + '…', size) > boxWidth) last = last.slice(0, -1)
      lines[lines.length - 1] = last + '…'
    }
    return { ...region, width: boxWidth, height: usedHeight, size, lines, overflow }
  })
}

/** Wrap by code point so mixed Chinese/Latin text and long identifiers both fit. */
export function wrapTranslation(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const token of paragraph.match(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
      if (line && measure(line + token) > width) { lines.push(line.trimEnd()); line = '' }
      for (const character of token) {
        if (line && measure(line + character) > width) { lines.push(line.trimEnd()); line = '' }
        if (line || character.trim()) line += character
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/** Sample the border rather than glyphs; use its dominant colour to cover original text. */
function backgroundAt(source: HTMLCanvasElement, x: number, y: number, width: number, height: number): string {
  const ctx = source.getContext('2d')!
  const samples = new Map<string, { count: number; rgb: number[] }>()
  for (let i = 0; i < 24; i++) {
    const px = Math.max(0, Math.min(source.width - 1, Math.round(x + width * i / 23)))
    for (const py of [y - 2, y + height + 2]) {
      const rgb = Array.from(ctx.getImageData(px, Math.max(0, Math.min(source.height - 1, Math.round(py))), 1, 1).data).slice(0, 3)
      const key = rgb.map(value => Math.round(value / 16)).join(',')
      const sample = samples.get(key)
      samples.set(key, sample ? { ...sample, count: sample.count + 1 } : { count: 1, rgb })
    }
  }
  const rgb = [...samples.values()].sort((a, b) => b.count - a.count)[0].rgb
  return `rgb(${rgb.join(',')})`
}

/** Paint once at captured resolution, then reuse the same pixels for preview/copy/save. */
export function paintScreenshotTranslation(source: HTMLCanvasElement, translation: ScreenshotTranslation): { canvas: HTMLCanvasElement; overflow: boolean } {
  const output = document.createElement('canvas'); output.width = source.width; output.height = source.height
  const ctx = output.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  const sx = source.width / translation.width, sy = source.height / translation.height
  const regions = translation.regions.map(region => ({ ...region, x: region.x * sx, y: region.y * sy, width: region.width * sx, height: region.height * sy, fontSize: (region.fontSize ?? region.height) * sy }))
  const layout = layoutTranslation(regions, source.width, source.height, (text, size) => { ctx.font = `${size}px ${FONT}`; return ctx.measureText(text).width })
  for (const region of layout) {
    const x = Math.max(0, region.x - 1), y = Math.max(0, region.y - 1)
    const width = Math.min(source.width - x, region.width + 2), height = Math.min(source.height - y, region.height + 2)
    const background = backgroundAt(source, x, y, width, height)
    const rgb = background.match(/\d+/g)!.map(Number)
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip()
    ctx.fillStyle = background; ctx.fillRect(x, y, width, height)
    ctx.fillStyle = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 140 ? '#f2f3f5' : '#202124'
    const { size, lines } = region
    ctx.font = `${size}px ${FONT}`
    ctx.textBaseline = 'top'
    lines.forEach((line, index) => ctx.fillText(line, region.x, region.y + index * size * 1.15))
    ctx.restore()
  }
  return { canvas: output, overflow: layout.some(region => region.overflow) }
}
