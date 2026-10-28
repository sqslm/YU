import type { GameModeSettings, GameModeStatus } from '@shared/game-mode'

export interface GameObservation {
  pid: number
  process: string
  className: string
  fullScreen3d: boolean
}

const GAMES = new Set([
  'cs2', 'csgo', 'dota2', 'league of legends', 'valorant-win64-shipping',
  'tslgame', 'overwatch', 'fortniteclient-win64-shipping', 'apex', 'r5apex',
  'yuanshen', 'genshinimpact', 'starrail', 'zenlesszonezero', 'wuthering waves',
  'eldenring', 'b1-win64-shipping', 'gta5', 'gta5_enhanced', 'minecraft.windows',
  'destiny2', 'rainbowsix', 'rainbowsix_vulkan'
])
const NON_GAMES = new Set(['chrome', 'msedge', 'firefox', 'ego', 'brave', 'opera', 'iexplore', 'powerpnt', 'potplayermini64', 'vlc', 'mpv', 'explorer', 'yu', 'unrealeditor', 'ue4editor'])

/** Full-screen desktop apps alone are not evidence of a game. */
export function isGame(observation: GameObservation, custom: string[]): boolean {
  if (!observation.pid) return false
  const name = observation.process.toLowerCase().replace(/\.exe$/, '')
  if (custom.includes(name)) return true
  if (NON_GAMES.has(name)) return false
  return GAMES.has(name) || /^(UnityWndClass|UnrealWindow)$/i.test(observation.className) || observation.fullScreen3d
}

/** Keeps detected games latched through Alt+Tab, until every tracked process exits. */
export class GameMode {
  private settings: GameModeSettings = { enabled: false, processes: [] }
  private games = new Map<number, string>()
  private manual = false
  private timer: ReturnType<typeof setInterval> | null = null
  private state: GameModeStatus = { active: false, source: 'none', game: '' }
  private failed = false

  constructor(private deps: {
    observe: () => GameObservation
    alive: (pid: number) => boolean
    changed: (status: GameModeStatus) => void
    log: (message: string) => void
  }) {}

  snapshot(): GameModeStatus { return { ...this.state } }

  configure(settings: GameModeSettings): void {
    this.settings = settings
    if (!settings.enabled) this.games.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = settings.enabled ? setInterval(() => this.poll(), 1000) : null
    this.timer?.unref?.()
    this.poll()
  }

  setManual(active: boolean): GameModeStatus {
    this.manual = active
    this.poll()
    return this.snapshot()
  }

  poll(): void {
    try {
      for (const pid of this.games.keys()) if (!this.deps.alive(pid)) this.games.delete(pid)
      if (this.settings.enabled) {
        const current = this.deps.observe()
        if (isGame(current, this.settings.processes)) this.games.set(current.pid, current.process || current.className)
      }
      this.failed = false
    } catch (error) {
      // Keep the current latch on an observation failure, never restore hotkeys blindly.
      if (!this.failed) this.deps.log(`[game-mode] detection failed: ${String(error)}`)
      this.failed = true
    }
    const next: GameModeStatus = { active: this.manual || this.games.size > 0,
      source: this.manual ? 'manual' : this.games.size ? 'automatic' : 'none', game: [...this.games.values()][0] ?? '' }
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.deps.changed(this.snapshot())
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
