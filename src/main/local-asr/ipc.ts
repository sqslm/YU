/**
 * IPC for the built-in local model.
 *
 * One handler per button on the page. Progress is not handled here: the host
 * pushes it through its own callback, and the main entry forwards it to the
 * settings window only — the bar and the answer card have no business repainting
 * for a file progress bar.
 */
import { dialog, shell } from 'electron'
import type { LocalAsrMirror } from '@shared/local-asr'
import type { LocalAsrHost } from './host'
import { mt } from '@shared/mainI18n'
import { handle } from '../ipc-trust'

export interface LocalAsrIpcOptions {
  host: LocalAsrHost
  /** Persists `localAsr` onto settings. */
  patch: (patch: { modelId?: string; modelDir?: string; language?: string; mirror?: LocalAsrMirror; enabled?: boolean }) => Promise<unknown>
  log: (line: string) => void
}

export function registerLocalAsrIpc(options: LocalAsrIpcOptions): void {
  const { host, patch, log } = options

  handle('localAsr:status', () => host.status())

  handle('localAsr:activate', async () => {
    const status = await host.activate()
    log(`[local-asr] activate → ${status.phase}: ${status.message}`)
    return status
  })

  handle('localAsr:release', async () => {
    host.release()
    return host.status()
  })

  handle('localAsr:rescan', () => host.rescan())

  handle('localAsr:download', async (_event, mirror?: LocalAsrMirror) => {
    const status = await host.download(mirror)
    log(`[local-asr] download → present=${status.present}: ${status.message}`)
    return status
  })

  handle('localAsr:remove', () => host.remove())

  handle('localAsr:pickDir', async () => {
    const current = await host.status()
    const picked = await dialog.showOpenDialog({
      title: mt('选择模型所在的目录'),
      defaultPath: current.dir || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    await patch({ modelDir: picked.filePaths[0] })
    return host.rescan()
  })

  handle('localAsr:clearDir', async () => {
    await patch({ modelDir: '' })
    return host.rescan()
  })

  handle('localAsr:openDir', async () => {
    const status = await host.status()
    if (!status.dir) return false
    await shell.openPath(status.dir)
    return true
  })
}
