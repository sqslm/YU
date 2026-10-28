import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { EntityStore } from './entity-store'
import type { EntityInput } from '@shared/entities'
const roots: string[] = [], stores: EntityStore[] = []
afterEach(() => { stores.forEach(store => store.close()); roots.forEach(root => rmSync(root, { recursive: true, force: true })); stores.length = 0; roots.length = 0 })
const term: EntityInput = { canonical: 'Kubernetes', type: 'technology', aliases: ['库伯内提斯'], domain: '技术', related: ['Docker'], source: 'https://kubernetes.io/', verified: true, enabled: true }
function setup(): { store: EntityStore; path: string } { const root = mkdtempSync(join(tmpdir(), 'yu-entities-')); roots.push(root); const path = join(root, 'entities.sqlite'); const store = new EntityStore(path); stores.push(store); return { store, path } }
it('persists CRUD without changing private history, accepts search metadata and disabled entries', () => {
  const { store, path } = setup(), saved = store.save(term)
  expect(saved).toMatchObject({ ...term, id: expect.any(String), userDefined: true })
  store.save({ ...term, enabled: false, aliases: ['库伯内提斯', '库伯尼提斯'] }, saved.id)
  store.close(); expect(store.list()[0].enabled).toBe(false)
  const second = new EntityStore(path); stores.push(second); expect(second.list()[0].aliases).toHaveLength(2)
  store.remove(saved.id); expect(store.list()).toEqual([])
})
it('imports atomically, deduplicates names and preserves existing personal edits', () => {
  const { store } = setup(); store.save(term)
  expect(store.import({ terms: [{ ...term, aliases: ['wrong'] }, { ...term, canonical: 'Docker' }] })).toBe(1)
  expect(store.list().find(row => row.canonical === 'Kubernetes')?.aliases).toEqual(term.aliases)
  expect(() => store.import([{ ...term, canonical: 'New' }, { canonical: '' }])).toThrow()
  expect(store.list()).toHaveLength(2)
})
it('reports damaged databases without replacing or quarantining the history file', () => {
  const { store, path } = setup(); writeFileSync(path, 'invalid sqlite')
  expect(() => store.list()).toThrow()
})
