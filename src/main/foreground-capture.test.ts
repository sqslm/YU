import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ rows: [] as Array<{ id: number; pid: number; title: string; className?: string; hidden?: boolean; minimized?: boolean }> }))
vi.mock('koffi', () => ({ default: {
  proto: () => 0, address: (handle: number) => BigInt(handle),
  load: () => ({ func: (signature: string) => {
    const name = /([\w]+)\(/u.exec(signature)![1]
    return (handle: number, buffer: Buffer) => {
      const row = native.rows.find(row => row.id === handle)
      if (name === 'GetForegroundWindow') return native.rows[0]?.id ?? 0
      if (name === 'GetWindow') return native.rows[native.rows.findIndex(row => row.id === handle) + 1]?.id ?? 0
      if (name === 'GetWindowThreadProcessId') { buffer.writeUInt32LE(row?.pid ?? 0); return 1 }
      if (name === 'IsWindowVisible') return row && !row.hidden ? 1 : 0
      if (name === 'IsIconic') return row?.minimized ? 1 : 0
      if (name === 'GetWindowTextW' || name === 'GetClassNameW') {
        const value = name === 'GetWindowTextW' ? row?.title ?? '' : row?.className ?? 'Chrome_WidgetWin_1'
        buffer.write(value, 'utf16le'); return value.length
      }
      return 0
    }
  } })
} }))
import { foregroundWindow } from './foreground'

beforeEach(() => { native.rows = [{ id: 11, pid: process.pid, title: '语' }, { id: 16, pid: 42, title: 'Actual GitHub page' }] })

it('keeps YU as the normal insertion target but resolves its underlying external content window', () => {
  expect(foregroundWindow()).toMatchObject({ handle: '11', pid: process.pid, title: '语' })
  expect(foregroundWindow(true)).toMatchObject({ handle: '16', pid: 42, title: 'Actual GitHub page' })
})

it('skips YU surfaces, shell, hidden, minimized and untitled windows in actual Z order', () => {
  native.rows.splice(1, 0,
    { id: 12, pid: 7, title: 'Desktop', className: 'WorkerW' }, { id: 13, pid: 8, title: '' },
    { id: 14, pid: 9, title: 'Hidden', hidden: true }, { id: 15, pid: 10, title: 'Minimized', minimized: true },
    { id: 17, pid: process.pid, title: 'Ask' })
  expect(foregroundWindow(true)).toMatchObject({ handle: '16', pid: 42 })
})

it('returns no readable target when only YU windows remain', () => {
  native.rows = [{ id: 11, pid: process.pid, title: '语' }]
  expect(foregroundWindow(true)).toMatchObject({ pid: 0, title: '' })
})
