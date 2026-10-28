/** Lazy-loaded: selecting and annotating screenshots needs no QR decoder. */
export async function decodeQr(pixels: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null
}
