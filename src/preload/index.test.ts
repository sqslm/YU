import { beforeEach, expect, it, vi } from 'vitest'
import type { TypelessApi } from '@shared/api'

const mock = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  exposed: null as unknown
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { mock.exposed = api } },
  ipcRenderer: {
    on: (name: string, callback: (...args: unknown[]) => void) => {
      if (!mock.listeners.has(name)) mock.listeners.set(name, new Set())
      mock.listeners.get(name)!.add(callback)
    },
    off: (name: string, callback: (...args: unknown[]) => void) => mock.listeners.get(name)?.delete(callback),
    removeListener: (name: string, callback: (...args: unknown[]) => void) => mock.listeners.get(name)?.delete(callback)
  }
}))
const emit = (name: string, payload?: unknown): void => { for (const callback of mock.listeners.get(name) ?? []) callback({}, payload) }
let card: TypelessApi['card']
beforeEach(async () => {
  mock.listeners.clear(); vi.resetModules()
  await import('./index')
  card = (mock.exposed as TypelessApi).card
})

it('retains the first answer arriving before React subscribes', async () => {
  const payload = { question: 'First question', answer: 'Actual answer' }
  emit('card:data', payload)
  const receive = vi.fn(); card.onData(receive)
  await Promise.resolve()
  expect(receive).toHaveBeenCalledExactlyOnceWith(payload)
})

it('does not replay a dismissed answer to a later subscription', async () => {
  const off = card.onData(vi.fn())
  emit('card:data', { question: 'Old question', answer: 'Old answer' }); off()
  emit('card:hidden')
  const receive = vi.fn(); card.onData(receive)
  await Promise.resolve()
  expect(receive).not.toHaveBeenCalled()
})

it('does not deliver a queued replay after the subscriber unmounts', async () => {
  card.onData(vi.fn()); emit('card:data', { question: 'Question', answer: 'Answer' })
  const receive = vi.fn(), off = card.onData(receive); off()
  await Promise.resolve()
  expect(receive).not.toHaveBeenCalled()
})
