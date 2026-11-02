import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const executable = resolve('native/bin/yu-windows.exe')

it('rejects unknown operations and invalid audio parameters before touching any endpoint', () => {
  for (const [request, expected] of [[{ action: 'run', command: 'not allowed' }, 'Unknown operation'],
    [{ action: 'system-volume', volume: -1 }, 'Volume must be 0-100'],
    [{ action: 'system-volume', volume: 50, muted: 'false' }, 'Muted must be boolean']] as const) {
    const result = spawnSync(executable, [], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain(expected)
  }
})

it('exits when its declared owner dies even while another process keeps its stdin open', async () => {
  const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
  await once(owner, 'spawn')
  const child = spawn(executable, ['--parent-pid', String(owner.pid)], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  const timer = setTimeout(() => child.kill(), 3000)
  try {
    await once(child, 'spawn')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(child.exitCode).toBeNull()
    const closed = once(child, 'close'), at = performance.now()
    owner.kill()
    expect((await closed)[0]).toBe(0)
    expect(performance.now() - at).toBeLessThan(1500)
  } finally {
    clearTimeout(timer); child.kill(); owner.kill()
  }
})
