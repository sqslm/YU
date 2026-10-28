import { Menu, Notification, Tray, app, nativeTheme } from 'electron'
import { appIcon } from './app-icon'
import { join } from 'node:path'
import { mt } from '@shared/mainI18n'

export interface TrayHandlers {
  openMain: () => void
  openAsk: () => void
  openNotes: () => void
  openReminders: () => void
  status: () => string
  openSettings: () => void
  toggleHotkeys: () => boolean
  hotkeysEnabled: () => boolean
  manualGameMode?: () => boolean
  toggleGameMode?: () => void
  /** Resolves to the sentence shown to the user about update state. */
  checkUpdate?: () => Promise<string>
  /**
   * Releases modifiers the OS still thinks are held.
   *
   * Resolves to a sentence for the notification: a stuck Shift looks like the
   * whole system is broken, and the user needs to be told whether we found
   * anything to release.
   */
  resetKeyboard?: () => string
  pasteLast?: () => void
  quit: () => void
}

function iconPath(): string {
  return join(app.getAppPath(), 'resources', 'tray', nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark.ico' : 'light.ico')
}

export function createTray(handlers: TrayHandlers): Tray & { refresh: () => void } {
  const tray = new Tray(iconPath())

  let menuKey = ''
  const rebuild = (): void => {
    const key = `${handlers.status()}|${handlers.hotkeysEnabled()}|${handlers.manualGameMode?.()}|${mt('设置…')}`
    if (key === menuKey) return
    menuKey = key
    tray.setToolTip(`${mt('语')} — ${handlers.status()}`)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: handlers.status(), enabled: false },
        { type: 'separator' },
        { label: mt('打开主界面'), click: handlers.openMain },
        { label: 'Ask', click: handlers.openAsk },
        { label: mt('随记'), click: handlers.openNotes },
        { label: mt('提醒'), click: handlers.openReminders },
        { label: mt('设置…'), click: handlers.openSettings },
        { type: 'separator' },
        {
          label: mt('启用快捷键'),
          type: 'checkbox',
          checked: handlers.hotkeysEnabled(),
          click: () => {
            handlers.toggleHotkeys()
            rebuild()
          }
        },
        {
          label: mt('手动保持游戏模式'), type: 'checkbox', checked: handlers.manualGameMode?.() ?? false,
          click: () => { handlers.toggleGameMode?.(); rebuild() }
        },
        {
          label: mt('粘贴上一条听写'),
          click: () => handlers.pasteLast?.()
        },
        { type: 'separator' },
        {
          label: mt('重置键盘状态'),
          click: () => {
            const message = handlers.resetKeyboard?.() ?? mt('未处理')
            new Notification({ title: mt('语'), body: message, icon: appIcon() }).show()
          }
        },
        {
          label: mt('检查更新…'),
          click: () => {
            // A tray item must always answer: a silent click looks like a hang.
            void (handlers.checkUpdate?.() ?? Promise.resolve('更新不可用')).then((message) => {
              new Notification({ title: mt('语'), body: message, icon: appIcon() }).show()
            })
          }
        },
        { label: mt('退出'), click: handlers.quit }
      ])
    )
  }

  rebuild()
  nativeTheme.on('updated', () => tray.setImage(iconPath()))
  tray.on('click', handlers.openMain)
  return Object.assign(tray, { refresh: rebuild })
}
