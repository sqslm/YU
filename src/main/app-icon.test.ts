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
  seenPath: '' as string
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => mock.appPath },
  nativeImage: {
    createFromPath: (path: string) => {
      mock.seenPath = path
      if (mock.throwOnCreate) throw new Error('no icon decoder')
      return mock.image
    }
  }
}))

const { appIcon, appIconPath } = await import('./app-icon')

describe('appIcon', () => {
  beforeEach(() => {
    mock.appPath = 'C:/app'
    mock.image = { isEmpty: () => false }
    mock.throwOnCreate = false
    mock.seenPath = ''
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads the icon from the app directory', () => {
    expect(appIconPath()).toBe(join('C:/app', 'resources', 'icon.png'))
    expect(appIcon()).toBe(mock.image)
    expect(mock.seenPath).toBe(join('C:/app', 'resources', 'icon.png'))
  })

  it('returns undefined when the image is empty', () => {
    mock.image = { isEmpty: () => true }
    expect(appIcon()).toBeUndefined()
  })

  it('returns undefined instead of throwing when the decoder fails', () => {
    mock.throwOnCreate = true
    expect(appIcon()).toBeUndefined()
  })
})
