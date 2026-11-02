'use strict'

// Electron main-process fixture for scripts/benchmark-capture.mjs.
// One process per scenario: it paints a deterministic opaque window, then runs
// the three capture implementations (A baseline, B cached bindings, C Rust DLL)
// in an interleaved order and prints one JSON line prefixed with __RESULT__.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const ts = require('typescript')
const { app, BrowserWindow, nativeImage, screen } = require('electron')
const koffi = require('koffi')

const ROOT = path.resolve(__dirname, '../../..')
const rootRequire = createRequire(path.join(ROOT, 'package.json'))
const BASELINE = process.env.CAPTURE_BASELINE ?? '872e5b5'
const dllPath = process.env.CAPTURE_DLL ?? ''
const scenario = JSON.parse(process.env.CAPTURE_SCENARIO ?? '{"name":"720p","width":1280,"height":720}')
const WIDTH = scenario.width
const HEIGHT = scenario.height

const WARMUP = 3
const SAMPLES = 15

// --- TypeScript loading (baseline module, ScrollCapture) -------------------

const electronShim = new Proxy(require('electron'), {
  get(target, key) {
    if (key === 'app') {
      return new Proxy(app, {
        get(appTarget, appKey) {
          if (appKey === 'getAppPath') return () => ROOT
          const value = Reflect.get(appTarget, appKey)
          return typeof value === 'function' ? value.bind(appTarget) : value
        },
      })
    }
    return Reflect.get(target, key)
  },
})

const compiled = new Map()

function compileFile(filename) {
  if (compiled.has(filename)) return compiled.get(filename)
  const source = fs.readFileSync(filename, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText
  const dir = path.dirname(filename)
  const module = { exports: {} }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', js)
  const moduleRequire = (name) => {
    if (name === 'electron') return electronShim
    if (name.startsWith('.')) {
      const base = path.resolve(dir, name)
      for (const candidate of [base, base + '.ts', base + '.js', path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return compileFile(candidate)
      }
      throw new Error(`unresolved ${name} from ${filename}`)
    }
    return rootRequire(name)
  }
  factory(module.exports, moduleRequire, module, filename, dir)
  compiled.set(filename, module.exports)
  return module.exports
}

function compileSource(source, filename) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText
  const module = { exports: {} }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', js)
  factory(module.exports, (name) => {
    if (name === 'electron') return electronShim
    return rootRequire(name)
  }, module, filename, path.dirname(filename))
  return module.exports
}

const baselineSource = execFileSync('git', ['show', `${BASELINE}:src/main/capture-screen.ts`], {
  cwd: ROOT,
  encoding: 'utf8',
})
const captureScreenBaseline = compileSource(baselineSource, path.join(ROOT, 'src/main/capture-screen.ts')).captureScreen
const { ScrollCapture } = compileFile(path.join(ROOT, 'src/main/scroll-capture.ts'))

// --- B: cached Koffi bindings, raw BGRA Buffer, no NativeImage -------------

function createCachedCapture() {
  const user = koffi.load('user32.dll')
  const gdi = koffi.load('gdi32.dll')
  const getDC = user.func('void *GetDC(void *window)')
  const releaseDC = user.func('int ReleaseDC(void *window, void *dc)')
  const createDC = gdi.func('void *CreateCompatibleDC(void *dc)')
  const deleteDC = gdi.func('int DeleteDC(void *dc)')
  const createBitmap = gdi.func('void *CreateCompatibleBitmap(void *dc, int width, int height)')
  const select = gdi.func('void *SelectObject(void *dc, void *object)')
  const remove = gdi.func('int DeleteObject(void *object)')
  const blit = gdi.func('int BitBlt(void *dc, int x, int y, int width, int height, void *src, int sx, int sy, uint32_t rop)')
  const getBits = gdi.func('int GetDIBits(void *dc, void *bitmap, uint32_t start, uint32_t lines, void *bits, void *info, uint32_t usage)')
  const info = Buffer.alloc(44)

  return function capture(rect) {
    const { x, y, width, height } = rect
    if (width < 1 || height < 1 || width * height > 40_000_000) throw new Error('Unsupported screen capture')
    const pixels = Buffer.allocUnsafe(width * height * 4)
    const dc = getDC(null)
    if (!dc) throw new Error('GetDC failed')
    let memory = null
    let bitmap = null
    let previous = null
    try {
      memory = createDC(dc)
      if (!memory) throw new Error('CreateCompatibleDC failed')
      bitmap = createBitmap(dc, width, height)
      if (!bitmap) throw new Error('CreateCompatibleBitmap failed')
      previous = select(memory, bitmap)
      if (!previous) throw new Error('SelectObject failed')
      if (!blit(memory, 0, 0, width, height, dc, x, y, 0x40cc0020)) throw new Error('BitBlt failed')
      select(memory, previous)
      previous = null
      info.fill(0)
      info.writeUInt32LE(40, 0)
      info.writeInt32LE(width, 4)
      info.writeInt32LE(-height, 8)
      info.writeUInt16LE(1, 12)
      info.writeUInt16LE(32, 14)
      const rows = getBits(dc, bitmap, 0, height, pixels, info, 0)
      if (rows !== height) throw new Error(`GetDIBits returned ${rows} rows`)
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
      return pixels
    } finally {
      if (previous) select(memory, previous)
      if (bitmap) remove(bitmap)
      if (memory) deleteDC(memory)
      releaseDC(null, dc)
    }
  }
}

// --- C: Rust DLL writes into a JS-owned Buffer -----------------------------

function createRustCapture(file) {
  const library = koffi.load(file)
  const call = library.func('int yu_capture_bgra(int x, int y, int width, int height, void *output, size_t output_len)')
  return function capture(rect) {
    const { x, y, width, height } = rect
    if (width < 1 || height < 1 || width * height > 40_000_000) throw new Error('Unsupported screen capture')
    const pixels = Buffer.allocUnsafe(width * height * 4)
    const status = call(x, y, width, height, pixels, pixels.length)
    if (status !== 0) throw new Error(`yu_capture_bgra failed with ${status}`)
    return pixels
  }
}

// --- GDI object accounting -------------------------------------------------

const kernel32 = koffi.load('kernel32.dll')
const user32 = koffi.load('user32.dll')
const getCurrentProcess = kernel32.func('void *GetCurrentProcess()')
const getGuiResources = user32.func('uint32_t GetGuiResources(void *process, uint32_t flags)')
const processHandle = getCurrentProcess()
const gdiObjects = () => getGuiResources(processHandle, 0)
const userObjects = () => getGuiResources(processHandle, 1)

// --- Deterministic painted content ----------------------------------------

const BLOCKS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff']
const HEADER_ROWS = 120

function pageScript(width, height) {
  return `(() => {
    document.body.style.cssText = 'margin:0;background:#000;overflow:hidden'
    const canvas = document.createElement('canvas')
    canvas.width = ${width}; canvas.height = ${height}
    canvas.style.cssText = 'display:block;width:${width}px;height:${height}px'
    document.body.appendChild(canvas)
    const context = canvas.getContext('2d', { alpha: false })
    const blocks = ${JSON.stringify(BLOCKS)}
    const band = Math.round(${width} / blocks.length)
    for (let index = 0; index < blocks.length; index += 1) {
      const left = index * band
      const right = index === blocks.length - 1 ? ${width} : left + band
      context.fillStyle = blocks[index]
      context.fillRect(left, 0, right - left, ${HEADER_ROWS})
    }
    const body = context.createImageData(${width}, ${height} - ${HEADER_ROWS})
    const data = body.data
    for (let row = 0; row < body.height; row += 1) {
      const y = row + ${HEADER_ROWS}
      for (let x = 0; x < body.width; x += 1) {
        const offset = (row * body.width + x) * 4
        data[offset] = (x * 5 + y * 3) & 255
        data[offset + 1] = (x * 11 + y * 7) & 255
        data[offset + 2] = (x * 13 + y * 17) & 255
        data[offset + 3] = 255
      }
    }
    context.putImageData(body, 0, ${HEADER_ROWS})
    window.__painted = true
  })()`
}

// --- Measurement ----------------------------------------------------------

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
  return {
    count: sorted.length,
    p50: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  }
}

function measureOnce(run) {
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  run()
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuBefore)
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 }
}

async function memory() {
  // getProcessMemoryInfo resolves with kilobytes; the fallback keeps rss in the
  // same unit if the API is unavailable.
  const info = typeof process.getProcessMemoryInfo === 'function' ? await process.getProcessMemoryInfo() : null
  const usage = process.memoryUsage()
  return {
    privateKb: info?.private ?? 0,
    residentKb: info?.residentSet ?? Math.round(usage.rss / 1024),
    heapUsedKb: Math.round(usage.heapUsed / 1024),
  }
}

function createWindow() {
  const window = new BrowserWindow({
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    // The 1080p window is taller than the work area once the taskbar is removed.
    enableLargerThanScreen: true,
    frame: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setContentProtection(false)
  // Windows 11 rounds every top-level window by default, which blends the
  // corner pixels with the desktop. Keep the client area fully ours so pixel
  // probes can include the edges.
  const dwmapi = koffi.load('dwmapi.dll')
  const setWindowAttribute = dwmapi.func('int DwmSetWindowAttribute(void *window, uint32_t attribute, void *value, uint32_t size)')
  const corners = Buffer.alloc(4)
  corners.writeInt32LE(1, 0) // DWMWCP_DONOTROUND
  const handle = window.getNativeWindowHandle()
  const hwnd = Number(handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0)))
  const attribute = setWindowAttribute(hwnd, 33, corners, 4) // DWMWA_WINDOW_CORNER_PREFERENCE
  if (attribute !== 0) window.__cornerPreference = attribute
  return window
}

async function settle(window) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body><script>${pageScript(WIDTH, HEIGHT)}</script></body></html>`
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await window.webContents.executeJavaScript('window.__painted === true')) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  window.showInactive()
  await new Promise((resolve) => setTimeout(resolve, 600))
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = createWindow()
  await settle(window)
  const bounds = window.getContentBounds()
  const display = screen.getDisplayMatching(bounds)
  const rect = {
    x: Math.round(bounds.x * display.scaleFactor),
    y: Math.round(bounds.y * display.scaleFactor),
    width: Math.round(bounds.width * display.scaleFactor),
    height: Math.round(bounds.height * display.scaleFactor),
  }
  if (rect.width !== WIDTH || rect.height > HEIGHT || display.scaleFactor !== 1) {
    throw new Error(`unexpected window geometry ${JSON.stringify({ bounds, rect, scaleFactor: display.scaleFactor })}`)
  }
  // Windows caps a normal top-level window to the work area, so a 1080p screen
  // yields a 1920x1032 client area once the taskbar is removed.
  const geometryNote = rect.height === HEIGHT ? null : `requested ${WIDTH}x${HEIGHT}, window capped to ${rect.width}x${rect.height} by the work area`

  const cachedCapture = createCachedCapture()
  const rustCapture = dllPath ? createRustCapture(dllPath) : null
  if (!rustCapture) throw new Error('CAPTURE_DLL not set')

  const variants = [
    {
      name: 'A',
      label: 'baseline NativeImage',
      buffer: () => captureScreenBaseline(rect).toBitmap(),
      image: () => captureScreenBaseline(rect),
      scroll: () => {
        const scroll = new ScrollCapture(rect.width, rect.height)
        scroll.add(captureScreenBaseline(rect).toBitmap())
        scroll.preview()
      },
    },
    {
      name: 'B',
      label: 'cached bindings',
      buffer: () => cachedCapture(rect),
      image: () => nativeImage.createFromBitmap(cachedCapture(rect), { width: rect.width, height: rect.height }),
      scroll: () => {
        const scroll = new ScrollCapture(rect.width, rect.height)
        scroll.add(cachedCapture(rect))
        scroll.preview()
      },
    },
    {
      name: 'C',
      label: 'rust dll',
      buffer: () => rustCapture(rect),
      image: () => nativeImage.createFromBitmap(rustCapture(rect), { width: rect.width, height: rect.height }),
      scroll: () => {
        const scroll = new ScrollCapture(rect.width, rect.height)
        scroll.add(rustCapture(rect))
        scroll.preview()
      },
    },
  ]

  const thumbnail = (variant) =>
    variant.name === 'A'
      ? captureScreenBaseline(rect).resize({ width: 640, quality: 'best' }).toBitmap()
      : nativeImage.createFromBitmap(variant.name === 'B' ? cachedCapture(rect) : rustCapture(rect), { width: rect.width, height: rect.height })
          .resize({ width: 640, quality: 'best' })
          .toBitmap()

  const order = ['A', 'B', 'C', 'C', 'B', 'A']
  const byName = new Map(variants.map((variant) => [variant.name, variant]))
  const work = {
    buffer: (variant) => variant.buffer(),
    image: (variant) => variant.image(),
    thumbnail,
    scroll: (variant) => variant.scroll(),
  }

  const memoryBefore = await memory()
  const results = {}
  for (const [metric, run] of Object.entries(work)) {
    results[metric] = Object.fromEntries(variants.map((variant) => [variant.name, []]))
    for (let round = 0; round < WARMUP; round += 1) {
      for (const name of order) run(byName.get(name))
    }
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      for (const name of order) {
        const sampleResult = measureOnce(() => run(byName.get(name)))
        results[metric][name].push(sampleResult)
      }
    }
  }

  // process.cpuUsage() has ~15.6 ms granularity on Windows, so a single 8 ms
  // capture reads as 0 or 1 tick. Batch 100 calls per variant to get a usable
  // average CPU cost.
  const cpuBatches = {}
  for (const [metric, run] of Object.entries(work)) {
    cpuBatches[metric] = {}
    for (const variant of variants) {
      for (let index = 0; index < WARMUP; index += 1) run(variant)
      const before = process.cpuUsage()
      const startedAt = performance.now()
      for (let index = 0; index < 100; index += 1) run(variant)
      const used = process.cpuUsage(before)
      cpuBatches[metric][variant.name] = {
        cpuMsPerCall: Number((((used.user + used.system) / 1000) / 100).toFixed(3)),
        wallMsPerCall: Number(((performance.now() - startedAt) / 100).toFixed(3)),
      }
    }
  }

  // Pixel verification: every implementation must see the same bytes.
  const hashes = {}
  const probes = {}
  for (const variant of variants) {
    const pixels = variant.buffer()
    hashes[variant.name] = {
      sha256: crypto.createHash('sha256').update(pixels).digest('hex'),
      length: pixels.length,
    }
    const at = (x, y) => {
      const offset = (y * rect.width + x) * 4
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]]
    }
    const band = Math.round(rect.width / 4)
    probes[variant.name] = {
      red: at(Math.floor(band / 2), 60),
      green: at(band + Math.floor(band / 2), 60),
      blue: at(band * 2 + Math.floor(band / 2), 60),
      white: at(band * 3 + Math.floor(band / 2), 60),
      firstBodyRow: at(3, HEADER_ROWS),
      lastRowOddColumn: at(rect.width - 1, rect.height - 1),
      bottomRowSamples: [0, 1, 2, band, rect.width - 2, rect.width - 1].map((x) => {
        const y = rect.height - 1
        return { x, y, actual: at(x, y), expected: [(x * 13 + y * 17) & 255, (x * 11 + y * 7) & 255, (x * 5 + y * 3) & 255, 255] }
      }),
      rowShifts: [1, 2, 3].map((shift) => {
        const x = rect.width - 1
        const y = rect.height - 1 - shift
        return { x, y, actual: at(x, y), expected: [(x * 13 + y * 17) & 255, (x * 11 + y * 7) & 255, (x * 5 + y * 3) & 255, 255] }
      }),
      alphaOpaque: (() => {
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 255) return false
        return true
      })(),
    }
  }

  // Production cross-check: the shipping module must produce the same bytes as
  // the three measured implementations.
  const productionModule = compileFile(path.join(ROOT, 'src/main/capture-screen.ts'))
  if (typeof productionModule.captureScreenPixels !== 'function') throw new Error('src/main/capture-screen.ts does not export captureScreenPixels')
  const productionPixels = productionModule.captureScreenPixels(rect)
  const productionImagePixels = productionModule.captureScreen(rect).toBitmap()
  const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
  const production = {
    sha256: digest(productionPixels),
    imageSha256: digest(productionImagePixels),
    length: productionPixels.length,
    matchesMeasured: digest(productionPixels) === hashes.A.sha256 && digest(productionImagePixels) === hashes.A.sha256,
  }

  // Leak check: 200 captures per implementation must not grow GDI handles.
  const leak = {}
  for (const variant of variants) {
    variant.buffer()
    const before = { gdi: gdiObjects(), user: userObjects() }
    for (let index = 0; index < 200; index += 1) variant.buffer()
    const after = { gdi: gdiObjects(), user: userObjects() }
    leak[variant.name] = { before, after, deltaGdi: after.gdi - before.gdi, deltaUser: after.user - before.user }
  }

  const memorySnapshot = { before: memoryBefore, after: await memory() }
  window.destroy()

  const payload = {
    scenario: {
      ...scenario,
      width: rect.width,
      height: rect.height,
      requested: { width: WIDTH, height: HEIGHT },
      note: geometryNote,
      rect,
      scaleFactor: display.scaleFactor,
      displays: screen.getAllDisplays().map((d) => d.bounds),
    },
    variants: variants.map(({ name, label }) => ({ name, label })),
    warmup: WARMUP,
    samplesPerVariant: SAMPLES * 2,
    metrics: Object.fromEntries(
      Object.entries(results).map(([metric, perVariant]) => [
        metric,
        Object.fromEntries(
          Object.entries(perVariant).map(([name, samples]) => [
            name,
            {
              wall: stats(samples.map((sample) => sample.wallMs)),
              cpu: stats(samples.map((sample) => sample.cpuMs)),
              raw: samples.map((sample) => ({
                wallMs: Number(sample.wallMs.toFixed(3)),
                cpuMs: Number(sample.cpuMs.toFixed(3)),
              })),
            },
          ]),
        ),
      ]),
    ),
    verification: { hashes, probes, production },
    cpuBatches,
    leak: leak,
    memory: memorySnapshot,
    dllBytes: dllPath ? fs.statSync(dllPath).size : 0,
  }
  process.stdout.write('__RESULT__' + JSON.stringify(payload) + '\n')
  app.exit(0)
}).catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  app.exit(1)
})
