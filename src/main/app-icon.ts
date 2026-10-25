import { app, nativeImage, shell, type BrowserWindow, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Development notifications must never register Electron under the installed app's identity. */
export function appUserModelId(): string {
  return app.isPackaged ? 'com.typeless.rebuild' : 'com.typeless.rebuild.dev'
}

/** Repair only the legacy Electron shortcut that this app registered with its production ID. */
export function repairDevelopmentShortcut(): boolean {
  if (process.platform !== 'win32') return false
  const file = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Electron.lnk')
  if (!existsSync(file)) return false
  const shortcut = shell.readShortcutLink(file)
  if (shortcut.appUserModelId !== 'com.typeless.rebuild' || basename(shortcut.target).toLowerCase() !== 'electron.exe') return false
  if (!shell.writeShortcutLink(file, 'update', { target: shortcut.target, appUserModelId: 'com.typeless.rebuild.dev' })) throw new Error('Cannot repair the legacy development shortcut identity')
  return true
}

/**
 * Our icon, for the places Windows would otherwise fill in with Electron's own
 * atom logo.
 *
 * A Windows toast takes its picture from the notification itself; without one
 * the shell falls back to the host executable's icon, which is why update and
 * reminder toasts used to show the Electron logo instead of 语.
 */
export function appIconPath(): string {
  return join(app.getAppPath(), 'resources', 'icon.png')
}

/** The Windows shell cannot read icons inside app.asar, and dev runs host electron.exe. */
export function setTaskbarIcon(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'shortcut.ico') : join(app.getAppPath(), 'resources', 'app.ico')
  win.setIcon(nativeImage.createFromPath(iconPath))
  // Windows requires relaunch properties before the explicit window AppUserModelID.
  win.setAppDetails({
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`,
    relaunchDisplayName: 'YU'
  })
  win.setAppDetails({ appId: appUserModelId() })
}

/**
 * `icon` for Notification options: omitted rather than blank when the file is
 * missing. It never throws — a toast without a picture is still a toast, and
 * the reminder path must not lose the notification itself over an icon.
 */
export function appIcon(): NativeImage | undefined {
  try {
    const image = nativeImage.createFromPath(appIconPath())
    return image.isEmpty() ? undefined : image
  } catch {
    return undefined
  }
}
