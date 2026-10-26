import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { ReminderStore, ReminderScheduler } from '../../src/main/reminders'

// Replay actual records produced by the main run through the real SQLite store
// and scheduler. This verifies scheduling only, never Windows notification UI.
const results: Record<string, unknown>[] = []
for (const id of ['019', '020', '025', '119', '121']) {
  it(`verifies scheduling of the actual YU-${id} record`, () => {
    const evidence = JSON.parse(readFileSync(`tests/yu-v2/evidence/YU-${id}.json`, 'utf8'))
    const title = ({ '025': '取快递', '119': '锻炼', '121': '恢复测试' } as Record<string, string>)[id]
    const row = evidence.reminders.find((r: any) => !title || r.title === title)
    expect(row).toBeDefined()
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'yu-v2-scheduler-')))
    let clock = Date.parse('2026-10-26T16:00:00+08:00')
    const delivered: any[] = []
    const store = new ReminderStore(join(directory, 'reminders.sqlite'), () => clock)
    const scheduler = new ReminderScheduler(store, item => delivered.push({ id: item.id, dueAt: item.dueAt, at: clock }), () => {}, () => clock)
    let status = 'FAIL'
    try {
      store.put(row)
      if (['019', '020', '119'].includes(id)) {
        const end = clock + 14 * 86400000
        while (clock <= end) {
          scheduler.check(); scheduler.check()
          if (store.get(row.id)?.status === 'due') store.action(row.id, 'complete')
          clock += 15 * 60000
        }
        const expectedDays = id === '019' ? [1, 3, 5] : id === '119' ? [2, 4] : [0, 1, 2, 3, 4, 5, 6]
        expect(delivered.length).toBe(id === '019' ? 6 : id === '119' ? 4 : 14)
        expect(delivered.every(r => expectedDays.includes(new Date(r.at).getDay()) && r.at === r.dueAt)).toBe(true)
        if (id === '020') expect(delivered.every(r => new Date(r.at).getHours() === 23)).toBe(true)
        expect(new Set(delivered.map(r => r.at)).size).toBe(delivered.length)
      } else {
        const before = evidence.observations.find((o: any) => o.label === 'before_after').value.before
        if (id === '025') { clock = before.dueAt; scheduler.check(); expect(delivered).toHaveLength(0) }
        clock = row.dueAt; scheduler.check(); scheduler.check()
        expect(delivered).toHaveLength(1)
        expect(delivered[0].id).toBe(row.id)
      }
      status = 'PASS'
    } finally {
      results.push({ id: `YU-${id}`, status, original_id: row.id, delivered, scope: 'real ReminderStore + ReminderScheduler, isolated SQLite; no notification UI' })
      writeFileSync('tests/yu-v2/evidence/scheduler-verification.json', JSON.stringify(results, null, 2) + '\n')
      scheduler.stop(); store.close()
      // Delete only the directory created above, after closing its database.
      if (basename(directory).startsWith('yu-v2-scheduler-') && dirname(directory).toLowerCase() === realpathSync.native(tmpdir()).toLowerCase()) rmSync(directory, { recursive: true })
    }
  })
}
