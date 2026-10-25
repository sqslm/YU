import koffi from 'koffi'
import { getSelection } from './tools/selection'
import { foregroundWindow } from './foreground'
import { insertText } from './insert'
import type { Settings } from '@shared/types'
import type { SelectionTarget } from './selection-editor'
import { mt } from '@shared/mainI18n'
import type { PromptContext } from '@shared/prompts'
import { assistantAppExcluded } from '@shared/assistantAccess'

/** Restore the original window, then recheck the exact selection before editing. */
export async function captureSelectionTarget(settings: Settings, original?: PromptContext, signal?: AbortSignal): Promise<SelectionTarget> {
  const user32 = koffi.load('user32.dll')
  const getForeground = user32.func('void *GetForegroundWindow()')
  const setForeground = user32.func('int SetForegroundWindow(void *hWnd)')
  const getPid = user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, void *pid)')
  const isWindow = user32.func('int IsWindow(void *hWnd)')
  const key = user32.func('void keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)')
  if (original) {
    if(assistantAppExcluded(original.appName,original.appPath,settings.assistantAccess))throw new Error(mt('此应用已排除上下文读取'))
    signal?.throwIfAborted()
    if (!original.windowHandle || !/^\d+$/.test(original.windowHandle) || !original.processId) throw new Error(mt('没有可用的原窗口信息，请从目标应用重新呼出助手'))
    if (/1password|keepass|bitwarden|lastpass|password|密码/iu.test(`${original.appName} ${original.appPath}`)) throw new Error(mt('敏感应用不允许读取上下文'))
    const hwnd = BigInt(original.windowHandle)
    const exists = user32.func('int IsWindow(uintptr_t hwnd)')
    const readPid = user32.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, void *pid)')
    const focus = user32.func('int SetForegroundWindow(uintptr_t hwnd)')
    const pid = Buffer.alloc(4); readPid(hwnd, pid)
    if (!exists(hwnd) || pid.readUInt32LE(0) !== original.processId || !focus(hwnd)) throw new Error(mt('无法返回原输入框，请重新选择文字'))
    await new Promise(resolve => setTimeout(resolve, 80))
    signal?.throwIfAborted()
    const current = foregroundWindow(), focused = getForeground()
    if (!focused || String(koffi.address(focused)) !== original.windowHandle || current.pid !== original.processId || current.title !== original.windowTitle) throw new Error(mt('目标窗口已变化，请重新选择文字'))
  }
  const handle = getForeground()
  const context = foregroundWindow()
  if(assistantAppExcluded(context.appName,context.appPath,settings.assistantAccess))throw new Error(mt('此应用已排除上下文读取'))
  const selected = await getSelection()
  if (!selected.ok || !selected.text) throw new Error(mt(selected.error ?? '没有选中文字'))
  const sameWindow = (): boolean => Boolean(handle && getForeground() && koffi.address(getForeground()) === koffi.address(handle))
  if (!sameWindow()) throw new Error(mt('目标窗口已变化，请重新选择文字'))
  return {
    text: selected.text,
    context: { appName: context.appName, windowTitle: context.title, processId: context.pid, appPath: context.appPath },
    async apply(text, append, signal) {
      signal.throwIfAborted()
      const pid = Buffer.alloc(4)
      getPid(handle, pid)
      if (!isWindow(handle) || pid.readUInt32LE(0) !== context.pid || !setForeground(handle)) throw new Error(mt('无法返回原输入框，请重新选择文字'))
      await new Promise(resolve => setTimeout(resolve, 80))
      signal.throwIfAborted()
      if (!sameWindow()) throw new Error(mt('目标窗口已变化，请重新选择文字'))
      if(foregroundWindow().title!==context.title)throw new Error(mt('目标窗口已变化，请重新选择文字'))
      const current = await getSelection()
      if (!sameWindow() || !current.ok || current.text !== selected.text) throw new Error(mt('选区已变化，未修改文字；请重新选择'))
      signal.throwIfAborted()
      if (append) {
        // Ctrl+End collapses selection and places the caret at the field's end.
        key(0x11, 0, 0, 0); key(0x23, 0, 0, 0); key(0x23, 0, 2, 0); key(0x11, 0, 2, 0)
      }
      await insertText(append ? `\n${text}` : text, {
        method: settings.insertMethod, restoreClipboard: settings.restoreClipboard, multiline: 'keep'
      })
    }
  }
}

/** A card owns only the selection its task actually read, never the currently focused app. */
export async function applyAnswerSelection(settings: Settings, context: PromptContext | undefined, text: string, signal: AbortSignal): Promise<void> {
  const expected = context?.task?.selection
  if (!context || !expected) throw new Error(mt('请先选中文字，或提供要处理的文本'))
  signal.throwIfAborted()
  const target = await captureSelectionTarget(settings, context, signal)
  if (target.text !== expected) throw new Error(mt('选区内容已变化，请重新选择文字'))
  await target.apply(text, false, signal)
  if (context.task) context.task.state = 'completed'
}
