import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'

const executable = resolve('native/bin/yu-hotkey.exe')

it('installs a real unbound hook and exits when the owning pipe closes', async () => {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill(), 3000)
  try {
    const [line] = await once(lines, 'line')
    expect(JSON.parse(line)).toEqual({ type: 'ready' })
    const closed = once(child, 'close')
    child.stdin.end()
    const [code] = await closed
    expect(code).toBe(0)
  } finally { clearTimeout(timer); lines.close(); child.kill() }
})

it('rejects an invalid configuration and releases the real hook', async () => {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill(), 3000)
  let error = ''
  child.stderr.on('data', value => { error += value })
  try {
    await once(lines, 'line')
    const closed = once(child, 'close')
    child.stdin.write(JSON.stringify({ type: 'config', bindings: { dictation: ['invalid-key'] } }) + '\n')
    const [code] = await closed
    expect(code).toBe(1)
    expect(error).toContain('unknown key token: invalid-key')
  } finally { clearTimeout(timer); lines.close(); child.kill() }
})
