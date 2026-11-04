import { describe, expect, it } from 'vitest'
import { descendantsOf, listProcessTable } from './process-table.mjs'

describe('descendantsOf', () => {
  const table = [
    { pid: 10, ppid: 1, name: 'root' },
    { pid: 11, ppid: 10, name: 'gpu' },
    { pid: 12, ppid: 10, name: 'utility' },
    { pid: 13, ppid: 12, name: 'renderer', cmd: '--type=renderer' },
    { pid: 14, ppid: 13, name: 'helper' },
    { pid: 20, ppid: 1, name: 'unrelated' },
    { pid: 21, ppid: 20, name: 'unrelated-child' }
  ]

  it('walks the whole subtree and keeps table fields', () => {
    const found = descendantsOf(table, 10)
    expect(found.map((proc) => proc.pid)).toEqual([11, 12, 13, 14])
    expect(found.find((proc) => proc.pid === 13).cmd).toBe('--type=renderer')
  })

  it('never leaves the root subtree', () => {
    const pids = descendantsOf(table, 10).map((proc) => proc.pid)
    expect(pids).not.toContain(20)
    expect(pids).not.toContain(21)
  })

  it('tolerates a cycle in the parent chain', () => {
    const cyclic = [
      { pid: 30, ppid: 31, name: 'a' },
      { pid: 31, ppid: 30, name: 'b' }
    ]
    expect(descendantsOf(cyclic, 30).map((proc) => proc.pid)).toEqual([31])
  })

  it('returns nothing for an empty table', () => {
    expect(descendantsOf([], 10)).toEqual([])
    expect(descendantsOf(undefined, 10)).toEqual([])
  })
})

describe.skipIf(process.platform !== 'win32')('listProcessTable', () => {
  it('sees this process with its real parent', () => {
    const table = listProcessTable()
    const self = table.find((proc) => proc.pid === process.pid)
    expect(self).toBeDefined()
    expect(self.ppid).toBe(process.ppid)
    expect(self.name.toLowerCase()).toBe('node.exe')
  })

  it('is fast enough to poll inside a timing window', () => {
    listProcessTable()
    const started = performance.now()
    for (let index = 0; index < 3; index += 1) listProcessTable()
    const perCallMs = (performance.now() - started) / 3
    expect(perCallMs).toBeLessThan(60)
  })
})
