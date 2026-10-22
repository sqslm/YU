export const SAMPLE_RATE = 16000

/** Wraps little-endian mono PCM16 in a RIFF/WAVE container (44-byte header). */
export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  new Int16Array(buffer, 44).set(pcm)
  return new Uint8Array(buffer)
}
