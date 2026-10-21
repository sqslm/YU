import koffi from 'koffi'
import { win32 as winPath } from 'node:path'
import { matchAppRule, pickPromptKind } from '@shared/promptLibrary'
import type { AppRule, PromptKind } from '@shared/types'

/** A koffi type handle; the interface is not exported by the package. */
import { mt } from '@shared/mainI18n'

type KoffiType = ReturnType<typeof koffi.proto>

/**
 * `user32` entry points used to walk the window stack. Handles stay opaque
 * (`unknown`): koffi hands them back as external pointers and they are only ever
 * passed straight into another Win32 call.
 */
interface User32 {
  GetForegroundWindow(): unknown
  GetWindowTextW(hwnd: unknown, buf: Buffer, max: number): number
  GetClassNameW(hwnd: unknown, buf: Buffer, max: number): number
  GetWindowThreadProcessId(hwnd: unknown, pid: Buffer): number
  IsWindowVisible(hwnd: unknown): number
  /** Fills a 16-byte `RECT` (left, top, right, bottom as int32) into `rect`. */
  GetWindowRect(hwnd: unknown, rect: Buffer): number
  EnumWindows(callback: unknown, lParam: number): number
}

interface Kernel32 {
  OpenProcess(access: number, inherit: number, pid: number): unknown
  QueryFullProcessImageNameW(handle: unknown, flags: number, buf: Buffer, size: Buffer): number
  CloseHandle(handle: unknown): number
}

interface Win32 {
  user32: User32
  kernel32: Kernel32
  /** The `WNDENUMPROC` prototype itself, needed to wrap the JS callback. */
  enumProc: KoffiType
}

/**
 * Bindings are created on first use instead of at import time so the pure
 * routing helpers below stay loadable outside a Windows GUI session (the unit
 * tests import this module without touching a single Win32 call).
 */
let bindings: Win32 | null = null

function win32(): Win32 {
  if (bindings) return bindings

  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // The prototype has to exist before `EnumWindows`'s definition string is
  // parsed, otherwise koffi cannot resolve the `WNDENUMPROC *` parameter.
  const enumProc = koffi.proto('int WNDENUMPROC(void *hwnd, intptr_t lParam)')

  bindings = {
    enumProc,
    user32: {
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetWindowTextW: user32.func('int GetWindowTextW(void *hWnd, char16_t *buf, int max)'),
      GetClassNameW: user32.func('int GetClassNameW(void *hWnd, char16_t *buf, int max)'),
      GetWindowThreadProcessId: user32.func(
        'uint32_t GetWindowThreadProcessId(void *hWnd, void *pid)'
      ),
      IsWindowVisible: user32.func('int IsWindowVisible(void *hWnd)'),
      GetWindowRect: user32.func('int GetWindowRect(void *hWnd, void *lprc)'),
      EnumWindows: user32.func('int EnumWindows(WNDENUMPROC *lpEnumFunc, intptr_t lParam)')
    },
    kernel32: {
      OpenProcess: kernel32.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: kernel32.func(
        'int QueryFullProcessImageNameW(void *handle, uint32_t flags, char16_t *buf, void *size)'
      ),
      CloseHandle: kernel32.func('int CloseHandle(void *handle)')
    }
  }
  return bindings
}

/**
 * Process image name → the name a user recognises. History shows this instead
 * of the window title: "DeepSeek Harness" is the app, while "与 Typeless 的差距
 * — DeepSeek Harness" is only the document open right now, and storing the
 * latter made every row look like a different application.
 */
const FRIENDLY_NAMES: Record<string, string> = {
  dsh: 'DeepSeek Harness',
  code: 'VS Code',
  chatgpt: 'ChatGPT',
  msedge: 'Edge',
  chrome: 'Chrome',
  firefox: 'Firefox',
  feishu: mt('飞书'),
  lark: mt('飞书'),
  wechat: mt('微信'),
  weixin: mt('微信'),
  windowsterminal: mt('终端'),
  cmd: mt('命令提示符'),
  powershell: 'PowerShell',
  notepad: mt('记事本'),
  explorer: mt('资源管理器'),
  slack: 'Slack',
  notion: 'Notion',
  discord: 'Discord',
  telegram: 'Telegram',
  obsidian: 'Obsidian',
  word: 'Word',
  excel: 'Excel',
  outlook: 'Outlook'
}

function titleCase(name: string): string {
  return name.length === 0 ? '' : name[0]!.toUpperCase() + name.slice(1)
}

/**
 * App label for a window: the process name when Windows gave us one, with the
 * session title as a last resort. Never the title alone when a process is
 * known — that is what leaked document names into the history list.
 */
export function appLabel(appName: string, title: string): string {
  const process = appName.trim()
  if (process.length > 0) return FRIENDLY_NAMES[process.toLowerCase()] ?? titleCase(process)
  return title.trim()
}

export interface ForegroundRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ForegroundInfo {
  title: string
  className: string
  pid: number
  /** Process image name without `.exe`; '' when it could not be read. */
  appName: string
  /**
   * Full image path of the foreground process. Empty when the handle was not
   * readable — a protected process (a game, some store apps) refuses
   * `PROCESS_QUERY_LIMITED_INFORMATION` and there is nothing to invent.
   */
  appPath: string
  /**
   * Window rectangle in physical pixels, `null` when Windows refused it
   * (minimised, cloaked, or already destroyed). Used as prompt context so the
   * model can tell a full-width editor from a small comment box.
   */
  rect: ForegroundRect | null
}

/** Empty snapshot for every failure path: one shape, no `undefined` checks. */
function noForeground(): ForegroundInfo {
  return { title: '', className: '', pid: 0, appName: '', appPath: '', rect: null }
}

/** `GetWindowRect` into a plain rectangle; `null` when the call fails or is empty. */
function windowRect(user32: User32, hwnd: unknown): ForegroundRect | null {
  const raw = Buffer.alloc(16)
  if (user32.GetWindowRect(hwnd, raw) === 0) return null
  const left = raw.readInt32LE(0)
  const top = raw.readInt32LE(4)
  const width = raw.readInt32LE(8) - left
  const height = raw.readInt32LE(12) - top
  // A minimised window reports -32000/-32000 with a normal size; a zero or
  // negative extent is never useful context, so both collapse to `null`.
  if (width <= 0 || height <= 0) return null
  return { x: left, y: top, width, height }
}

/** Describes the window that currently owns the caret, for history labelling. */
export function foregroundWindow(): ForegroundInfo {
  const { user32, kernel32 } = win32()
  const hwnd = user32.GetForegroundWindow()
  if (!hwnd) return noForeground()

  const titleBuf = Buffer.alloc(1024)
  const titleLen = user32.GetWindowTextW(hwnd, titleBuf, 512)
  const classBuf = Buffer.alloc(512)
  const classLen = user32.GetClassNameW(hwnd, classBuf, 256)
  const pidBuf = Buffer.alloc(4)
  user32.GetWindowThreadProcessId(hwnd, pidBuf)
  const pid = pidBuf.readUInt32LE(0)
  const image = pid ? processImage(pid, kernel32, new Map()) : { name: '', path: '' }

  return {
    title: titleBuf.toString('utf16le', 0, titleLen * 2),
    className: classBuf.toString('utf16le', 0, classLen * 2),
    pid,
    appName: image.name,
    appPath: image.path,
    rect: windowRect(user32, hwnd)
  }
}

// --- visible window enumeration --------------------------------------------

/** Cap on how many windows the picker lists; a runaway enumeration is useless. */
export const MAX_VISIBLE_WINDOWS = 200

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const TITLE_CHARS = 512
const CLASS_CHARS = 256
const IMAGE_CHARS = 1024

/**
 * Window classes that belong to the desktop shell, to the taskbar or to
 * tooltip/IME plumbing rather than to an app the user could dictate into.
 * `IsWindowVisible` is true for all of them and a few even carry a title, so
 * the class is the only cheap way to keep them out of the list.
 */
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'TaskListThumbnailWnd',
  'DV2ControlHost',
  'Windows.UI.Core.CoreWindow',
  'MultitaskingViewFrame',
  'ForegroundStaging',
  'XamlExplorerHostIslandWindow',
  'ApplicationManager_DesktopShellWindow',
  'Windows.Internal.Shell.TabProxyWindow',
  'MsgrIMEWindowClass',
  'IME',
  'SysShadow',
  'tooltips_class32'
])

/** One top-level window as Windows reports it, before any routing is applied. */
export interface VisibleWindow {
  title: string
  /** Process image name without `.exe`, e.g. `dsh` or `Code`. */
  appName: string
  pid: number
  className: string
  /** HWND in hex; stable enough to key list rows by. */
  handle: string
}

/** `Code.exe` → `Code`; the extension never helps a substring match. */
function stripExe(name: string): string {
  return name.replace(/\.exe$/i, '')
}

/** Both halves of what `QueryFullProcessImageNameW` reports for one pid. */
interface ProcessImage {
  /** Basename without `.exe`. */
  name: string
  /** Full path, '' when the query failed. */
  path: string
}

const NO_IMAGE: ProcessImage = { name: '', path: '' }

/**
 * Process image for a pid, cached per enumeration run: a browser with fifteen
 * windows must not open fifteen process handles for the same image.
 */
function processImage(pid: number, kernel32: Kernel32, cache: Map<number, ProcessImage>): ProcessImage {
  const cached = cache.get(pid)
  if (cached !== undefined) return cached

  let image = NO_IMAGE
  const handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (handle) {
    const buf = Buffer.alloc(IMAGE_CHARS * 2)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(IMAGE_CHARS, 0)
    if (kernel32.QueryFullProcessImageNameW(handle, 0, buf, size) !== 0) {
      const chars = Math.min(size.readUInt32LE(0), IMAGE_CHARS)
      const full = buf.toString('utf16le', 0, chars * 2)
      image = { name: stripExe(winPath.basename(full)), path: full }
    }
    kernel32.CloseHandle(handle)
  }

  cache.set(pid, image)
  return image
}

/** Process image name for a pid; see {@link processImage}. */
function processName(pid: number, kernel32: Kernel32, cache: Map<number, ProcessImage>): string {
  return processImage(pid, kernel32, cache).name
}

/** Stable, readable order: by app, then by title. */
function sortWindows(windows: VisibleWindow[]): VisibleWindow[] {
  return windows.sort((a, b) => {
    const left = (a.appName || a.title).localeCompare(b.appName || b.title, undefined, {
      sensitivity: 'base'
    })
    return left !== 0
      ? left
      : a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })
}

/**
 * Every visible, titled top-level window, at most {@link MAX_VISIBLE_WINDOWS}.
 *
 * Our own windows are skipped: "Typeless" is not a target the user would route
 * dictation into, and it would only appear because the settings sheet is open.
 */
export function listVisibleWindows(limit = MAX_VISIBLE_WINDOWS): VisibleWindow[] {
  const { user32, kernel32, enumProc } = win32()
  const found: VisibleWindow[] = []
  const names = new Map<number, ProcessImage>()

  const callback = koffi.register((hwnd: unknown): number => {
    try {
      if (found.length >= limit) return 0
      if (!user32.IsWindowVisible(hwnd)) return 1

      const titleBuf = Buffer.alloc(TITLE_CHARS * 2)
      const titleLen = user32.GetWindowTextW(hwnd, titleBuf, TITLE_CHARS)
      if (titleLen <= 0) return 1
      const title = titleBuf.toString('utf16le', 0, titleLen * 2).trim()
      if (!title) return 1

      const classBuf = Buffer.alloc(CLASS_CHARS * 2)
      const classLen = user32.GetClassNameW(hwnd, classBuf, CLASS_CHARS)
      const className = classLen > 0 ? classBuf.toString('utf16le', 0, classLen * 2) : ''
      if (SHELL_CLASSES.has(className)) return 1

      const pidBuf = Buffer.alloc(4)
      user32.GetWindowThreadProcessId(hwnd, pidBuf)
      const pid = pidBuf.readUInt32LE(0)
      if (pid === 0 || pid === process.pid) return 1

      found.push({
        title,
        appName: processName(pid, kernel32, names),
        pid,
        className,
        handle: koffi.address(hwnd).toString(16)
      })
      return 1
    } catch {
      // An exception inside a koffi callback would abort the whole enumeration;
      // skip the offending window and keep walking.
      return 1
    }
  }, koffi.pointer(enumProc))

  try {
    user32.EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }

  return sortWindows(found)
}

// --- routing ---------------------------------------------------------------

/** Which stage of the routing order produced a window's kind. */
export type RoutingSource = 'rule' | 'heuristic' | 'fallback'

/** A window plus what the dictation pipeline would do with it right now. */
export interface RoutedWindow extends VisibleWindow {
  matchedKind: PromptKind
  matchedBy: RoutingSource
  /** Rule that decided the kind, when `matchedBy === 'rule'`. */
  matchedRuleId: string | null
  matchedRuleLabel: string | null
  /** True when auto-activation is off, i.e. no rule or classifier ran at all. */
  pinned: boolean
}

/** The slice of settings the routing decision reads. */
export interface RoutingInput {
  autoActivatePrompts?: boolean
  mainPromptKind?: PromptKind
  appRules?: readonly AppRule[]
}

/**
 * A document hint appended to the window text, used only to interrogate the
 * shared classifier (see {@link routingSource}). It never reaches the answer the
 * user sees.
 */
const DOCUMENT_PROBE = ' wps'

/**
 * Did the built-in table actually recognise this window?
 *
 * `pickPromptKind` folds two very different outcomes into `polish`: "matched a
 * chat app" and "matched nothing at all". The settings page needs the
 * difference — a window nobody recognised is exactly the one that deserves a
 * manual rule — and the hint lists are private to `@shared/promptLibrary`, so
 * ask the classifier itself instead of copying them: append a document hint and
 * see whether the answer stays `polish`. It can only stay `polish` when an
 * earlier bucket (the chat hints) already matched.
 */
export function routingSource(
  kind: PromptKind,
  appName: string,
  windowTitle: string
): RoutingSource {
  if (kind !== 'polish') return 'heuristic'
  const probe = pickPromptKind(`${appName}${DOCUMENT_PROBE}`, `${windowTitle}${DOCUMENT_PROBE}`)
  return probe === 'polish' ? 'heuristic' : 'fallback'
}

/**
 * The same decision `resolvePromptKind` makes, plus the evidence for it.
 *
 * Order is the contract from `@shared/promptLibrary`: manual rules first, then
 * the built-in hint table, then plain polish. A pinned main kind (auto
 * activation off) short-circuits everything, which is why it is reported as
 * `pinned` instead of as a rule hit.
 */
export function classifyWindow(window: VisibleWindow, input: RoutingInput): RoutedWindow {
  if (input.autoActivatePrompts === false) {
    return {
      ...window,
      matchedKind: input.mainPromptKind ?? 'polish',
      matchedBy: 'fallback',
      matchedRuleId: null,
      matchedRuleLabel: null,
      pinned: true
    }
  }

  const rule = matchAppRule(input.appRules, window.appName, window.title)
  if (rule) {
    return {
      ...window,
      matchedKind: rule.kind,
      matchedBy: 'rule',
      matchedRuleId: rule.id,
      matchedRuleLabel: rule.label ?? rule.match,
      pinned: false
    }
  }

  const kind = pickPromptKind(window.appName, window.title)
  return {
    ...window,
    matchedKind: kind,
    matchedBy: routingSource(kind, window.appName, window.title),
    matchedRuleId: null,
    matchedRuleLabel: null,
    pinned: false
  }
}

/** {@link classifyWindow} over a list, for the settings picker. */
export function classifyWindows(
  windows: readonly VisibleWindow[],
  input: RoutingInput
): RoutedWindow[] {
  return windows.map((window) => classifyWindow(window, input))
}

/** Enumerate the window stack and classify every entry; feeds the IPC bridge. */
export function listRoutedWindows(input: RoutingInput): RoutedWindow[] {
  return classifyWindows(listVisibleWindows(), input)
}
