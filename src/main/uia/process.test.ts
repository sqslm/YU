import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'

const executable = resolve('native/bin/yu-uia.exe')

it('initializes real COM, rejects a mismatched target before reading and exits on EOF', async () => {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill(), 4000)
  try {
    const [ready] = await once(lines, 'line')
    expect(JSON.parse(ready)).toEqual({ type: 'ready' })
    const reply = once(lines, 'line')
    child.stdin.write(JSON.stringify({ type: 'read', id: 17, target: { processId: 0, windowHandle: '0', windowTitle: 'synthetic missing target' } }) + '\n')
    const [result] = await reply
    expect(JSON.parse(result)).toEqual({ type: 'result', id: 17, snapshot: null })
    const closed = once(child, 'close'); child.stdin.end()
    expect((await closed)[0]).toBe(0)
  } finally { clearTimeout(timer); lines.close(); child.kill() }
})

it('rejects malformed pipe input and terminates without logging the message body', async () => {
  const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill(), 4000)
  let error = ''
  child.stderr.on('data', value => { error += value })
  try {
    await once(lines, 'line')
    const closed = once(child, 'close')
    child.stdin.write('private-body-not-json\n')
    expect((await closed)[0]).toBe(1)
    expect(error).toContain('invalid input pipe message')
    expect(error).not.toContain('private-body-not-json')
  } finally { clearTimeout(timer); lines.close(); child.kill() }
})
