import koffi from 'koffi'
import { getSelection } from './tools/selection'
import { foregroundWindow } from './foreground'
import { insertText } from './insert'
import type { Settings } from '@shared/types'
import type { SelectionTarget } from './selection-editor'
import { mt } from '@shared/mainI18n'

/** Restore the original window, then recheck the exact selection before editing. */
export async function captureSelectionTarget(settings: Settings): Promise<SelectionTarget> {
  const user32 = koffi.load('user32.dll')
  const getForeground = user32.func('void *GetForegroundWindow()')
  const setForeground = user32.func('int SetForegroundWindow(void *hWnd)')
  const getPid = user32.func('uint32_t GetWindowThreadProcessId(void *hWnd, void *pid)')
  const isWindow = user32.func('int IsWindow(void *hWnd)')
  const key = user32.func('void keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)')
  const handle = getForeground()
  const context = foregroundWindow()
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
