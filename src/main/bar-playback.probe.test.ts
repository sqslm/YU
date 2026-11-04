import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Runs the real-renderer probe in a separate Electron process.
 *
 * The unit tests never load the built pill, so they cannot notice a command that
 * is sent before the renderer subscribed to it. This entry bundles
 * `bar-playback.probe.ts` and requires the probe's `pass` flag, which only holds
 * when the built renderer really played, paused, resumed, sought, replaced,
 * cancelled, spoke and ended audio — and when the result carries the build
 * identity R4's `playbackGate` needs.
 */
const repo = process.cwd()
const OUT = process.env.PROBE_OUT ?? resolve(repo, '../../work/t19-probe')
const PROBE_TIMEOUT_MS = 180_000
const BAR_HTML = join(repo, 'out/renderer/bar.html')
const PRELOAD = join(repo, 'out/preload/index.js')
const MAIN_ENTRY = join(repo, 'out/main/index.js')
const ELECTRON = join(repo, 'node_modules/electron/dist/electron.exe')
const missing = [BAR_HTML, PRELOAD, MAIN_ENTRY, ELECTRON].filter(path => !existsSync(path))

/** The phase-20 scenarios R4's `playbackGate` refuses to accept without. */
const REQUIRED_IDS = ['r1-stop-before-ready', 'r1-playback-replacement', 'r2-destroy-or-cancel', 'r3-note-cold-path', 'r3-speech-cold-path']

/** The workspace ships esbuild only inside the pnpm store, so resolve it by hand. */
function loadEsbuild(): { build: (options: Record<string, unknown>) => Promise<unknown>; version: string } {
  const store = join(repo, 'node_modules/.pnpm')
  const versions = readdirSync(store)
    .filter(name => name.startsWith('esbuild@'))
    .map(name => name.slice('esbuild@'.length))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  for (const version of versions.reverse()) {
    const target = join(store, `esbuild@${version}/node_modules/esbuild`)
    if (!existsSync(join(target, 'package.json'))) continue
    const require = createRequire(join(target, 'package.json'))
    return { ...require('esbuild'), version }
  }
  throw Error('esbuild is not installed in node_modules/.pnpm')
}

interface ProbeCase { id: string; pass: boolean; kind?: string; detail?: string; skipped?: boolean; skipReason?: string; ms?: number }
interface ProbeIdentity { entrySha256?: string; preloadSha256?: string; barHtmlSha256?: string; sourceRef?: string; command?: string }
interface ProbeResult { pass: boolean; cases: ProbeCase[]; timing?: { totalMs: number }; identity?: ProbeIdentity; artifacts?: Record<string, unknown> }

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repo, env, windowsHide: true })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    const timer = setTimeout(() => { child.kill(); rejectRun(Error(`probe did not finish within ${PROBE_TIMEOUT_MS} ms`)) }, PROBE_TIMEOUT_MS)
    child.on('error', error => { clearTimeout(timer); rejectRun(error) })
    child.on('exit', code => { clearTimeout(timer); resolveRun({ code, output }) })
  })
}

describe.skipIf(missing.length > 0)(`real bar playback probe${missing.length > 0 ? ` (skipped: missing ${missing.join(', ')})` : ''}`, () => {
  it('plays, replaces, cancels, speaks and ends audio in the built pill', async () => {
    const esbuild = loadEsbuild()
    mkdirSync(OUT, { recursive: true })
    const bundle = join(OUT, 'probe.cjs')
    const resultFile = join(OUT, 'result.json')
    // A previous run must not be able to hand back its pass.
    rmSync(resultFile, { force: true })
    await esbuild.build({
      entryPoints: [join(repo, 'src/main/bar-playback.probe.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      alias: { '@shared': join(repo, 'src/shared') },
      logLevel: 'silent'
    })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run_ = await run(ELECTRON, [bundle], env)
    const raw = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : ''
    const result = raw ? JSON.parse(raw) as ProbeResult : null
    const report = result ? result.cases.map(entry => `${entry.pass ? 'ok' : entry.skipped ? 'SKIP' : 'FAIL'} ${entry.id} (${entry.ms ?? '?'} ms) — ${entry.detail ?? ''}`).join('\n') : '<no result.json>'
    expect(run_.code, `probe failed:\n${report}\n${run_.output.slice(-3000)}`).toBe(0)
    expect(result, 'the probe wrote no result.json').not.toBeNull()
    expect(result?.pass).toBe(true)
    expect(result?.cases.length).toBeGreaterThanOrEqual(10)
    expect(result?.cases.every(entry => entry.pass === true && entry.skipped !== true)).toBe(true)
    expect(result?.cases.every(entry => entry.kind === 'real-window' || entry.kind === 'stub')).toBe(true)
    expect(result?.cases.every(entry => typeof entry.ms === 'number' && entry.ms >= 0)).toBe(true)
    const ids = result?.cases.map(entry => entry.id) ?? []
    for (const id of REQUIRED_IDS) expect(ids, `missing required probe case ${id}`).toContain(id)
    // The evidence has to name the build it was produced from, or R4's gate
    // cannot tell this result from one produced by another binary.
    const identity = result?.identity
    expect(identity?.entrySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(identity?.preloadSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(identity?.barHtmlSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(identity?.entrySha256).toBe(sha256(MAIN_ENTRY))
    expect(identity?.preloadSha256).toBe(sha256(PRELOAD))
    expect(identity?.barHtmlSha256).toBe(sha256(BAR_HTML))
    expect(identity?.sourceRef?.length ?? 0).toBeGreaterThan(0)
    expect(identity?.command?.length ?? 0).toBeGreaterThan(0)
  }, PROBE_TIMEOUT_MS + 30_000)
})
