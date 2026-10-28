/**
 * The built-in recogniser: sherpa-onnx running in a utility process.
 *
 * Three jobs, in the order the page needs them:
 *
 * 1. **Where are the files?** A model is "installed" when its folder holds every
 *    file the catalogue asks for. The folder is either the one the user chose, or
 *    the one another tool already created (sherpa-onnx's own docs, OpenLess, or a
 *    previous install of this app), so the page can say "已经在这台电脑上了"
 *    without the user configuring anything first.
 * 2. **Move the bytes.** Downloads are plain HTTP(S) with a `Content-Length`
 *    check; they land in a `.part` file and are renamed only when complete, so an
 *    interrupted download never looks installed.
 * 3. **Load and unload.** `activate()` starts the child and makes it build the
 *    recogniser (which allocates ~230 MB of weights and an onnxruntime session),
 *    `release()` kills the child. That is the reason the page has explicit 加载 /
 *    释放 buttons: measured on this machine, dropping an in-process recogniser
 *    left the main process at 425 MB before *and* after the button, because the
 *    weights belong to a native handle that only frees on finalisation. A killed
 *    child hands the pages back to the OS immediately.
 *
 * Every failure is a status, never a throw: the page is the place that explains
 * what is missing, and a dictation must fall back to the provider instead of
 * dying because a local model was half-downloaded.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { access, copyFile, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LOCAL_MODELS,
  downloadUrl,
  findModel,
  formatBytes,
  missingFiles,
  modelBytes,
  modelFiles,
  modelFolder,
  modelFolderName,
  type LocalAsrMirror,
  type LocalAsrStatus,
  type LocalDownloadProgress,
  type LocalModel,
  type LocalModelKind,
  type LocalModelPresence
} from '@shared/local-asr'
import type { LocalAsrSettings } from '@shared/types'
import { downloadFile } from './download'
import { mt } from '@shared/mainI18n'

type Phase = 'idle' | 'loading' | 'ready' | 'error'

/** How the model folder was found — the page shows this as a hint. */
type DirSource = 'custom' | 'install' | 'userData' | 'detected' | 'none'

export interface LocalAsrCallbacks {
  log: (line: string) => void
  /** Recording must keep already loaded weights warm, even before decoding. */
  isBusy?: () => boolean
  /** Pushes download progress to the settings window. */
  onProgress: (progress: LocalDownloadProgress | null) => void
}

/** What the worker sends back. */
type ChildMessage =
  | { type: 'ready' }
  | { type: 'loaded'; ms: number }
  | { type: 'failed'; message: string }
  | { type: 'text'; id: number; text: string; ms?: number }
  | { type: 'fail'; id: number; message: string }

/** How long a load may take before the page is told it failed. */
const LOAD_TIMEOUT_MS = 60_000
/** Per-take ceiling: a 3-minute recording decodes in a couple of seconds. */
const TRANSCRIBE_TIMEOUT_MS = 120_000

/**
 * Places a model may already be, in the order they are tried.
 *
 * The OpenLess path is here on purpose: it is the folder people end up with when
 * they tried that app first, and re-downloading 230 MB because the folder is one
 * level to the side would be silly.
 */
function candidateRoots(userDir: string): Array<{ root: string; source: DirSource }> {
  const home = homedir()
  return [
    // The pre-0.9.34 home. Still walked, because a model downloaded yesterday is
    // 230 MB the user should not have to fetch again — it gets moved, below.
    { root: join(userDir, 'local-asr', 'models'), source: 'userData' },
    { root: join(home, 'Models'), source: 'detected' },
    { root: join(home, 'models'), source: 'detected' },
    { root: join(home, 'AppData', 'Local', 'Models'), source: 'detected' },
    { root: 'D:\\Models', source: 'detected' },
    { root: 'E:\\Models', source: 'detected' },
    { root: 'C:\\Models', source: 'detected' }
  ]
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/**
 * Deletes an emptied legacy folder, and its parent when that goes too.
 *
 * `rmdir` refuses a non-empty directory, which is exactly the guard wanted: a
 * user who keeps half a model there must not lose it because something else moved.
 */
async function pruneEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir)
  } catch {
    return
  }
  try {
    await rmdir(dirname(dir))
  } catch {
    // The parent still holds something else; leave it alone.
  }
}

/** Creates the folder and proves it takes a file; false means "try elsewhere". */
async function isWritableDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, '.typeless-write-test')
    await writeFile(probe, 'ok')
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** The absolute paths the worker needs for one model in one folder. */
function modelPaths(model: LocalModel, dir: string): {
  tokens: string
  model: string
  encoder?: string
  decoder?: string
} {
  if (model.kind === 'whisper') {
    return {
      tokens: join(dir, 'tiny-tokens.txt'),
      model: join(dir, 'tiny-encoder.int8.onnx'),
      encoder: join(dir, 'tiny-encoder.int8.onnx'),
      decoder: join(dir, 'tiny-decoder.int8.onnx')
    }
  }
  return { tokens: join(dir, 'tokens.txt'), model: join(dir, 'model.int8.onnx') }
}

export class LocalAsrHost {
  private phase: Phase = 'idle'
  private message = ''
  /** The child that owns the weights; null when nothing is loaded. */
  private worker: UtilityProcess | null = null
  private loadedModel: LocalModel | null = null
  private language = 'auto'
  private dir = ''
  private dirSource: DirSource = 'none'
  private present = false
  private installedBytes = 0
  private missing: string[] = []
  /** True while a download is running, so two clicks cannot race. */
  private busy = false
  /** Resolved once: probing the install folder on every poll would be silly. */
  private rootCache: { root: string; writable: boolean } | null = null
  /** The old AppData copy is moved at most once per launch. */
  private migrated = false
  /** Round-trip ids for transcribe requests. */
  private seq = 0
  private readonly pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private loadedSignal: { resolve: () => void; reject: (error: Error) => void } | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private resumeAfterIdle = false
  private activating: Promise<LocalAsrStatus> | null = null
  private loadGeneration = 0

  constructor(
    private readonly settings: () => LocalAsrSettings,
    private readonly callbacks: LocalAsrCallbacks
  ) {}

  /**
   * Presence of every catalogue model, not just the selected one.
   *
   * Same roots as `locate` and the same rule (all files or nothing), so the row
   * that says 已安装 is the row that would actually load.
   */
  private async catalog(): Promise<LocalModelPresence[]> {
    const primary = await this.modelsRoot()
    const roots: string[] = [primary.root, join(app.getPath('userData'), 'local-asr', 'models')]
    for (const entry of candidateRoots(app.getPath('userData'))) roots.push(entry.root)
    const answer: LocalModelPresence[] = []
    for (const model of LOCAL_MODELS) {
      let found: LocalModelPresence = { id: model.id, present: false, dir: '', bytes: 0, missing: model.files.length }
      for (const root of roots) {
        for (const folder of [modelFolder(model), modelFolderName(model)]) {
          const dir = join(root, folder)
          const files = await listFiles(dir)
          if (files.length === 0) continue
          const missing = missingFiles(model, files)
          if (missing.length > 0) {
            if (!found.dir) found = { id: model.id, present: false, dir, bytes: 0, missing: missing.length }
            continue
          }
          let bytes = 0
          for (const file of modelFiles(model)) bytes += await sizeOf(join(dir, file))
          found = { id: model.id, present: true, dir, bytes, missing: 0 }
          break
        }
        if (found.present) break
      }
      answer.push(found)
    }
    return answer
  }

  /**
   * Where models are downloaded to: next to the executable, not in AppData.
   *
   * The weights are 100–230 MB each, so keeping them beside the install makes the
   * cost visible in one place — the folder a user deleted the app from is also the
   * folder that returns the disk. A per-machine install under Program Files is not
   * writable for a normal user, so the probe falls back to AppData and says so;
   * a portable copy or a per-user install (the normal case) stays where it is.
   */
  private async modelsRoot(): Promise<{ root: string; writable: boolean }> {
    if (this.rootCache) return this.rootCache
    const override = process.env.TYPELESS_MODELS_ROOT?.trim()
    const installDir = app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
    const preferred = override || join(installDir, 'models')
    const fallback = join(app.getPath('userData'), 'local-asr', 'models')
    if (await isWritableDir(preferred)) {
      this.rootCache = { root: preferred, writable: true }
      return this.rootCache
    }
    this.callbacks.log(`[local-asr] ${preferred} is not writable; falling back to ${fallback}`)
    this.rootCache = { root: fallback, writable: false }
    return this.rootCache
  }

  /** Everything the page renders, recomputed from disk on every call. */
  async status(): Promise<LocalAsrStatus> {
    const settings = this.settings()
    const model = findModel(settings.modelId) ?? LOCAL_MODELS[0]
    if (!settings.modelDir.trim()) await this.migrateLegacy(model)
    await this.locate(model, settings.modelDir)
    // The phase line has to say something useful before the user has pressed
    // anything: with the files missing "未加载" alone reads like a broken switch.
    if (this.phase === 'idle' && !this.resumeAfterIdle) {
      this.message = this.present
        ? mt('文件齐全（{{size}}），可以加载', { size: formatBytes(this.installedBytes) })
        : mt('缺少 {{n}} 个文件，先下载', { n: this.missing.length })
    }
    // Selected and loaded are different facts. When they disagree the line names
    // the model that owns the memory, because that — not the picker — is what 释放
    // and the next 加载 act on.
    const loaded = this.loadedModel
    if (this.phase === 'ready' && loaded && loaded.id !== model.id) {
      this.message = mt('内存中：{{loaded}}；已选 {{selected}}，加载后切换', {
        loaded: loaded.name,
        selected: model.name
      })
    }
    return {
      modelId: model.id,
      modelName: model.name,
      dir: this.dir,
      dirSource: this.dirSource,
      present: this.present,
      missing: this.missing,
      installedBytes: this.installedBytes,
      expectedBytes: modelBytes(model),
      phase: this.phase,
      autoResume: this.resumeAfterIdle,
      loadedModelId: loaded?.id ?? null,
      loadedModelName: loaded?.name ?? null,
      message: this.message,
      language: this.language,
      enabled: settings.enabled,
      mirror: settings.mirror,
      runtime: this.runtimeAvailable(),
      modelsRoot: (await this.modelsRoot()).root,
      installWritable: (await this.modelsRoot()).writable,
      catalog: await this.catalog()
    }
  }

  /** Whether the native module is present in this build at all. */
  runtimeAvailable(): boolean {
    try {
      // Resolve files without loading the native runtime into the main process.
      // Only the disposable recognizer worker should ever map its libraries.
      const wrapper = require.resolve('sherpa-onnx-node')
      const platform = process.platform === 'win32' ? 'win' : process.platform
      require.resolve(`sherpa-onnx-${platform}-${process.arch}/sherpa-onnx.node`, { paths: [dirname(wrapper)] })
      return true
    } catch {
      return false
    }
  }

  /**
   * Find the folder for a model: the user's choice first, then the usual places.
   *
   * A model counts as installed only when *every* catalogue file is there, so a
   * half-finished copy is reported as missing files rather than as ready.
   */
  private async locate(model: LocalModel, custom: string): Promise<void> {
    // Both spellings are accepted: the readable folder this app creates, and the
    // repository's own name, which is what every sherpa-onnx tutorial tells people
    // to unzip. A folder is a folder; nobody should have to rename one.
    const folders = [modelFolder(model), modelFolderName(model)]
    const wanted = modelFiles(model)
    const primary = await this.modelsRoot()
    const roots: Array<{ root: string; source: DirSource }> = []
    if (custom.trim()) {
      // The user may point at the model folder itself or at the folder that
      // contains it; both are supported because both are reasonable.
      roots.push({ root: custom.trim(), source: 'custom' })
      for (const folder of folders) {
        roots.push({ root: join(custom.trim(), folder), source: 'custom' })
      }
    }
    roots.push({ root: join(primary.root, folders[0]), source: primary.writable ? 'install' : 'userData' })
    for (const entry of candidateRoots(app.getPath('userData'))) {
      for (const folder of folders) {
        roots.push({ root: join(entry.root, folder), source: entry.source })
      }
    }

    for (const candidate of roots) {
      const files = await listFiles(candidate.root)
      if (files.length === 0) continue
      const missing = missingFiles(model, files)
      if (missing.length === 0) {
        this.dir = candidate.root
        this.dirSource = candidate.source
        this.present = true
        this.missing = []
        let bytes = 0
        for (const file of wanted) bytes += await sizeOf(join(candidate.root, file))
        this.installedBytes = bytes
        return
      }
    }

    // Nothing complete: remember the first place we would have looked, so the
    // page can show where a download would go.
    this.dir = roots[0].root
    this.dirSource = roots[0].source
    this.present = false
    this.missing = wanted
    this.installedBytes = 0
  }

  /**
   * Move a model from the old AppData home into the install folder.
   *
   * Runs once, only when the user has not chosen a folder themselves, and only for
   * a copy that is actually complete — a half-downloaded folder is left alone so a
   * broken download cannot overwrite a good one. `rename` handles the easy case;
   * a different volume (models on D:, app on E:) makes it EXDEV, hence the copy.
   */
  private async migrateLegacy(model: LocalModel): Promise<void> {
    if (this.migrated) return
    this.migrated = true
    const primary = await this.modelsRoot()
    const target = join(primary.root, modelFolder(model))
    const wanted = modelFiles(model)
    if ((await listFiles(target)).length > 0) return
    const sources: string[] = []
    for (const entry of candidateRoots(app.getPath('userData'))) {
      for (const folder of [modelFolder(model), modelFolderName(model)]) {
        sources.push(join(entry.root, folder))
      }
    }
    for (const source of sources) {
      const files = await listFiles(source)
      if (files.length === 0) continue
      if (missingFiles(model, files).length > 0) continue
      try {
        await mkdir(dirname(target), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await rename(source, target)
        this.callbacks.log(`[local-asr] moved ${source} -> ${target}`)
        await pruneEmpty(dirname(source))
        return
      } catch {
        // Different volume, or a file held open: copy instead, then drop the old.
      }
      try {
        await mkdir(target, { recursive: true })
        for (const file of wanted) await copyFile(join(source, file), join(target, file))
        await rm(source, { recursive: true, force: true })
        this.callbacks.log(`[local-asr] copied ${source} -> ${target}`)
        await pruneEmpty(dirname(source))
        return
      } catch (error) {
        this.callbacks.log(`[local-asr] could not move ${source}: ${(error as Error).message}`)
      }
    }
  }

  /** Start the child and make it build the recogniser. */
  activate(): Promise<LocalAsrStatus> {
    if (this.activating) return this.activating
    this.activating = this.activateSelected().finally(() => { this.activating = null })
    return this.activating
  }

  private async activateSelected(): Promise<LocalAsrStatus> {
    const settings = this.settings()
    const model = findModel(settings.modelId) ?? LOCAL_MODELS[0]
    this.language = settings.language || 'auto'

    if (this.phase === 'ready' && this.loadedModel?.id === model.id) return this.status()

    this.release()
    const generation = this.loadGeneration
    this.phase = 'loading'
    this.message = mt('正在加载模型…')
    await this.locate(model, settings.modelDir)
    if (generation !== this.loadGeneration) return this.status()
    if (!this.present) {
      this.phase = 'error'
      this.message = mt('缺少 {{n}} 个模型文件，先下载或检查目录', { n: this.missing.length })
      return this.status()
    }
    if (!this.runtimeAvailable()) {
      this.phase = 'error'
      this.message = mt('这个版本没有带本地识别运行时')
      return this.status()
    }

    const started = Date.now()
    const paths = modelPaths(model, this.dir)
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        this.loadedSignal = { resolve, reject }
      })
      this.spawn()
      this.worker?.postMessage({
        type: 'load',
        dir: this.dir,
        kind: model.kind as LocalModelKind,
        tokens: paths.tokens,
        model: paths.model,
        encoder: paths.encoder,
        decoder: paths.decoder,
        language: this.language
      })
      await withTimeout(loaded, LOAD_TIMEOUT_MS, mt('加载超时'))
      if (generation !== this.loadGeneration) return this.status()
      this.loadedModel = model
      this.phase = 'ready'
      this.scheduleIdle()
      // The badge next to it already says 已加载; the line itself should carry
      // the name and the cost, not repeat the verb.
      this.message = `${model.name}（${formatBytes(this.installedBytes)}）`
      this.callbacks.log(
        `[local-asr] loaded ${model.id} from ${this.dir} in ${Date.now() - started}ms (language ${this.language})`
      )
    } catch (error) {
      if (generation !== this.loadGeneration) return this.status()
      this.loadedSignal = null
      this.kill()
      this.phase = 'error'
      this.message = mt('加载失败：{{message}}', { message: (error as Error).message })
      this.callbacks.log(`[local-asr] load failed: ${(error as Error).message}`)
    }
    return this.status()
  }

  /** Kill the child. The OS takes the weights back; nothing else in this app can. */
  release(): void {
    this.loadGeneration += 1
    this.clearIdle()
    this.resumeAfterIdle = false
    if (this.worker) this.callbacks.log('[local-asr] releasing the recogniser process')
    this.kill()
    if (this.phase === 'ready' || this.phase === 'loading') {
      this.phase = 'idle'
      this.message = mt('已释放内存')
    }
    this.loadedModel = null
  }

  ready(): boolean {
    return this.phase === 'ready' && this.worker !== null
  }

  get inUse(): boolean {
    return this.phase === 'loading' || this.pending.size > 0
  }

  /** An automatically unloaded model remains eligible for local dictation. */
  available(): boolean {
    return this.ready() || this.resumeAfterIdle
  }

  memoryState(): { loaded: boolean; autoResume: boolean } {
    return { loaded: this.ready(), autoResume: this.resumeAfterIdle }
  }

  /** Game mode cancels loading too; the next deliberate take may reload the model. */
  suspend(): void {
    this.release()
    this.resumeAfterIdle = this.settings().enabled
  }

  /** Free idle weights without turning the user's local recognition choice off. */
  reclaim(): boolean {
    if (!this.ready() || this.inUse || this.callbacks.isBusy?.()) return false
    const resume = this.settings().enabled
    this.release()
    this.resumeAfterIdle = resume
    if (resume) this.message = mt('空闲模型已释放，下次听写时自动加载')
    return true
  }

  reconfigure(): void {
    this.clearIdle()
    this.scheduleIdle()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    this.clearIdle()
    const minutes = this.settings().idleUnloadMinutes
    if (!this.ready() || this.inUse || !minutes) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.reclaim()) this.callbacks.log('[local-asr] idle: reclaimed model weights')
      else this.scheduleIdle()
    }, minutes * 60_000)
    this.idleTimer.unref?.()
  }

  /** Transcribe one wav buffer. Returns '' when the model heard nothing. */
  async transcribeWav(wav: Uint8Array): Promise<string> {
    if (this.resumeAfterIdle) await this.activate()
    if (!this.ready() || !this.worker) throw new Error(mt('本地模型未加载'))
    this.clearIdle()
    const id = ++this.seq
    const started = Date.now()
    const answer = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    const target = this.worker
    // Copy into a plain buffer: the payload crosses a process boundary and must
    // not keep a view on a buffer the renderer could still be filling.
    target.postMessage({ type: 'wav', id, wav: new Uint8Array(wav) })
    try {
      const text = await withTimeout(answer, TRANSCRIBE_TIMEOUT_MS, mt('识别超时'))
      this.callbacks.log(`[local-asr] transcribed in ${Date.now() - started}ms: ${text.length} chars`)
      return text.trim()
    } finally {
      this.pending.delete(id)
      this.scheduleIdle()
    }
  }

  get downloading(): boolean {
    return this.busy
  }

  /**
   * One-click download of the catalogue files.
   *
   * Sequential on purpose: HF throttles parallel fetches from the same client and
   * the progress bar is easier to read with one file at a time.
   */
  async download(mirror?: LocalAsrMirror): Promise<LocalAsrStatus> {
    if (this.busy) return this.status()
    const settings = this.settings()
    const model = findModel(settings.modelId) ?? LOCAL_MODELS[0]
    const host = mirror ?? settings.mirror
    await this.locate(model, settings.modelDir)
    const target = this.dir
    await mkdir(target, { recursive: true })

    this.busy = true
    this.message = mt('正在下载 {{model}}…', { model: model.name })
    try {
      const files = model.files
      for (const [index, file] of files.entries()) {
        if (await exists(join(target, file.file))) {
          this.callbacks.onProgress({
            modelId: model.id,
            file: file.file,
            fileIndex: index,
            fileCount: files.length,
            received: file.bytes,
            total: file.bytes,
            ratio: 1
          })
          continue
        }
        await downloadFile(downloadUrl(model, file.file, host), join(target, file.file), (received, total) => {
          this.callbacks.onProgress({
            modelId: model.id,
            file: file.file,
            fileIndex: index,
            fileCount: files.length,
            received,
            total: total > 0 ? total : file.bytes,
            ratio: total > 0 ? Math.min(1, received / total) : 0
          })
        })
        this.callbacks.log(`[local-asr] downloaded ${file.file} into ${target}`)
      }
      this.message = mt('{{model}} 已下载完成', { model: model.name })
      this.phase = 'idle'
    } catch (error) {
      this.phase = 'error'
      this.message = mt('下载失败：{{message}}', { message: (error as Error).message })
      this.callbacks.log(`[local-asr] download failed: ${(error as Error).message}`)
    } finally {
      this.busy = false
      this.callbacks.onProgress(null)
    }
    return this.status()
  }

  /** Delete the model folder. Refuses while the model is loaded. */
  async remove(): Promise<LocalAsrStatus> {
    if (this.phase === 'ready') {
      this.phase = 'error'
      this.message = mt('先释放模型再删除')
      return this.status()
    }
    const settings = this.settings()
    const model = findModel(settings.modelId) ?? LOCAL_MODELS[0]
    await this.locate(model, settings.modelDir)
    if (!this.dir || !(await exists(this.dir))) {
      this.message = mt('这个目录里没有可删除的模型')
      return this.status()
    }
    try {
      await rm(this.dir, { recursive: true, force: true })
      this.callbacks.log(`[local-asr] removed ${this.dir}`)
      this.message = mt('已删除模型文件')
    } catch (error) {
      this.message = mt('删除失败：{{message}}', { message: (error as Error).message })
    }
    this.phase = 'idle'
    return this.status()
  }

  /** Re-runs the disk scan without touching the loaded model. */
  async rescan(): Promise<LocalAsrStatus> {
    const settings = this.settings()
    await this.locate(findModel(settings.modelId) ?? LOCAL_MODELS[0], settings.modelDir)
    return this.status()
  }

  /** Forks the utility-process entry that owns the engine. */
  private spawn(): void {
    const entry = join(__dirname, 'local-asr.js')
    this.callbacks.log(`[local-asr] spawning ${entry}`)
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'typeless-local-asr',
      stdio: 'inherit'
    })
    this.worker = child
    child.once('spawn', () => { if (this.worker !== child) child.kill() })
    child.on('message', (message: unknown) => {
      if (this.worker === child) this.onMessage(message as ChildMessage)
    })
    child.on('exit', (code) => {
      if (this.worker !== child) return
      this.worker = null
      const failure = new Error(mt('识别进程已退出（code {{code}}）', { code }))
      this.loadedSignal?.reject(failure)
      this.loadedSignal = null
      for (const [, waiting] of this.pending) waiting.reject(failure)
      this.pending.clear()
      if (this.phase === 'ready') {
        this.phase = 'error'
        this.message = mt('识别进程退出了，重新加载一次')
        this.callbacks.log(`[local-asr] worker exited with ${code}`)
      }
    })
  }

  private onMessage(message: ChildMessage): void {
    if (message.type === 'ready') return
    if (message.type === 'loaded') {
      this.loadedSignal?.resolve()
      this.loadedSignal = null
      return
    }
    if (message.type === 'failed') {
      this.loadedSignal?.reject(new Error(message.message))
      this.loadedSignal = null
      return
    }
    if (message.type === 'text') {
      this.pending.get(message.id)?.resolve(message.text)
      return
    }
    if (message.type === 'fail') {
      this.pending.get(message.id)?.reject(new Error(message.message))
    }
  }

  private kill(): void {
    const child = this.worker
    this.worker = null
    this.loadedSignal?.reject(new Error(mt('识别进程已释放')))
    this.loadedSignal = null
    for (const [, waiting] of this.pending) waiting.reject(new Error(mt('识别进程已释放')))
    this.pending.clear()
    if (!child) return
    try {
      child.postMessage({ type: 'exit' })
    } catch {
      // The child may already be gone; the kill below is the real work.
    }
    // Give the message a moment to arrive, then make sure of it: `kill` is what
    // actually returns the pages to the OS.
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already dead.
      }
    }, 50)
  }
}

/** Rejects when the promise takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}
