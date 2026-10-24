import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * Feed resolution (REQ-13). The updater must be honest about *why* it did not
 * check: "no feed configured" is a different answer from "up to date", and an
 * air-gapped install must not touch the network at all.
 */

const mocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.9.0', isPackaged: true }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: mocks.checkForUpdates,
    setFeedURL: mocks.setFeedURL,
    on: mocks.on,
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    quitAndInstall: vi.fn()
  }
}))

const { Updater, canSelfUpdate, resolveFeedUrl, isNewerVersion } = await import('./updater')

it.each([
  ['1.0.0-rc.2', '1.0.0-rc.1', true],
  ['1.0.0-rc.10', '1.0.0-rc.2', true],
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

  it('reports nothing when neither source exists', () => {
    expect(resolveFeedUrl({}, join(tmpdir(), 'typeless-missing-dir'))).toBeNull()
    expect(resolveFeedUrl({})).toBeNull()
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
  it('never contacts the network without a feed', async () => {
    const log = vi.fn()
    const updater = new Updater({ ...options(join(tmpdir(), 'typeless-missing-dir')), log })
    const result = await updater.check()
    expect(result.ok).toBe(false)
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[update] skipped: no feed configured')
  })

  it('configures the feed then reports the available version', async () => {
    mocks.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.0.0' } })
    const updater = new Updater(options())
    const result = await updater.check()
    // No feed in this environment either, so it still refuses — the point is that
    // a missing feed is never reported as "up to date".
    expect(result).toMatchObject({ ok: false, status: 'not-configured' })
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
