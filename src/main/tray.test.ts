import { beforeEach, expect, it, vi } from 'vitest'
import { setMainLanguage } from '@shared/mainI18n'
import { createTray } from './tray'

const mocks = vi.hoisted(() => ({ on: vi.fn(), menu: vi.fn(), tooltip: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  nativeImage: { createFromPath: () => ({ resize: () => ({ isEmpty: () => false }) }) },
  Menu: { buildFromTemplate: (items: unknown) => items },
  Tray: class { on = mocks.on; setContextMenu = mocks.menu; setToolTip = mocks.tooltip },
  Notification: class { show(): void {} }
}))
const handlers = () => ({ openMain: vi.fn(), openAsk: vi.fn(), openNotes: vi.fn(), openReminders: vi.fn(), openSettings: vi.fn(),
  status: () => 'Ready', toggleHotkeys: () => true, hotkeysEnabled: () => true, quit: vi.fn() })
beforeEach(() => { vi.clearAllMocks(); setMainLanguage('zh') })
const menu = () => mocks.menu.mock.calls.at(-1)![0] as { label?: string; click?: () => void }[]

it('opens the main application on a left click, independently of the assistant', () => {
  const actions = handlers(); createTray(actions)
  const click = mocks.on.mock.calls.find(call => call[0] === 'click')![1] as () => void
  click()
  expect(actions.openMain).toHaveBeenCalledOnce()
  expect(actions.openAsk).not.toHaveBeenCalled()
})

it('provides separate main-window, assistant and settings menu actions', () => {
  const actions = handlers(); createTray(actions)
  menu().find(item => item.label === '打开主界面')!.click!()
  expect(actions.openMain).toHaveBeenCalledOnce()
  expect(actions.openAsk).not.toHaveBeenCalled()
  menu().find(item => item.label === 'Ask')!.click!()
  menu().find(item => item.label === '设置…')!.click!()
  expect(actions.openAsk).toHaveBeenCalledOnce()
  expect(actions.openSettings).toHaveBeenCalledOnce()
})

it('refreshes the main-window label when the language changes, without rebuilding unchanged menus', () => {
  const tray = createTray(handlers())
  tray.refresh(); expect(mocks.menu).toHaveBeenCalledTimes(1)
  setMainLanguage('en'); tray.refresh()
  expect(menu().map(item => item.label)).toContain('Open main window')
  expect(menu().map(item => item.label)).toContain('Ask')
})
