import { expect, it } from 'vitest'
import matrix from './qr.fixture.json'
import { decodeQr } from './qr'
import { qrWebUrl } from '@shared/qr'

// Independent QR fixture generated with Python qrcode, including its quiet zone.
it('decodes selected QR pixels locally, including inverted and rotated codes', async () => {
  const width = matrix.length * 5
  for (const mode of ['normal', 'inverted', 'rotated']) {
    const rgba = new Uint8ClampedArray(width * width * 4)
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const dark = mode === 'rotated' ? matrix[matrix.length - 1 - Math.floor(x / 5)][Math.floor(y / 5)] === '1' : matrix[Math.floor(y / 5)][Math.floor(x / 5)] === '1'
      const value = (mode === 'inverted' ? !dark : dark) ? 0 : 255
      rgba.set([value, value, value, 255], (y * width + x) * 4)
    }
    expect(await decodeQr(rgba, width, width)).toBe('https://github.com/sqslm/YU')
  }
  expect(await decodeQr(new Uint8ClampedArray(width * width * 4).fill(255), width, width)).toBeNull()
})

it('keeps arbitrary QR payloads as text and offers Open only for a web URL', () => {
  for (const payload of ['WIFI:T:WPA;S:home;P:secret;;', '你好', 'javascript:alert(1)', 'file:///C:/a.exe', 'data:text/html,hello', 'https://user:pass@example.com']) expect(qrWebUrl(payload)).toBeNull()
  expect(qrWebUrl(' https://github.com/sqslm/YU ')).toBe('https://github.com/sqslm/YU')
})
