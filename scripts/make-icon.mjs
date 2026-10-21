// Generates resources/icon.png (256x256 RGBA, rounded square + mic glyph) with
// no image dependency: PNG chunks are written directly and deflated via zlib.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SIZE = 256

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)
const radius = 56
const cx = SIZE / 2
const cy = SIZE / 2

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    // rounded-square mask
    const dx = Math.max(radius - x, x - (SIZE - radius), 0)
    const dy = Math.max(radius - y, y - (SIZE - radius), 0)
    const insideSquare = Math.hypot(dx, dy) <= radius
    // background: deep indigo gradient
    const t = (x + y) / (SIZE * 2)
    const bg = [Math.round(24 + 22 * t), Math.round(28 + 24 * t), Math.round(38 + 60 * t), 255]
    // microphone capsule
    const capTop = cy - 46
    const capBottom = cy + 10
    const inCapsule =
      Math.abs(x - cx) <= 22 && y >= capTop && y <= capBottom
        ? true
        : Math.hypot(x - cx, y - capTop) <= 22 || Math.hypot(x - cx, y - capBottom) <= 22
    // stem + base arc: a U-shaped cradle sitting under the capsule
    const inStem = Math.abs(x - cx) <= 5 && y > capBottom + 6 && y < cy + 74
    const arcR = 54
    const dist = Math.hypot(x - cx, y - cy)
    const inArc = y > cy + 6 && y < cy + arcR + 6 && Math.abs(dist - arcR) <= 6
    const fg = inCapsule || inStem || inArc
    const color = fg ? [242, 245, 255, 255] : bg
    pixels[i] = color[0]
    pixels[i + 1] = color[1]
    pixels[i + 2] = color[2]
    pixels[i + 3] = insideSquare ? 255 : 0
  }
}

const out = join(process.cwd(), 'resources', 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png(SIZE, SIZE, pixels))
console.log(`wrote ${out}`)
