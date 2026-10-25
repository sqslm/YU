import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autoUpdater } from 'electron-updater'

/**
 * Feed resolution (REQ-13). The updater must be honest about *why* it did not
 * check: "no feed configured" is a different answer from "up to date", and an
 * air-gapped install must not touch the network at all.
 */

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn((name: string, callback: (...args: any[]) => void) => mocks.handlers.set(name, callback)),
  handlers: new Map<string, (...args: any[]) => void>(),
  download: vi.fn(), version: '0.9.0'
}))

vi.mock('electron', () => ({
  app: { getVersion: () => mocks.version, isPackaged: true }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: mocks.checkForUpdates,
    setFeedURL: mocks.setFeedURL,
    on: mocks.on,
    downloadUpdate: mocks.download,
    allowDowngrade: false,
    set channel(_value: string) { this.allowDowngrade = true },
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    quitAndInstall: vi.fn()
  }
}))

const { DEFAULT_FEED_URL, Updater, canSelfUpdate, resolveFeedUrl, isNewerVersion } = await import(
  './updater'
)
beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); mocks.version = '0.9.0' })

it.each([
  ['1.0.0-rc.2', '1.0.0-rc.1', true],
  ['1.0.0-rc.10', '1.0.0-rc.2', true],
  ['1.0.0-rc.8', '1.0.0-rc.11', false],
  ['1.0.0', '1.0.0-rc.2', true],
  ['1.0.0-rc.2', '1.0.0', false],
  ['1.0.0-rc.1', '1.0.0-rc.2', false],
  ['1.0.0+new', '1.0.0+old', false]
])('compares release precedence for %s after %s', (next, current, expected) => {
  expect(isNewerVersion(next, current)).toBe(expected)
})

const options = (userDataPath = join(tmpdir(), 'nope')) => ({
  log: vi.fn(),
  userDataPath,
  onAvailable: vi.fn(),
  onDownloaded: vi.fn(),
  onError: vi.fn()
})

describe('resolveFeedUrl', () => {
  it('prefers the environment variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeless-feed-'))
    writeFileSync(join(dir, 'update-feed.txt'), 'https://file.test/u')
    expect(resolveFeedUrl({ TYPELESS_UPDATE_URL: 'https://env.test/u' }, dir)).toBe(
      'https://env.test/u'
    )
  })

  it('falls back to update-feed.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeless-feed-'))
    writeFileSync(join(dir, 'update-feed.txt'), 'https://file.test/u\n')
    expect(resolveFeedUrl({}, dir)).toBe('https://file.test/u')
  })

  it('falls back to the project GitHub feed when no override exists', () => {
    // The released builds must be able to find their own updates: the feed is the
    // repository's `releases/latest/download` URL unless an override says otherwise.
    expect(resolveFeedUrl({}, join(tmpdir(), 'typeless-missing-dir'))).toBe(DEFAULT_FEED_URL)
    expect(resolveFeedUrl({})).toBe(DEFAULT_FEED_URL)
    expect(DEFAULT_FEED_URL).toBe('https://github.com/sqslm/YU/releases/latest/download')
  })

  it('honours the hard opt-out even when a URL is set', () => {
    expect(
      resolveFeedUrl({ TYPELESS_NO_UPDATE: '1', TYPELESS_UPDATE_URL: 'https://env.test/u' })
    ).toBeNull()
  })
})

describe('canSelfUpdate', () => {
  it('only updates packaged builds', () => {
    expect(canSelfUpdate(true)).toBe(true)
    expect(canSelfUpdate(false)).toBe(false)
  })
})

describe('Updater.check', () => {
  it('downloads and accepts a genuinely newer release after rejecting a stale event', async () => {
    mocks.version = '1.0.0-rc.11'
    mocks.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '1.0.0-rc.12' } })
    const callbacks = options(), updater = new Updater(callbacks)
    await updater.check()
    expect((await updater.download()).ok).toBe(true)
    expect(mocks.download).toHaveBeenCalledOnce()
    mocks.handlers.get('update-downloaded')!({ version: '1.0.0-rc.8' })
    expect(callbacks.onDownloaded).not.toHaveBeenCalled()
    mocks.handlers.get('update-downloaded')!({ version: '1.0.0-rc.12' })
    expect(callbacks.onDownloaded).toHaveBeenCalledExactlyOnceWith('1.0.0-rc.12')
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
  })
  it('disables downgrade after selecting the prerelease channel and suppresses older event notifications', async () => {
    mocks.version = '1.0.0-rc.11'
    mocks.checkForUpdates.mockImplementationOnce(async () => {
      mocks.handlers.get('update-available')!({ version: '1.0.0-rc.8' })
      return { updateInfo: { version: '1.0.0-rc.8' } }
    })
    const callbacks = options(), updater = new Updater(callbacks)
    expect(await updater.check()).toEqual({ ok: true, status: 'none' })
    expect(autoUpdater.allowDowngrade).toBe(false)
    expect(callbacks.onAvailable).not.toHaveBeenCalled()
    expect(updater.getState()).toMatchObject({ phase: 'up-to-date', currentVersion: '1.0.0-rc.11' })
    expect((await updater.download()).ok).toBe(false)
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it('rejects stale downloaded events and never installs an older cached release', async () => {
    mocks.version = '1.0.0-rc.11'
    mocks.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '1.0.0-rc.8' } })
    const callbacks = options(), updater = new Updater(callbacks)
    await updater.check()
    mocks.handlers.get('update-downloaded')!({ version: '1.0.0-rc.8' })
    expect(callbacks.onDownloaded).not.toHaveBeenCalled()
    expect(updater.install()).toBe(false)
  })
  it('never contacts the network when checks are switched off', async () => {
    const log = vi.fn()
    const updater = new Updater({ ...options(join(tmpdir(), 'typeless-missing-dir')), log })
    const saved = process.env.TYPELESS_NO_UPDATE
    process.env.TYPELESS_NO_UPDATE = '1'
    try {
      const result = await updater.check()
      expect(result).toMatchObject({ ok: false, status: 'not-configured' })
      expect(mocks.checkForUpdates).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('[update] skipped: checks disabled')
      expect(updater.getState().phase).toBe('disabled')
    } finally {
      if (saved === undefined) delete process.env.TYPELESS_NO_UPDATE
      else process.env.TYPELESS_NO_UPDATE = saved
    }
  })

  it('falls back to the project feed and reports the available version', async () => {
    mocks.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.0.0' } })
    const updater = new Updater(options())
    const result = await updater.check()
    // With no override the installed build checks the repository's own releases,
    // otherwise a shipped app could never learn that a newer one exists.
    expect(mocks.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: DEFAULT_FEED_URL })
    expect(result).toEqual({ ok: true, status: 'available', version: '1.0.0' })
    expect(updater.getState()).toMatchObject({ phase: 'available', version: '1.0.0' })
  })

  it('passes the configured URL to electron-updater', async () => {
    mocks.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.0.0' } })
    const dir = mkdtempSync(join(tmpdir(), 'typeless-feed-'))
    writeFileSync(join(dir, 'update-feed.txt'), 'https://file.test/u')
    const updater = new Updater(options(dir))
    const result = await updater.check()
    expect(mocks.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://file.test/u' })
    expect(result).toEqual({ ok: true, status: 'available', version: '1.0.0' })
  })

  it('turns a thrown check into a failed result instead of crashing', async () => {
    mocks.checkForUpdates.mockRejectedValue(new Error('ENOTFOUND feed.test'))
    const dir = mkdtempSync(join(tmpdir(), 'typeless-feed-'))
    writeFileSync(join(dir, 'update-feed.txt'), 'https://file.test/u')
    const updater = new Updater(options(dir))
    const result = await updater.check()
    expect(result).toMatchObject({ ok: false, status: 'error' })
  })
})
