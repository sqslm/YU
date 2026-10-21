/** Create source/server archives from the exact committed release, without local data. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
if (git('status', '--porcelain')) throw new Error('Commit the release changes before archiving.')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const serverVersion = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8')).version
const output = join(root, 'release')
mkdirSync(output, { recursive: true })
const installer = `Typeless Rebuild-${version}-setup.exe`
if (!existsSync(join(output, installer))) throw new Error('Run pnpm package before creating release archives.')
const source = `typeless-rebuild-${version}-source.zip`
const server = `typeless-server-${serverVersion}.tar.gz`
git('archive', '--format=zip', `--prefix=typeless-rebuild-${version}/`, `--output=${join(output, source)}`, 'HEAD')
git('archive', '--format=tar.gz', `--prefix=typeless-server-${serverVersion}/`, `--output=${join(output, server)}`, 'HEAD:server')

const files = []
for (const name of [installer, `${installer}.blockmap`, 'latest.yml', source, server]) {
  const file = join(output, name)
  if (!existsSync(file)) throw new Error(`Missing release artifact: ${name}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  files.push({ name, bytes: statSync(file).size, sha256: hash.digest('hex') })
}
writeFileSync(join(output, `SHA256SUMS-${version}.txt`), files.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n') + '\n')
writeFileSync(join(output, `release-${version}.json`), JSON.stringify({
  clientVersion: version, serverVersion, protocolVersion: 1, commit: git('rev-parse', 'HEAD'), files
}, null, 2) + '\n')
console.log(`Created ${source}, ${server}, SHA256SUMS-${version}.txt and release-${version}.json`)
