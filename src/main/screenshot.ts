import { desktopCapturer } from 'electron'
import type { PromptContext } from '@shared/prompts'
import { mt } from '@shared/mainI18n'
import { windowsNative } from './windows-native'
import { runWithDeadline } from './tools/read-webpage'

export interface WindowScreenshot { png: Uint8Array; dataUrl: string; width: number; height: number; title: string }

/** One explicit task, one original window; never fall back to an entire display. */
export async function captureOriginalWindow(context: PromptContext, signal: AbortSignal): Promise<WindowScreenshot> {
  signal.throwIfAborted()
  if (!context.windowHandle || !/^\d+$/.test(context.windowHandle) || !context.processId) throw new Error(mt('没有可用的原窗口信息，请从目标应用重新呼出助手'))
  if (/1password|keepass|bitwarden|lastpass|password|密码/iu.test(`${context.appName} ${context.appPath}`)) throw new Error(mt('敏感应用不允许读取上下文'))
  const request = { action: 'window-check', handle: context.windowHandle, pid: context.processId, title: context.windowTitle }
  await windowsNative(request, signal)
  const result = await runWithDeadline(() => desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1200 }, fetchWindowIcons: false }), signal, 10000)
  signal.throwIfAborted()
  if (!result.ok) throw new Error(mt('窗口截图失败，请恢复目标窗口后重试'))
  const source = result.value.find(item => item.id.split(':')[0] === 'window' && item.id.split(':')[1] === context.windowHandle)
  if (!source || source.thumbnail.isEmpty()) throw new Error(mt('窗口截图失败，请恢复目标窗口后重试'))
  await windowsNative(request, signal)
  signal.throwIfAborted()
  const png = source.thumbnail.toPNG(), { width, height } = source.thumbnail.getSize()
  if (!width || !height || png.byteLength > 6 * 1024 * 1024) throw new Error(mt('窗口截图无效或过大，请缩小窗口后重试'))
  return { png, dataUrl: `data:image/png;base64,${png.toString('base64')}`, width, height, title: context.windowTitle || '' }
}
