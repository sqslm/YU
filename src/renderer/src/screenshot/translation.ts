import type { ScreenshotTranslation } from '@shared/screenshot'

const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif'

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
export function paintScreenshotTranslation(source: HTMLCanvasElement, translation: ScreenshotTranslation): HTMLCanvasElement {
  const output = document.createElement('canvas'); output.width = source.width; output.height = source.height
  const ctx = output.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  for (const region of translation.regions) {
    const sx = source.width / translation.width, sy = source.height / translation.height
    const x = Math.max(0, region.x * sx - 2), y = Math.max(0, region.y * sy - 2)
    const width = Math.min(source.width - x, region.width * sx + 4), height = Math.min(source.height - y, region.height * sy + 4)
    const background = backgroundAt(source, x, y, width, height)
    const rgb = background.match(/\d+/g)!.map(Number)
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip()
    ctx.fillStyle = background; ctx.fillRect(x, y, width, height)
    ctx.fillStyle = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 140 ? '#f2f3f5' : '#202124'
    let size = Math.max(1, (region.fontSize ?? region.height) * sy)
    let lines: string[]
    do {
      ctx.font = `${size}px ${FONT}`
      lines = wrapTranslation(region.text, width - 2, text => ctx.measureText(text).width)
      if (lines.length * size * 1.2 <= height || size <= 1) break
      size = Math.max(1, size - .5)
    } while (true)
    ctx.textBaseline = 'top'
    lines.forEach((line, index) => ctx.fillText(line, x + 1, y + Math.max(0, (height - lines.length * size * 1.2) / 2) + index * size * 1.2))
    ctx.restore()
  }
  return output
}
