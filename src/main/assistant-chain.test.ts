import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeSettings } from '@shared/defaults'
import { AssistantSession } from './assistant'
import { WindowsTools } from './tools/windows'
import { ReminderStore } from './reminders'
import { runTool } from './tools/registry'
import { PERSONAL_TOOLS, type PersonalTools } from './tools/personal'
import { createTask, attachTask } from './task-context'

it('opens the actual second search result, then its parent without another model or invented path', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'yu-reference-')))
  try {
    const paths = [join(root, 'one.pdf'), join(root, 'two.pdf')]
    for (const path of paths) await writeFile(path, 'owned fixture')
    const openPath = vi.fn().mockResolvedValue(''), ask = vi.fn()
    const windows = new WindowsTools({ folders: { downloads: root, desktop: root, documents: root },
      native: async () => ({ files: paths.map(path => ({ name: path.split(/[\\/]/).at(-1), path, bytes: 13 })), backend: 'folder' }),
      openPath, openUrl: vi.fn() })
    const settings = mergeSettings({}), session = new AssistantSession({ settings: () => settings, windows, ask, changed: () => {}, log: () => {} })
    await session.send('查找 PDF', undefined, { name: 'search_files', args: {} })
    const items = session.snapshot().turns.at(-1)?.localResults?.[0].items
    expect(items).toHaveLength(2)
    const second = items![1]
    await session.send('打开第二个')
    expect(openPath).toHaveBeenLastCalledWith(second.path)
    await session.send('把它所在的文件夹也打开')
    expect(openPath).toHaveBeenLastCalledWith(root)
    expect(openPath).toHaveBeenCalledTimes(2); expect(ask).not.toHaveBeenCalled()
    expect(session.snapshot().turns.at(-1)).toMatchObject({ state: 'done', taskState: 'completed' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('edits, strengthens, cancels and restores the same actual SQLite reminder without stale cached success', async () => {
  const store = new ReminderStore(':memory:')
  try {
    const row = store.save({ title: '打扫卫生', dueAt: Date.now() + 600_000, level: 'normal', recurrence: null, source: 'manual' })
    const personal = { reminders: () => store.list(), saveReminder: (input, id) => store.save(input, id),
      action: (id, action, minutes) => store.action(id, action as 'cancel', minutes) } as Pick<PersonalTools, 'reminders' | 'saveReminder' | 'action'> as PersonalTools
    const context = attachTask({}, createTask('text', {}, '修改已有提醒'))
    const ctx = { settings: mergeSettings({}), question: '修改已有提醒', log: () => {}, personal, allowedTools: PERSONAL_TOOLS, taskContext: context }
    expect((await runTool('manage_reminder', { id: row.id, action: 'update', time_expression: '二十分钟后' }, ctx)).status).toBe('completed')
    expect(store.get(row.id)?.dueAt).toBeGreaterThan(Date.now() + 1_190_000)
    expect((await runTool('manage_reminder', { id: row.id, action: 'update', level: 'strong' }, ctx)).status).toBe('completed')
    for (const action of ['cancel', 'restore', 'cancel']) expect((await runTool('manage_reminder', { id: row.id, action }, ctx)).status).toBe('completed')
    expect(store.list()).toHaveLength(1)
    expect(store.get(row.id)).toMatchObject({ id: row.id, level: 'strong', status: 'cancelled' })
  } finally { store.close() }
})
