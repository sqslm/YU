import { mt } from '@shared/mainI18n'
import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS, applySettingsPatch, mergeSettings } from '@shared/defaults'

export { mergeSettings }

/** Anything that carries an API key: the three flat groups and every profile. */
interface SecretHolder {
  apiKey: string
  apiKeyEnc?: string
}

/**
 * Settings live in a single JSON file next to the rest of the user data so a
 * user can hand-edit or version-control them. Keys are merged shallowly into
 * the defaults, so upgrading never drops newly added fields.
 *
 * This file is the most expensive thing in `userData`: it holds every provider
 * profile (with its API keys), the shortcut map, the glossary and the prompt
 * library. Two failure modes are therefore treated as data loss rather than as
 * inconvenient startup noise:
 *
 *   1. A truncating `writeFile` interrupted mid-write leaves half a document.
 *      The payload therefore lands in a temp file and is renamed into place.
 *   2. An unreadable file is *not* the same thing as "no settings yet". Writing
 *      defaults over a damaged-but-present file erases everything the user had.
 *      A parse failure moves the original aside first; an I/O failure (locked or
 *      unreadable) keeps the in-memory defaults without touching the disk at all.
 */
export class SettingsStore {
  private readonly path: string
  private current: Settings = structuredClone(DEFAULT_SETTINGS)
  /** Serialises writes so two rapid `update()` calls cannot interleave. */
  private writing: Promise<void> = Promise.resolve()
  /** Preserved copy of a damaged settings file, when the last load found one. */
  private damagedCopy: string | null = null
  /** Set when the file could not be read for a reason other than corruption. */
  private readOnlyRecovery = false

  constructor(filePath = join(app.getPath('userData'), 'settings.json')) {
    this.path = filePath
  }

  get file(): string {
    return this.path
  }

  get(): Settings {
    return this.current
  }

  /**
   * Absolute path of the preserved unreadable file, when `load()` had to set a
   * damaged one aside. The UI surfaces this so the user knows their old settings
   * still exist instead of finding an empty dialog.
   */
  damagedPath(): string | null {
    return this.damagedCopy
  }

  /**
   * True when settings could not be read for an I/O reason (locked file, denied
   * permission) rather than because they were missing or corrupt. In that state
   * the session runs on defaults and must not write over the file on disk.
   */
  isReadOnlyRecovery(): boolean {
    return this.readOnlyRecovery
  }

  /**
   * True when the OS keyring is usable. On a Linux box with no keyring
   * `isEncryptionAvailable()` answers false and `encryptString()` throws, so the
   * file has to stay readable — storing the keys in clear text is bad, but
   * refusing to store them at all is worse.
   */
  private canEncrypt(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private seal(holder: SecretHolder): void {
    if (!holder.apiKey) {
      delete holder.apiKeyEnc
      return
    }
    try {
      holder.apiKeyEnc = safeStorage.encryptString(holder.apiKey).toString('base64')
      holder.apiKey = ''
    } catch (err) {
      console.error('[settings] cannot encrypt a key, leaving it in clear text:', err)
      delete holder.apiKeyEnc
    }
  }

  private unseal(holder: SecretHolder): void {
    const blob = holder.apiKeyEnc
    delete holder.apiKeyEnc
    if (!blob) return
    try {
      const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'))
      // A clear-text key already in the file wins: it was written while the
      // keyring was unavailable, and overwriting it would lose it for good.
      if (!holder.apiKey) holder.apiKey = plain
    } catch (err) {
      // A key encrypted by a different user account or machine cannot be read
      // here. Say so instead of silently offering an empty password field.
      console.error('[settings] cannot decrypt a stored key, ask for it again:', err)
    }
  }

  /** What actually lands in the file: every secret encrypted, plain text gone. */
  private diskView(source: Settings): Settings {
    if(!this.canEncrypt() && (source.briefingDelivery.email.apiKey||source.briefingDelivery.push.apiKey))throw new Error(mt('系统安全存储不可用，未保存简报投递密钥'))
    if (!this.canEncrypt()) return source
    const view = structuredClone(source)
    this.seal(view.asr)
    this.seal(view.polish)
    this.seal(view.multimodal)
    this.seal(view.tts)
    for (const entry of Object.values(view.tts.connections ?? {})) this.seal(entry)
    for (const profile of view.tts.profiles ?? []) this.seal(profile)
    for (const profile of view.profiles) this.seal(profile)
    for (const entry of Object.values(view.search.providers)) this.seal(entry)
    for (const entry of view.search.connections) this.seal(entry)
    this.seal(view.briefingDelivery.email)
    this.seal(view.briefingDelivery.push)
    if(view.briefingDelivery.email.apiKey||view.briefingDelivery.push.apiKey)throw new Error(mt('简报投递密钥加密失败，未写入设置文件'))
    // The flat mirror is derived again at load time; never leave its key in clear text.
    view.search.apiKey = ''
    return view
  }

  /** The reverse: encrypted blobs become usable keys again, in memory only. */
  private memoryView(source: Settings): Settings {
    const view = structuredClone(source)
    this.unseal(view.asr)
    this.unseal(view.polish)
    this.unseal(view.multimodal)
    this.unseal(view.tts)
    for (const entry of Object.values(view.tts.connections ?? {})) this.unseal(entry)
    for (const profile of view.tts.profiles ?? []) this.unseal(profile)
    for (const profile of view.profiles) this.unseal(profile)
    for (const entry of Object.values(view.search.providers)) this.unseal(entry)
    for (const entry of view.search.connections) this.unseal(entry)
    this.unseal(view.briefingDelivery.email)
    this.unseal(view.briefingDelivery.push)
    view.search.apiKey = view.search.providers[view.search.provider].apiKey
    return view
  }

  async load(): Promise<Settings> {
    try {
      const raw = await readFile(this.path, 'utf8')
      this.current = this.memoryView(mergeSettings(JSON.parse(raw) as Partial<Settings>))
      return this.current
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // First run: nothing to preserve, so creating the file is safe.
        this.current = structuredClone(DEFAULT_SETTINGS)
        await this.save()
        return this.current
      }
      this.current = structuredClone(DEFAULT_SETTINGS)
      if (err instanceof SyntaxError) {
        console.error('[settings] unparseable, keeping a copy and using defaults:', err)
        await this.quarantine()
        await this.save()
        return this.current
      }
      // A locked file (antivirus, another process) may still hold every provider
      // key. Overwriting it with defaults would be the worst possible response.
      this.readOnlyRecovery = true
      console.error('[settings] cannot read, running on defaults without writing:', err)
      return this.current
    }
  }

  private async writeSnapshot(settings: Settings): Promise<void> {
    if (this.readOnlyRecovery) {
      // Explicitly requested writes (the user just changed something) lift the
      // guard: at that point the in-memory state *is* what they want on disk.
      this.readOnlyRecovery = false
    }
    const payload = JSON.stringify(this.diskView(settings), null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, this.path)
  }

  async save(): Promise<void> {
    const job = this.writing.then(() => this.writeSnapshot(this.current))
    // The chain survives a failed write; the caller still sees the error.
    this.writing = job.catch(() => undefined)
    await job
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const job = this.writing.then(async () => {
      const next = mergeSettings(applySettingsPatch(this.current, patch))
      await this.writeSnapshot(next)
      this.current = next
      return next
    })
    this.writing = job.then(() => undefined, () => undefined)
    return job
  }

  /** Moves an unparseable settings file aside instead of overwriting its bytes. */
  private async quarantine(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const broken = `${this.path}.broken-${stamp}`
    try {
      await rename(this.path, broken)
      this.damagedCopy = broken
      console.error(`[settings] damaged file kept at ${broken}`)
    } catch (err) {
      console.error('[settings] cannot keep damaged file:', err)
    }
  }
}
