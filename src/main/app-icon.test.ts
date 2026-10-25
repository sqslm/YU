import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

/**
 * A toast without a picture is still a toast.
 *
 * Windows paints Electron's own atom logo on a notification that carries no
 * icon, so every toast asks for ours — but the reminder path must never lose
 * the notification itself because the icon file was missing or unreadable.
 */
const mock = vi.hoisted(() => ({
  appPath: 'C:/app',
  image: { isEmpty: () => false } as { isEmpty: () => boolean },
  throwOnCreate: false,
  packaged: false,
  shortcutExists: false,
  readShortcut: vi.fn(), writeShortcut: vi.fn(),
  seenPath: '' as string
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => mock.appPath, getPath: () => 'C:/profiles', get isPackaged() { return mock.packaged } },
  shell: { readShortcutLink: mock.readShortcut, writeShortcutLink: mock.writeShortcut },
  nativeImage: {
    createFromPath: (path: string) => {
      mock.seenPath = path
      if (mock.throwOnCreate) throw new Error('no icon decoder')
      return mock.image
    }
  }
}))
vi.mock('node:fs', () => ({ existsSync: () => mock.shortcutExists }))

const { appIcon, appIconPath, setTaskbarIcon, repairDevelopmentShortcut } = await import('./app-icon')

describe('appIcon', () => {
  beforeEach(() => {
    mock.appPath = 'C:/app'
    mock.image = { isEmpty: () => false }
    mock.throwOnCreate = false
    mock.seenPath = ''
    mock.packaged = false
    mock.shortcutExists = false
    mock.readShortcut.mockReset(); mock.writeShortcut.mockReset().mockReturnValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads the icon from the app directory', () => {
    expect(appIconPath()).toBe(join('C:/app', 'resources', 'icon.png'))
    expect(appIcon()).toBe(mock.image)
    expect(mock.seenPath).toBe(join('C:/app', 'resources', 'icon.png'))
  })
  it.skipIf(process.platform !== 'win32')('repairs only a legacy Electron shortcut using this application production identity', () => {
    mock.shortcutExists = true
    mock.readShortcut.mockReturnValue({ target: 'C:/tools/electron.exe', appUserModelId: 'com.typeless.rebuild' })
    expect(repairDevelopmentShortcut()).toBe(true)
    expect(mock.writeShortcut).toHaveBeenCalledExactlyOnceWith(join('C:/profiles','Microsoft','Windows','Start Menu','Programs','Electron.lnk'), 'update', { target: 'C:/tools/electron.exe', appUserModelId: 'com.typeless.rebuild.dev' })
    mock.writeShortcut.mockClear()
    mock.readShortcut.mockReturnValue({ target: 'C:/other/electron.exe', appUserModelId: 'other.app' })
    expect(repairDevelopmentShortcut()).toBe(false)
    mock.readShortcut.mockReturnValue({ target: 'C:/installed/YU.exe', appUserModelId: 'com.typeless.rebuild' })
    expect(repairDevelopmentShortcut()).toBe(false)
    expect(mock.writeShortcut).not.toHaveBeenCalled()
  })

  it('returns undefined when the image is empty', () => {
    mock.image = { isEmpty: () => true }
    expect(appIcon()).toBeUndefined()
  })
  it.skipIf(process.platform !== 'win32')('gives the taskbar a real ICO path and relaunch command in development and packages', () => {
    const details = vi.fn()
    const setIcon = vi.fn()
    setTaskbarIcon({ setAppDetails: details, setIcon } as never)
    expect(setIcon).toHaveBeenCalledWith(mock.image)
    expect(details.mock.calls[0][0]).not.toHaveProperty('appId')
    expect(details).toHaveBeenNthCalledWith(1, expect.objectContaining({
      appIconPath: join(mock.appPath, 'resources', 'app.ico'), relaunchCommand: `"${process.execPath}" "${mock.appPath}"`, relaunchDisplayName: 'YU' }))
    expect(details).toHaveBeenNthCalledWith(2, { appId: 'com.typeless.rebuild.dev' })
    mock.packaged = true
    vi.stubGlobal('process', { ...process, resourcesPath: 'C:/installed/resources' })
    try {
      setTaskbarIcon({ setAppDetails: details, setIcon } as never)
      expect(details).toHaveBeenNthCalledWith(3, expect.objectContaining({ appIconPath: join('C:/installed/resources', 'shortcut.ico'), relaunchCommand: `"${process.execPath}"` }))
    } finally { vi.unstubAllGlobals() }
  })

  it('returns undefined instead of throwing when the decoder fails', () => {
    mock.throwOnCreate = true
    expect(appIcon()).toBeUndefined()
  })
})
