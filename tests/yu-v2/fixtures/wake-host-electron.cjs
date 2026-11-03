// Runs the real WakeWordHost inside Electron so the shipped listener path — process
// spawn, stdin configuration, ready, level and stop — is exercised outside the unit
// mocks. No audio is recorded: the host only opens the default input and is stopped
// again, and only event types are reported.
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const ts = require('typescript')

const root = path.resolve(__dirname, '../../..')
const compiled = new Map()
const rootRequire = require

function load(file) {
  if (compiled.has(file)) return compiled.get(file)
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  })
  const module = { exports: {} }
  compiled.set(file, module.exports)
  const requireFromFile = (request) => {
    if (request === 'electron') return electronStub
    if (request === '@shared/wake-word') return load(path.join(root, 'src/shared/wake-word.ts'))
    if (request === '@shared/mainI18n') return { mt: (text) => text }
    if (request === '@shared/types') return {}
    if (request.startsWith('.')) return load(resolveRelative(file, request))
    return rootRequire(request)
  }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', outputText)
  factory(module.exports, requireFromFile, module, file, path.dirname(file))
  compiled.set(file, module.exports)
  return module.exports
}

function resolveRelative(from, request) {
  const base = path.resolve(path.dirname(from), request)
  for (const candidate of [base, base + '.ts', base + '.js', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error('cannot resolve ' + request + ' from ' + from)
}

const electronStub = { app: { isPackaged: false, getAppPath: () => root } }

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const { WakeWordHost } = load(path.join(root, 'src/main/wake-word.ts'))
  const events = []
  const host = new WakeWordHost({ wake: () => events.push('wake'), changed: (status) => events.push(status.phase) })
  const started = Date.now()
  host.update({ enabled: true, phrase: '你好胡小杨', confidence: 0.8, deviceId: '0' }, false)
  const readyAt = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (host.snapshot().phase === 'listening' || host.snapshot().phase === 'error') {
        clearInterval(timer)
        resolve(Date.now() - started)
      }
    }, 20)
    setTimeout(() => { clearInterval(timer); resolve(null) }, 15000)
  })
  const snapshot = host.snapshot()
  const devices = await host.listDevices()
  host.stop()
  await new Promise((done) => setTimeout(done, 400))
  const result = {
    helper: path.join(root, 'native/bin/yu-wake.exe'),
    exists: fs.existsSync(path.join(root, 'native/bin/yu-wake.exe')),
    readyAt,
    phase: snapshot.phase,
    error: snapshot.error ?? null,
    deviceName: snapshot.deviceName ?? null,
    transitions: events.filter((event) => typeof event === 'string' && event !== 'wake'),
    devices: devices.length,
    deviceIssue: host.deviceIssue,
    stoppedPhase: host.snapshot().phase,
  }
  fs.writeFileSync(process.env.WAKE_HOST_OUT ?? path.join(os.tmpdir(), 'yu-wake-host.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  app.exit(0)
})
