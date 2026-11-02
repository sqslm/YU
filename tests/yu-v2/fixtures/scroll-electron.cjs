const { app, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const koffi = require('koffi')

app.setPath('userData', process.argv[3])
app.setPath('sessionData', process.argv[3])
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const width = 320, height = 200
  const page = top => {
    const bytes = Buffer.alloc(width * height * 4, 255)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = ((y + top) * 1337 + x * 311 + 7 * 97) >>> 0, i = (y * width + x) * 4
      bytes.fill(((value ^ (value >>> 5)) * 13) & 255, i, i + 3)
    }
    return nativeImage.createFromBitmap(bytes, { width, height }).toBitmap()
  }
  const previous = page(0), next = page(37), copy = Buffer.from(previous), result = new Uint32Array(3)
  const library = koffi.load(process.argv[2])
  const match = library.func('int yu_scroll_match(const uint8_t *previous, size_t previous_len, const uint8_t *next, size_t next_len, uint32_t width, uint32_t height, _Out_ uint32_t *result)')
  assert.equal(match(previous, previous.length, next, next.length, width, height, result), 1)
  assert.deepEqual(Array.from(result), [37, 0, 0]); assert.deepEqual(previous, copy)
  library.unload()
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, nativeImageAndFfi: true }))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
