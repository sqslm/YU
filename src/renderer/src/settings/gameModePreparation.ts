const preparations = new Set<() => Promise<boolean>>()

/** Editors may refuse reclamation while a draft cannot be saved. */
export function registerGameModePreparation(prepare: () => Promise<boolean>): () => void {
  preparations.add(prepare)
  return () => { preparations.delete(prepare) }
}

export async function prepareForGameMode(): Promise<boolean> {
  const results = await Promise.allSettled([...preparations].map(prepare => prepare()))
  return results.every(result => result.status === 'fulfilled' && result.value)
}
