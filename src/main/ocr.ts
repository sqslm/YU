import { nativeImage, type NativeImage } from 'electron'

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
