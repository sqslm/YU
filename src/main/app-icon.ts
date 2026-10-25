import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { join } from 'node:path'

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
  win.setAppDetails({
    appId: 'com.typeless.rebuild',
    appIconPath: app.isPackaged ? join(process.resourcesPath, 'shortcut.ico') : join(app.getAppPath(), 'resources', 'app.ico'),
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`,
    relaunchDisplayName: 'YU'
  })
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
