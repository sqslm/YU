import { expect, it, vi } from 'vitest'
import { prepareForGameMode, registerGameModePreparation } from './gameModePreparation'

it('allows reclamation only after every editor has saved, preserving a failed draft', async () => {
  let saved = false
  const note = vi.fn(async () => saved)
  const remove = registerGameModePreparation(note)
  try {
    expect(await prepareForGameMode()).toBe(false)
    saved = true
    expect(await prepareForGameMode()).toBe(true)
  } finally { remove() }
  expect(await prepareForGameMode()).toBe(true)
})
