/**
 * Who is allowed to call into the main process.
 *
 * Every window this app creates is sandboxed with `contextIsolation`, and the
 * only thing that crosses into the page is the preload bridge. That still leaves
 * one door: `ipcRenderer.invoke` works from *any* renderer of this process,
 * including a frame the user's link opened inside a page. So instead of trusting
 * whatever arrives, main keeps a register of the windows it created and refuses
 * anything else.
 *
 * The register is keyed by `webContents.id` because that is the one identifier
 * both sides agree on and the sender cannot forge. Registration is dropped when
 * the window dies, so a recycled id is never trusted by accident.
 *
 * The decision itself lives in `allowsIpc`, a pure function, so it can be tested
 * without booting Electron.
 */
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

/** The bits of a sender the decision needs; `WebContents` satisfies this. */
export interface IpcSender {
  readonly id: number
  readonly mainFrame: unknown
}

export interface IpcCaller {
  readonly sender: IpcSender
  readonly senderFrame: unknown
}

const trustedIds = new Set<number>()

/**
 * The rule: the caller must be a window we created, and must be calling from
 * that window's top frame.
 *
 * A `null` frame is allowed because Electron reports it when the frame has
 * already gone (the window is closing while a flush is in flight); the frame
 * cannot be an iframe in that case, and the id check has already passed.
 * Everything else — an unknown id, or a sub-frame of a trusted window — is
 * refused: a link the user opened inside the card must not reach the main
 * process even though it lives in a window we own.
 */
export function allowsIpc(caller: IpcCaller, ids: ReadonlySet<number>): boolean {
  if (!ids.has(caller.sender.id)) return false
  if (caller.senderFrame === null) return true
  return caller.senderFrame === caller.sender.mainFrame
}

/** Start trusting one window's renderer. Safe to call twice. */
export function trustWindow(win: BrowserWindow | null | undefined): void {
  const contents = win?.webContents
  if (!contents || contents.isDestroyed()) return
  const { id } = contents
  trustedIds.add(id)
  contents.once('destroyed', () => { trustedIds.delete(id) })
}

/** Test seam: lets a test run the real decision without any windows. */
export function trustedWindowCount(): number {
  return trustedIds.size
}

/** Test seam: forget every registration (used between tests and on quit). */
export function forgetTrustedWindows(): void {
  trustedIds.clear()
}

/**
 * True when the first argument is an IPC event at all.
 *
 * Electron always supplies one, so in the app this is always true. It is false
 * only when a handler is called directly — a unit test driving the captured
 * listener, or internal code reusing it. That call cannot come from a renderer
 * (a page never gets to invent the event object), so the register check is
 * skipped rather than the call being refused.
 */
function isIpcCall(value: unknown): value is IpcCaller {
  if (typeof value !== 'object' || value === null) return false
  const sender = (value as { sender?: unknown }).sender
  return typeof sender === 'object' && sender !== null && typeof (sender as IpcSender).id === 'number'
}

function assertTrusted(caller: unknown): void {
  if (!isIpcCall(caller)) return
  if (allowsIpc(caller, trustedIds)) return
  // The URL is the only part worth logging; it is also what makes a denied call
  // diagnosable instead of a mystery ("some handler returned undefined").
  const url = (caller.senderFrame as { url?: string } | null)?.url ?? '<no frame>'
  throw new Error(`Blocked IPC from an untrusted renderer: ${url}`)
}

/**
 * `ipcMain.handle` with the register in front of it.
 *
 * Handlers keep their exact signatures; only the registration call changes, so a
 * forgotten guard is impossible by construction rather than by review.
 */
export function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrusted(event)
    return listener(event, ...(args as never[]))
  })
}

/**
 * Same guard for fire-and-forget messages.
 *
 * These are dropped silently rather than thrown: the sender is gone by the time
 * anyone could read the error, and `ipcRenderer.send` has no reply channel.
 */
export function subscribe(
  channel: string,
  listener: (event: IpcMainEvent, ...args: never[]) => void
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (isIpcCall(event) && !allowsIpc(event, trustedIds)) return
    listener(event, ...(args as never[]))
  })
}
