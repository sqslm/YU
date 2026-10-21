/**
 * The local speech models this app knows how to run.
 *
 * Everything here is data plus pure helpers: no `fs`, no `https`, no Electron.
 * The main process turns it into a directory scan, a download and a recogniser;
 * the renderer turns it into the picker on the 模型 page. Keeping the catalogue in
 * `shared/` is what lets both sides agree on folder names and file lists — the
 * folder name, in particular, is part of the contract, because a model is
 * "already on this machine" only when those exact files are in that exact place.
 *
 * Sizes are the real `Content-Length` of each file on hf-mirror.com (measured, not
 * guessed) because they drive the "约 229 MB" label; the downloader still prefers
 * the server's own header for the progress bar, so a re-uploaded model cannot make
 * the bar overrun.
 */
import { mt } from './mainI18n'


export type LocalAsrMirror = 'official' | 'cn'

/** One file of a model, addressed by its name inside the model folder. */
export interface LocalModelFile {
  file: string
  /** Advisory size in bytes, for display only. */
  bytes: number
}

export type LocalModelKind = 'sense-voice' | 'paraformer' | 'whisper'

export interface LocalModel {
  id: string
  name: string
  /**
   * Folder this app creates for the model.
   *
   * Readable rather than the repository's own name, because the folder now sits
   * in plain sight inside the install directory: "SenseVoice-Small" says what it
   * is, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" says where it came
   * from. Repository folder names are still recognised on the way in, so folders
   * produced by sherpa-onnx's own zip stay usable.
   */
  folder: string
  /** One line: what it is good at, shown under the picker. */
  hint: string
  /** Language codes the picker offers, `auto` first. */
  languages: string[]
  /** HuggingFace repository that hosts the files. */
  repo: string
  kind: LocalModelKind
  files: LocalModelFile[]
}

const MB = 1024 * 1024

/**
 * Three shapes rather than three vendors: SenseVoice is the multilingual
 * recogniser (Chinese, English, Japanese, Korean, Cantonese in one model, and the
 * one that handles mixed Chinese/English sentences), Paraformer is the fastest
 * Chinese-only option, and Whisper tiny is the smallest thing that works at all.
 */
export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: 'sense-voice-small',
    name: 'SenseVoice Small',
    folder: 'SenseVoice-Small',
    hint: mt('中英日韩粤一个模型，中英混说也按中文断句；默认选它'),
    languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    kind: 'sense-voice',
    files: [
      { file: 'model.int8.onnx', bytes: 239233841 },
      { file: 'tokens.txt', bytes: 315894 }
    ]
  },
  {
    id: 'paraformer-zh',
    name: 'Paraformer 中文',
    folder: 'Paraformer-ZH',
    hint: mt('只做中文，但同样精度下更快、内存更省'),
    languages: ['zh', 'auto'],
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09',
    kind: 'paraformer',
    files: [
      { file: 'model.int8.onnx', bytes: 227330205 },
      { file: 'tokens.txt', bytes: 75354 }
    ]
  },
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    folder: 'Whisper-Tiny',
    hint: mt('最小的一档，多语言；中文标点比前两个差一些'),
    languages: ['auto', 'zh', 'en'],
    repo: 'csukuangfj/sherpa-onnx-whisper-tiny',
    kind: 'whisper',
    files: [
      { file: 'tiny-encoder.int8.onnx', bytes: 12937772 },
      { file: 'tiny-decoder.int8.onnx', bytes: 89855401 },
      { file: 'tiny-tokens.txt', bytes: 816730 }
    ]
  }
]

export const DEFAULT_LOCAL_MODEL = LOCAL_MODELS[0].id

export function findModel(id: string | undefined): LocalModel | undefined {
  return LOCAL_MODELS.find((model) => model.id === id)
}

/** Total advisory size of a model, in bytes. */
export function modelBytes(model: LocalModel): number {
  return model.files.reduce((sum, file) => sum + file.bytes, 0)
}

/**
 * Folder the model lives in.
 *
 * The repository's own name without its owner prefix — `sherpa-onnx-sense-voice-…`
 * — because that is what sherpa-onnx's documentation tells people to unzip, so a
 * folder produced by any other tool is recognised here without renaming anything.
 */
export function modelFolderName(model: LocalModel): string {
  const parts = model.repo.split('/')
  return parts[parts.length - 1]
}

/** The folder this app writes, as opposed to the one the repository ships. */
export function modelFolder(model: LocalModel): string {
  return model.folder
}

/** Absolute or relative file name inside the model folder. */
export function downloadUrl(model: LocalModel, file: string, mirror: LocalAsrMirror): string {
  const host = mirror === 'cn' ? 'https://hf-mirror.com' : 'https://huggingface.co'
  return `${host}/${model.repo}/resolve/main/${file}?download=true`
}

export function modelFiles(model: LocalModel): string[] {
  return model.files.map((file) => file.file)
}

/** Which of the model's files are absent, given what the folder actually holds. */
export function missingFiles(model: LocalModel, present: readonly string[]): string[] {
  const have = new Set(present)
  return modelFiles(model).filter((file) => !have.has(file))
}

/** `1.2 GB` / `230 MB` / `0.3 MB`, one decimal only where it helps. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`
  const mb = bytes / MB
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

/**
 * Progress of one download, as the renderer shows it.
 *
 * `ratio` is 0–1 and clamped, so a server that reports a different length than
 * the catalogue never paints a bar past its own end.
 */
export interface LocalDownloadProgress {
  modelId: string
  file: string
  fileIndex: number
  fileCount: number
  received: number
  total: number
  ratio: number
}

export function progressOf(
  modelId: string,
  file: string,
  fileIndex: number,
  fileCount: number,
  received: number,
  total: number
): LocalDownloadProgress {
  const ratio = total > 0 ? Math.min(1, Math.max(0, received / total)) : 0
  return { modelId, file, fileIndex, fileCount, received, total, ratio }
}

/**
 * What the main process knows about the local model right now.
 *
 * `phase` is the engine's own state (loaded or not); `present` is the disk's.
 * They are separate on purpose: the files can be there while nothing is loaded,
 * and the page has to be able to show both facts at once ("Windows 可用" and
 * "模型未加载" in the OpenLess card are exactly these two).
 */
export interface LocalModelPresence {
  id: string
  /** Every file is on disk somewhere this app would look. */
  present: boolean
  /** Folder the files were found in; '' when absent. */
  dir: string
  bytes: number
  /** How many catalogue files are still missing. */
  missing: number
}

export interface LocalAsrStatus {
  modelId: string
  modelName: string
  /** Absolute folder the model lives (or would live) in. */
  dir: string
  /** How that folder was chosen; 'none' means nothing was found anywhere. */
  dirSource: 'custom' | 'install' | 'userData' | 'detected' | 'none'
  /** Root the app downloads into: the install folder, or its fallback. */
  modelsRoot: string
  /** False when the install directory refused to take files. */
  installWritable: boolean
  /** Every catalogue file is on disk. */
  present: boolean
  /** Filenames still missing; empty when `present`. */
  missing: string[]
  installedBytes: number
  expectedBytes: number
  /** Engine state: idle (files only), loading, ready (in memory), error. */
  phase: 'idle' | 'loading' | 'ready' | 'error'
  /** Weights were reclaimed; the next local dictation reloads them. */
  autoResume: boolean
  /**
   * The model the engine actually holds, or null.
   *
   * Kept apart from `modelId` on purpose: choosing another model in the picker is
   * a preference that takes effect on the next 加载, while this is the 230 MB that
   * is mapped right now. Reporting one as the other is how "在用" and the release
   * button once followed the picker to a model that had never been loaded.
   */
  loadedModelId: string | null
  loadedModelName: string | null
  /** One line explaining the current phase, already user-facing. */
  message: string
  language: string
  enabled: boolean
  mirror: LocalAsrMirror
  /** False in a build without the native addon. */
  runtime: boolean
  /**
   * Every catalogue model and whether its files are on disk.
   *
   * The picker needs this for the models it is *not* showing: "228 MB, 已安装"
   * next to a row is what stops someone downloading the same weights twice.
   */
  catalog: LocalModelPresence[]
}
