import { describe, expect, it } from 'vitest'
import { collectResources } from './resources'

function metric(pid: number, type: string, name?: string): Electron.ProcessMetric {
  return { pid, type, name, memory: { workingSetSize: 100, peakWorkingSetSize: 200, privateBytes: 300 } } as Electron.ProcessMetric
}
const model = { loaded: false, autoResume: true }

describe('resource measurement', () => {
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
