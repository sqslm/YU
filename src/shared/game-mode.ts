export interface GameModeSettings { enabled: boolean; processes: string[] }
export interface GameModeStatus {
  active: boolean
  source: 'none' | 'automatic' | 'manual'
  game: string
}

export const DEFAULT_GAME_MODE: GameModeSettings = { enabled: true, processes: [] }

export function normalizeGameProcesses(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().replace(/^"(.*)"$/, '$1').split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase())
    .filter(item => item.length > 0 && item.length <= 160))].slice(0, 64)
}
