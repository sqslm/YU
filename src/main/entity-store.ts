import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { normalizeEntity, type EntityInput, type EntityTerm } from '@shared/entities'

/** Uses the existing SQLite engine in a separate file: history retention may delete history.sqlite. */
export class EntityStore {
  private db: DatabaseSync | null = null
  private cache: EntityTerm[] | null = null
  constructor(private path: string) {}
  private handle(): DatabaseSync {
    if (this.db) return this.db
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout=250; CREATE TABLE IF NOT EXISTS entity_terms (id TEXT PRIMARY KEY, canonical TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(canonical COLLATE NOCASE, domain COLLATE NOCASE))')
      this.db = db; return db
    } catch (error) { db.close(); throw error }
  }
  list(): EntityTerm[] {
    if (!this.cache) this.cache = this.handle().prepare('SELECT * FROM entity_terms ORDER BY updated_at DESC LIMIT 10000').all().map(row => {
      const data = normalizeEntity(JSON.parse(String(row.data)))
      return { ...data, id: String(row.id), userDefined: data.userDefined !== false, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
    })
    return this.cache.map(row => ({ ...row, aliases: [...row.aliases], related: [...row.related] }))
  }
  save(input: EntityInput, id?: string): EntityTerm {
    const normalized = normalizeEntity(input), db = this.handle(), at = Date.now()
    if (id && !db.prepare('SELECT id FROM entity_terms WHERE id=?').get(id)) throw Error('词条不存在，请刷新重试')
    if (!id && Number(db.prepare('SELECT count(*) AS n FROM entity_terms').get()!.n) >= 10000) throw Error('词库最多保存 10000 项')
    const key = id || randomUUID()
    db.prepare('INSERT INTO entity_terms VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical=excluded.canonical, domain=excluded.domain, data=excluded.data, updated_at=excluded.updated_at').run(key, normalized.canonical, normalized.domain, JSON.stringify(normalized), at, at)
    this.cache = null
    return this.list().find(row => row.id === key)!
  }
  remove(id: string): void { this.handle().prepare('DELETE FROM entity_terms WHERE id=?').run(id); this.cache = null }
  import(value: unknown): number {
    const raw = Array.isArray(value) ? value : (value as { terms?: unknown })?.terms
    if (!Array.isArray(raw) || raw.length > 10000) throw Error('请选择最多 10000 项的 JSON 词库')
    const rows = raw.map(normalizeEntity), db = this.handle()
    db.exec('BEGIN IMMEDIATE')
    try {
      let added = 0
      let total = Number(db.prepare('SELECT count(*) AS n FROM entity_terms').get()!.n)
      const find = db.prepare('SELECT id FROM entity_terms WHERE canonical=? COLLATE NOCASE AND domain=? COLLATE NOCASE')
      const insert = db.prepare('INSERT INTO entity_terms VALUES (?,?,?,?,?,?)')
      for (const row of rows) {
        const existing = find.get(row.canonical, row.domain)
        // Import adds missing terms; existing personal edits always win.
        if (!existing) {
          if (++total > 10000) throw Error('词库最多保存 10000 项')
          const at = Date.now()
          insert.run(randomUUID(), row.canonical, row.domain, JSON.stringify(row), at, at); added++
        }
      }
      db.exec('COMMIT'); this.cache = null; return added
    } catch (error) { db.exec('ROLLBACK'); this.cache = null; throw error }
  }
  close(): void { this.db?.close(); this.db = null; this.cache = null }
}
