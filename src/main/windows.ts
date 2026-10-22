import { BrowserWindow, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import type { BarWindowLayout, ThemeMode } from '@shared/types'
import { BAR_HEIGHT, BAR_WIDTH, barCaptionRect } from './barLayout'
import { openExternalSafely } from './safeLink'
import { mt } from '@shared/mainI18n'
import {
  CARD_INITIAL_HEIGHT,
  CARD_MAX_HEIGHT,
  CARD_MIN_HEIGHT,
  CARD_WIDTH,
  cardRect,
  clampCardHeight
} from './cardLayout'

// CJS main bundle: __dirname points at out/main.
const here = __dirname
const preload = join(here, '../preload/index.js')
const rendererDir = join(here, '../renderer')
const devServer = process.env['ELECTRON_RENDERER_URL']

type Page = 'settings' | 'bar' | 'card' | 'login' | 'reminder'

function loadPage(win: BrowserWindow, page: Page): void {
  if (devServer) void win.loadURL(`${devServer}/${page}.html`)
  else void win.loadFile(join(rendererDir, `${page}.html`))
}

/** One closable, ordinary OS window for the whole strong-reminder queue. */
export function createReminderWindow(mode: ThemeMode): BrowserWindow {
  const win = new BrowserWindow({ width: 480, height: 380, minWidth: 400, minHeight: 300,
    title: `${mt('强提醒')} · Typeless Rebuild`, show: false, alwaysOnTop: true, autoHideMenuBar: true,
    backgroundColor: hubBackgroundColor(mode),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.showInactive())
  loadPage(win, 'reminder')
  return win
}

/** Height of the native window-controls strip drawn over the app content. */
export const TITLE_BAR_HEIGHT = 40

interface Chrome {
  color: string
  symbolColor: string
  /** Glyph colour while a dialog dims the page behind the window buttons. */
  symbolDim: string
}

/**
 * Canvas colour of the hub per theme. The window background has to match it,
 * otherwise Windows paints a dark canvas while the page is still light.
 */
const HUB_CHROME: Record<'dark' | 'light', Chrome> = {
  dark: { color: '#232323', symbolColor: '#f1f1f1', symbolDim: '#6b6b6b' },
  light: { color: '#f6f6f8', symbolColor: '#1b1b1d', symbolDim: '#9a9aa2' }
}

/**
 * The overlay is transparent and the renderer paints the 40px strip itself.
 *
 * An opaque overlay is a band the app cannot dim: opening a dialog darkens the
 * page to near-black while the native strip keeps `#232323` and its bright
 * glyphs, which reads as three buttons glowing on a black window. Transparent
 * lets the page (and its modal backdrop) show through, and `symbolDim` takes the
 * glyphs down with it — see `applyHubTheme`.
 */
const OVERLAY_COLOR = '#00000000'

/**
 * Which palette `mode` actually paints with.
 *
 * `'system'` is stored, never rendered: Windows owns the answer through
 * `nativeTheme`, and the caller re-runs this when the OS flips its appearance.
 */
export function resolveThemeMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return mode
}

export function hubBackgroundColor(mode: ThemeMode): string {
  return HUB_CHROME[resolveThemeMode(mode)].color
}

/**
 * Repaints the window chrome after a theme switch: the OS button glyphs follow
 * the new palette, and the window's own background colour changes with them so
 * no flash of the old canvas shows while the renderer repaints.
 *
 * `dimmed` is set while a dialog is open in the hub, so the buttons do not stay
 * the brightest thing on a black window.
 */
export function applyHubTheme(win: BrowserWindow, mode: ThemeMode, dimmed = false): void {
  if (win.isDestroyed()) return
  const chrome = HUB_CHROME[resolveThemeMode(mode)]
  win.setBackgroundColor(chrome.color)
  win.setTitleBarOverlay({
    color: OVERLAY_COLOR,
    symbolColor: dimmed ? chrome.symbolDim : chrome.symbolColor,
    height: TITLE_BAR_HEIGHT
  })
}

/**
 * Main settings window (history, providers, shortcuts).
 *
 * The frame is replaced by a title-bar overlay: the app content starts at y=0
 * and the only native pixels are the min/max/close buttons in the top-right.
 * The renderer already reserves the matching 40px strip and paints its own
 * draggable region there.
 */
export function createSettingsWindow(mode: ThemeMode = 'dark'): BrowserWindow {
  const chrome = HUB_CHROME[resolveThemeMode(mode)]
  const win = new BrowserWindow({
    width: 1080,
    height: 750,
    minWidth: 940,
    minHeight: 620,
    title: 'Typeless Rebuild',
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: OVERLAY_COLOR,
      symbolColor: chrome.symbolColor,
      height: TITLE_BAR_HEIGHT
    },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Nothing here is a document the user spell-checks, and the checker loads a
      // dictionary into every renderer: turn it off rather than pay for it.
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  loadPage(win, 'settings')
  return win
}

/**
 * The sign-in window.
 *
 * A separate window rather than a panel in settings, and deliberately closable:
 * nothing in the app requires an account, so this is a place to sign in — not a
 * gate. It is single-instance so double-clicking 「登录」 cannot stack two forms
 * over each other.
 */
let loginWindow: BrowserWindow | null = null

export function openLoginWindow(mode: ThemeMode = 'dark'): BrowserWindow {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.isMinimized()) loginWindow.restore()
    loginWindow.show()
    loginWindow.focus()
    return loginWindow
  }
  const chrome = HUB_CHROME[resolveThemeMode(mode)]
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    title: 'Typeless Rebuild',
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: OVERLAY_COLOR,
      symbolColor: chrome.symbolColor,
      height: TITLE_BAR_HEIGHT
    },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    loginWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  loadPage(win, 'login')
  loginWindow = win
  return win
}

export function closeLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
}

export interface BarPlacement {
  x: number
  y: number
}

/** Default spot: centred horizontally, a little above the taskbar. */
export function defaultBarPlacement(): BarPlacement {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(workArea.x + (workArea.width - BAR_WIDTH) / 2),
    y: workArea.y + workArea.height - BAR_HEIGHT - 96
  }
}

/**
 * Keeps a restored position usable: monitors get unplugged and resolutions
 * change, which would otherwise leave the bar off-screen forever.
 */
export function clampBarPlacement(position: BarPlacement | null): BarPlacement {
  if (!position) return defaultBarPlacement()
  const inside = screen.getAllDisplays().some(({ workArea }) => {
    const withinX = position.x >= workArea.x - 40 && position.x <= workArea.x + workArea.width - 40
    const withinY = position.y >= workArea.y - 20 && position.y <= workArea.y + workArea.height - 20
    return withinX && withinY
  })
  if (!inside) return defaultBarPlacement()
  const { workArea } = screen.getDisplayNearestPoint({ x: position.x + BAR_WIDTH / 2, y: position.y + BAR_HEIGHT / 2 })
  return { x: Math.max(workArea.x, Math.min(position.x, workArea.x + workArea.width - BAR_WIDTH)),
    y: Math.max(workArea.y, Math.min(position.y, workArea.y + workArea.height - BAR_HEIGHT)) }
}

/**
 * The recording bar. It is a non-activating always-on-top window: showing it
 * must never steal focus, otherwise SendInput would type into our own window
 * instead of the app the user was dictating into.
 */
export function createBarWindow(position: BarPlacement | null): BrowserWindow {
  const spot = clampBarPlacement(position)

  const win = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    x: spot.x,
    y: spot.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The pill draws frames continuously, so spelling can never be needed here.
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // The pill is a pure notice: it has no buttons, so it never needs the mouse
  // and stays click-through in every state. `forward` keeps the pointer moving
  // underneath (hover, text selection) intact instead of freezing it.
  win.setIgnoreMouseEvents(true, { forward: true })

  // The answer card anchors itself to this pill. Tracking the bounds here as
  // well as through `rememberBarBounds` means the anchor stays correct even
  // before (or without) the caller wiring `barWindow.on('move')`.
  barWindow = win
  captionVisible = false
  barLayout = { barTop: 0, captionSide: 'above' }
  rememberBarBounds(win.getBounds())
  win.on('move', () => {
    if (captionVisible) setBarCaptionVisible(true)
    rememberBarBounds(recordingBarBounds(win))
    const card = cardWindow
    // Keep a visible answer card glued to the pill while it is being dragged.
    if (card && !card.isDestroyed() && card.isVisible()) placeCard(card)
  })
  win.on('closed', () => {
    if (barWindow === win) barWindow = null
  })

  loadPage(win, 'bar')
  return win
}

let captionVisible = false
let barLayout: BarWindowLayout = { barTop: 0, captionSide: 'above' }

/** Saved positions and answer-card anchors always refer to the 340×60 strip. */
export function recordingBarBounds(win: BrowserWindow): Electron.Rectangle {
  const bounds = win.getBounds()
  return { x: bounds.x, y: bounds.y + barLayout.barTop, width: BAR_WIDTH, height: BAR_HEIGHT }
}

export function setBarCaptionVisible(visible: boolean): void {
  const win = barWindow
  if (!win || win.isDestroyed()) return
  const base = recordingBarBounds(win)
  const { workArea } = screen.getDisplayNearestPoint({ x: base.x + BAR_WIDTH / 2, y: base.y + BAR_HEIGHT / 2 })
  const { bounds, layout } = barCaptionRect(base, workArea, visible)
  const old = win.getBounds()
  const changed = old.x !== bounds.x || old.y !== bounds.y || old.width !== bounds.width || old.height !== bounds.height ||
    barLayout.barTop !== layout.barTop || barLayout.captionSide !== layout.captionSide
  captionVisible = visible
  barLayout = layout
  if (!changed) return
  win.setBounds(bounds, false)
  rememberBarBounds(recordingBarBounds(win))
  win.webContents.send('bar:layout', layout)
}

// --- answer card -----------------------------------------------------------

/**
 * Last known bounds of the recording pill, in screen DIP.
 *
 * The card appears *out of* the pill ("from just above the recording bar"), so
 * it needs a position that survives hiding the window between two answers.
 * `main/index.ts` feeds this from `recordingBarBounds()`; the bar window built
 * above updates it on every move as well, so the anchor is correct even when
 * nobody else reports it.
 */
let lastBarBounds: Electron.Rectangle | null = null

/** Live window handles, used to keep the anchor fresh without extra wiring. */
let barWindow: BrowserWindow | null = null
let cardWindow: BrowserWindow | null = null

/** Height the renderer last reported; reused the next time the card shows. */
let lastCardHeight = CARD_INITIAL_HEIGHT

/** Remembers where the pill is so the card can be centred above it. */
export function rememberBarBounds(bounds: Electron.Rectangle): void {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return
  lastBarBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

/**
 * Anchor source, in priority order: explicitly reported bounds, then the live
 * bar window. The fallback (no pill at all) is handled by `cardRect`.
 */
function currentBarBounds(): Electron.Rectangle | null {
  if (lastBarBounds) return lastBarBounds
  const bar = barWindow
  if (bar && !bar.isDestroyed()) return bar.getBounds()
  return null
}

/**
 * The work area of the display the pill lives on.
 *
 * Picking the display from the pill's centre (instead of the cursor or the
 * primary display) is what makes a bar dragged to a second monitor — possibly
 * with a different DPI scale — produce a card on that same monitor.
 */
function workAreaFor(bar: Electron.Rectangle | null): Electron.Rectangle {
  const point = bar
    ? { x: Math.round(bar.x + bar.width / 2), y: Math.round(bar.y + bar.height / 2) }
    : screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(point).workArea
}

/** Applies the computed rectangle to the window, without animating it. */
function placeCard(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bar = currentBarBounds()
  const [width, height] = win.getSize()
  const rect = cardRect({ width, height, bar, workArea: workAreaFor(bar) })
  win.setPosition(rect.x, rect.y, false)
}

/**
 * Re-applies the card position whenever the pill moved. Call it from
 * `barWindow.on('move')`; a visible card follows the pill, a hidden one is
 * simply re-anchored for its next appearance.
 */
export function anchorCardToBar(card: BrowserWindow, barBounds: Electron.Rectangle): void {
  if (card.isDestroyed()) return
  rememberBarBounds(barBounds)
  placeCard(card)
}

/**
 * Resizes the card to the content height reported by the renderer and re-runs
 * the anchoring pass, so growing content pushes the card *upwards* instead of
 * sliding its bottom edge away from the pill.
 *
 * Height is reported through the `card:height` channel by
 * `window.api.card.reportHeight(h)` — the renderer cannot reach `ipcRenderer`
 * directly (contextIsolation), and `preload/index.ts` is owned elsewhere, so the
 * renderer calls the optional bridge method and this function consumes the
 * resulting number. `main/index.ts` wires the channel to this function.
 */
export function resizeCardToContent(card: BrowserWindow, height: number): void {
  if (card.isDestroyed()) return
  const next = clampCardHeight(height)
  lastCardHeight = next
  const [width, current] = card.getSize()
  if (width !== CARD_WIDTH || current !== next) {
    card.setSize(CARD_WIDTH, next, false)
  }
  placeCard(card)
}

/**
 * Places the card just above the pill, centred on it.
 *
 * Falls back to the old bottom-centre spot while no pill position is known, so
 * the very first show can never throw or land off-screen. Width is re-asserted
 * on every call (the card is never user-resizable horizontally) and the height
 * is restored to the last reported content height.
 */
export function positionCardWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const [width, height] = win.getSize()
  if (width !== CARD_WIDTH || height !== lastCardHeight) {
    win.setSize(CARD_WIDTH, lastCardHeight, false)
  }
  placeCard(win)
}

/**
 * The Ask Anything answer card.
 *
 * Frameless and shadowless like the bar: the colour, the 14px radius and the
 * 1px hairline border come from the renderer, so the window itself contributes
 * no dark halo. It is not focusable-by-show (showInactive) so a finished take
 * never yanks the caret out of the app the user was dictating into, but it
 * stays clickable for the buttons and the follow-up input.
 *
 * The window is horizontally fixed at CARD_WIDTH and only ever grows
 * vertically: `resizable` is on so `setSize` is honoured everywhere, while the
 * min/max width pinning keeps the user from dragging the card sideways.
 */
export function createCardWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: CARD_WIDTH,
    height: CARD_INITIAL_HEIGHT,
    minWidth: CARD_WIDTH,
    maxWidth: CARD_WIDTH,
    minHeight: CARD_MIN_HEIGHT,
    maxHeight: CARD_MAX_HEIGHT,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Nothing here is a document the user spell-checks, and the checker loads a
      // dictionary into every renderer: turn it off rather than pay for it.
      spellcheck: false
    }
  })

  // Below the bar's 'screen-saver' level but above normal app windows.
  win.setAlwaysOnTop(true, 'floating')

  // Source links open in the user's browser: the card renderer must never
  // navigate away from the answer (that would leave a dead white window).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalSafely(url)
  })

  // ESC is handled by the renderer so it can play `cardOut` before asking the
  // main process to hide the window; hiding from `before-input-event` would cut
  // the exit animation off at frame 0. The window is created once and kept
  // warm, so its keydown listener is always mounted.

  cardWindow = win
  win.on('closed', () => {
    if (cardWindow === win) cardWindow = null
  })

  win.on('ready-to-show', () => {
    positionCardWindow(win)
    win.showInactive()
  })

  loadPage(win, 'card')
  return win
}


// --- click-through control -------------------------------------------------

/**
 * Makes sure the pill can receive clicks.
 *
 * The pill is click-through by default — it floats over whatever the user is
 * doing and must not eat pointer events. But an alert can carry buttons
 * ("重试", "知道了"), and a visible button that swallows every click is worse than
 * no button: this call is what makes them real. `forward` keeps the pointer moving
 * underneath while capture is on.
 */
export function setBarInteractive(interactive: boolean): void {
  const win = barWindow
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(!interactive, { forward: true })
}
