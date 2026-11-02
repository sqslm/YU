import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = resolve(root, 'native/hotkey/Cargo.toml')
const test = process.argv.includes('--test')
if (!test && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('The production helper requires Windows x64')
const args = test ? ['test', '--locked'] : ['build', '--release', '--locked']
// Use the crate directory so Cargo reads its scoped static-CRT configuration.
const result = spawnSync('cargo', [...args, '--manifest-path', manifest], { cwd: dirname(manifest), stdio: 'inherit', windowsHide: true })
if (result.error) throw new Error('Rust MSVC toolchain is required to build YU: ' + result.error.message)
if (result.status !== 0) process.exit(result.status ?? 1)
if (!test) {
  const output = resolve(root, 'native/bin')
  mkdirSync(output, { recursive: true })
  copyFileSync(resolve(root, 'native/hotkey/target/release/yu-hotkey.exe'), resolve(output, 'yu-hotkey.exe'))
}
