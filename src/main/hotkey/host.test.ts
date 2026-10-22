import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'

const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }))
import { HotkeyHost } from './host'

describe('shortcut recording suspension', () => {
  beforeEach(() => vi.clearAllMocks())
  it('temporarily disables capture without changing the persisted enabled flag and respects settings updates', () => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    mock.fork.mockReturnValue(child)
    const host = new HotkeyHost(vi.fn()), settings = mergeSettings({})
    host.start(settings); child.emit('message', { type: 'ready' })
    host.setCapturing(true)
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'enabled', value: false })
    host.apply(settings)
    expect(child.postMessage.mock.calls.filter(call => call[0].type === 'enabled').at(-1)?.[0].value).toBe(false)
    host.setCapturing(false)
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'enabled', value: true })
    host.apply({ ...settings, hotkeys: { ...settings.hotkeys, enabled: false } })
    host.setCapturing(true); host.setCapturing(false)
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'enabled', value: false })
    expect(settings.hotkeys.enabled).toBe(true)
    host.stop()
  })
})
