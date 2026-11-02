import { describe, expect, it } from 'vitest'
import { collectResources } from './resources'

function metric(pid: number, type: string, name?: string): Electron.ProcessMetric {
  return { pid, type, name, memory: { workingSetSize: 100, peakWorkingSetSize: 200, privateBytes: 300 } } as Electron.ProcessMetric
}
const model = { loaded: false, autoResume: true }

describe('resource measurement', () => {
  it('includes the native UIA PID and deduplicates it independently of the hotkey PID', () => {
    const read = (pid: number) => ({ privateResidentBytes: pid * 10, workingSetBytes: pid * 20, committedBytes: pid * 30 })
    const result = collectResources([metric(1, 'Browser')], model, read, 7, 8)
    expect(result.processes.map(p => [p.pid, p.role])).toEqual([[1, 'main'], [7, 'hotkeys'], [8, 'context']])
    expect(result.privateResidentBytes).toBe(160)
    expect(result.workingSetBytes).toBe(320)
    expect(result.committedBytes).toBe(480)
    expect(collectResources([metric(8, 'Utility', 'typeless-uia')], model, read, undefined, 8).processes).toHaveLength(1)
    expect(collectResources([], model, () => null, undefined, 8).workingSetBytes).toBeNull()
  })
  it('includes the native hotkey PID in every total without double counting it', () => {
    const read = (pid: number) => ({ privateResidentBytes: pid * 10, workingSetBytes: pid * 20, committedBytes: pid * 30 })
    const result = collectResources([metric(1, 'Browser')], model, read, 7)
    expect(result.processes).toEqual([
      expect.objectContaining({ pid: 1, role: 'main' }),
      expect.objectContaining({ pid: 7, role: 'hotkeys' })
    ])
    expect(result.privateResidentBytes).toBe(80)
    expect(result.workingSetBytes).toBe(160)
    expect(result.committedBytes).toBe(240)
    expect(collectResources([metric(7, 'Utility', 'typeless-hotkey')], model, read, 7).processes).toHaveLength(1)
  })
  it('keeps an unreadable native process visible and marks incomplete totals unavailable', () => {
    const result = collectResources([metric(1, 'Browser')], model, () => null, 7)
    expect(result.processes[1]).toEqual({ pid: 7, role: 'hotkeys', privateResidentBytes: null, workingSetBytes: null, committedBytes: null })
    expect(result.privateResidentBytes).toBeNull()
    expect(result.workingSetBytes).toBeNull()
    expect(result.committedBytes).toBeNull()
  })
  it('identifies the memory process separately from auxiliary processes', () => {
    expect(collectResources([metric(7, 'Utility', 'YU memory')], model, () => null).processes[0].role).toBe('memory')
  })
  it('sums private resident, working set and commit independently across every process', () => {
    const result = collectResources([metric(1, 'Browser'), metric(2, 'GPU'), metric(3, 'Utility', 'typeless-local-asr')], model,
      pid => ({ privateResidentBytes: pid * 10, workingSetBytes: pid * 20, committedBytes: pid * 30 }))
    expect(result.privateResidentBytes).toBe(60)
    expect(result.workingSetBytes).toBe(120)
    expect(result.committedBytes).toBe(180)
    expect(result.processes.map(p => p.role)).toEqual(['main', 'graphics', 'localModel'])
    expect(result.localModel).toEqual(model)
  })

  it('never labels commit as private resident or counts an unavailable process as zero', () => {
    const result = collectResources([metric(1, 'Tab'), metric(2, 'Utility', 'typeless-hotkey')], model,
      pid => pid === 1 ? { privateResidentBytes: 10, workingSetBytes: 20, committedBytes: 30 } : null)
    expect(result.privateResidentBytes).toBeNull()
    expect(result.workingSetBytes).toBe(20 + 100 * 1024)
    expect(result.committedBytes).toBe(30 + 300 * 1024)
    expect(result.processes[1]).toMatchObject({ role: 'hotkeys', privateResidentBytes: null })
  })
})
