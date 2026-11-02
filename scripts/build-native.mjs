import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const test = process.argv.includes('--test')
if (!test && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('The production helper requires Windows x64')
const args = test ? ['test', '--locked'] : ['build', '--release', '--locked']
for (const name of ['hotkey', 'uia', 'windows', 'scroll']) {
  const directory = resolve(root, 'native', name)
  const manifest = resolve(directory, 'Cargo.toml')
  // The crate cwd makes Cargo read its scoped static-CRT configuration.
  const result = spawnSync('cargo', [...args, '--manifest-path', manifest], { cwd: directory, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Error('Rust MSVC toolchain is required to build YU: ' + result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  if (!test) {
    const output = resolve(root, 'native/bin')
    mkdirSync(output, { recursive: true })
    const source = resolve(directory, 'target/release', name === 'scroll' ? 'yu_scroll.dll' : `yu-${name}.exe`)
    const destination = resolve(output, name === 'scroll' ? 'yu-scroll.dll' : `yu-${name}.exe`)
    // An unchanged helper may be running in the user's app on Windows.
    if (!existsSync(destination) || !readFileSync(source).equals(readFileSync(destination))) copyFileSync(source, destination)
  }
}
