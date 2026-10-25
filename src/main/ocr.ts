import { nativeImage, type NativeImage } from 'electron'
import type { ScreenshotTextRegion } from '@shared/screenshot'
import { mt } from '@shared/mainI18n'

/** OCR runs on a resized copy; overlay bounds must refer to the original crop. */
export function ocrRegions(result: Record<string, unknown>, size: { width: number; height: number }): ScreenshotTextRegion[] {
  const { width, height, lines } = result
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0 || !Array.isArray(lines) || !lines.length) throw new Error(mt('未获取到文字位置，请重新截图'))
  return lines.map(line => {
    if (!line || typeof line.text !== 'string' || !line.text.trim() ||
        ![line.x, line.y, line.width, line.height].every(Number.isFinite) || line.x < 0 || line.y < 0 ||
        line.width <= 0 || line.height <= 0 || line.x + line.width > width + 1 || line.y + line.height > height + 1) {
      throw new Error(mt('未获取到文字位置，请重新截图'))
    }
    return { text: normalizeOcrText(line.text), x: line.x * size.width / width, y: line.y * size.height / height,
      width: Math.min(line.width, width - line.x) * size.width / width, height: Math.min(line.height, height - line.y) * size.height / height }
  })
}

/** Preserve English word spacing and line breaks, remove Windows OCR's artificial CJK spaces. */
export function normalizeOcrText(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()
    .replace(/([\p{Script=Han}])[^\S\r\n]+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/\s+([，。！？；：、）》】」』])/gu, '$1')
    .replace(/([，。！？；：、（《【「『])\s+/gu, '$1')
  ).join('\n').trim()
}

/** Work on an OCR-only copy; exported screenshots keep their original pixels. */
export function prepareOcrImage(image: NativeImage): Buffer {
  const size = image.getSize(), original = image.toBitmap()
  let brightness = 0, samples = 0
  for (let i = 0; i < original.length; i += 64) { brightness += (original[i] + original[i + 1] + original[i + 2]) / 3; samples++ }
  const dark = brightness / Math.max(1, samples) < 128
  // Upscale small glyphs, not already-large text. Oversized Chinese glyphs
  // can be split into radicals by Windows OCR.
  const bands: number[] = []
  let band = 0
  for (let y = 0; y <= size.height; y++) {
    let ink = 0
    for (let x = 0; y < size.height && x < size.width; x++) {
      const i = (y * size.width + x) * 4, value = (original[i] + original[i + 1] + original[i + 2]) / 3
      if (dark ? value > 160 : value < 130) ink++
    }
    if (ink >= Math.max(2, size.width * .005)) band++
    else { if (band >= 5 && band <= 100) bands.push(band); band = 0 }
  }
  bands.sort((a, b) => a - b)
  const glyphHeight = bands[Math.floor(bands.length / 2)] ?? 28
  const scale = Math.min(glyphHeight < 11 ? 2 : glyphHeight < 20 ? 1.5 : 1, 2500 / Math.max(size.width, size.height))
  const width = Math.max(1, Math.round(size.width * scale)), height = Math.max(1, Math.round(size.height * scale))
  const enlarged = image.resize({ width, height, quality: 'best' }), pixels = enlarged.toBitmap()
  if (dark) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255 - pixels[i]; pixels[i + 1] = 255 - pixels[i + 1]; pixels[i + 2] = 255 - pixels[i + 2]
    }
    return nativeImage.createFromBitmap(pixels, { width, height }).toPNG()
  }
  return enlarged.toPNG()
}
