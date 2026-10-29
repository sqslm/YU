import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatDetail, ChatEdit, ChatGroup, ChatMessage, ChatThread } from '@shared/chat'
import type { SearchResult } from '@shared/types'

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw Error('名称需为 1–80 字')
  return value.trim()
}
/** Local conversations, opened on demand. SQLite owns transactions and persistence. */
export class ChatStore {
  private database: DatabaseSync | null = null
  constructor(private path: string) {}
  private get db(): DatabaseSync {
    if (!this.database) {
      mkdirSync(dirname(this.path), { recursive: true })
      const db = new DatabaseSync(this.path)
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, groupId TEXT REFERENCES chat_groups(id) ON DELETE SET NULL, updatedAt INTEGER NOT NULL, manualTitle INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, threadId TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(threadId,seq);
        UPDATE chat_messages SET state='cancelled' WHERE state='working';`)
      this.database = db
      if (!db.prepare('PRAGMA table_info(chat_threads)').all().some(column => column.name === 'memoryTemporary')) db.exec('ALTER TABLE chat_threads ADD COLUMN memoryTemporary INTEGER NOT NULL DEFAULT 0')
    }
    return this.database
  }
  list(): { threads: ChatThread[]; groups: ChatGroup[] } {
    return { threads: this.db.prepare('SELECT * FROM chat_threads ORDER BY updatedAt DESC,id').all().map(row => ({ ...row, manualTitle: Boolean(row.manualTitle), memoryTemporary: Boolean(row.memoryTemporary) })) as unknown as ChatThread[], groups: this.db.prepare('SELECT * FROM chat_groups ORDER BY name,id').all() as unknown as ChatGroup[] }
  }
  get(id: string, limit = 100): ChatDetail {
    if (typeof id !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw Error('无效的对话请求')
    const row = this.db.prepare('SELECT * FROM chat_threads WHERE id=?').get(id)
    if (!row) throw Error('对话不存在，请刷新')
    const messages = this.db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE threadId=? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(id, limit)
    return { ...row, manualTitle: Boolean(row.manualTitle), memoryTemporary: Boolean(row.memoryTemporary), messages: messages.map(message => ({ id: message.id, role: message.role, text: message.text, state: message.state, createdAt: message.createdAt, sources: JSON.parse(String(message.sources)) })) as ChatMessage[], total: Number(this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE threadId=?').get(id)!.n) } as ChatDetail
  }
  create(groupId: string | null = null): ChatDetail {
    this.group(groupId)
    const id = randomUUID()
    this.db.prepare('INSERT INTO chat_threads(id,title,groupId,updatedAt) VALUES(?,?,?,?)').run(id, '新对话', groupId, Date.now())
    return this.get(id)
  }
  private group(id: string | null): void {
    if (id !== null && (typeof id !== 'string' || !this.db.prepare('SELECT id FROM chat_groups WHERE id=?').get(id))) throw Error('分组不存在')
  }
  edit(input: ChatEdit): void {
    if (!input || typeof input !== 'object') throw Error('无效的对话操作')
    if ('id' in input && (typeof input.id !== 'string' || !input.id || input.id.length > 80)) throw Error('无效的对话 ID')
    switch (input.action) {
      case 'rename': this.db.prepare('UPDATE chat_threads SET title=?,manualTitle=1 WHERE id=?').run(name(input.name), input.id); break
      case 'move': this.group(input.groupId); this.db.prepare('UPDATE chat_threads SET groupId=? WHERE id=?').run(input.groupId, input.id); break
      case 'delete': this.db.prepare('DELETE FROM chat_threads WHERE id=?').run(input.id); break
      case 'group-create': this.db.prepare('INSERT INTO chat_groups VALUES(?,?)').run(randomUUID(), name(input.name)); break
      case 'group-rename': this.db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name(input.name), input.id); break
      case 'group-delete': this.db.prepare('DELETE FROM chat_groups WHERE id=?').run(input.id); break
      default: throw Error('无效的对话操作')
    }
  }
  autoTitle(id: string, title: string): void {
    this.db.prepare('UPDATE chat_threads SET title=? WHERE id=? AND manualTitle=0').run(name(title), id)
  }
  markTemporary(id: string): void { this.db.prepare('UPDATE chat_threads SET memoryTemporary=1 WHERE id=?').run(id) }
  begin(id: string, question: string): { userId: string; answerId: string } {
    this.get(id, 1)
    const userId = randomUUID(), answerId = randomUUID(), now = Date.now()
    this.db.exec('BEGIN')
    try {
      const insert = this.db.prepare('INSERT INTO chat_messages(id,threadId,role,text,state,createdAt) VALUES(?,?,?,?,?,?)')
      insert.run(userId, id, 'user', question, 'done', now)
      insert.run(answerId, id, 'assistant', '', 'working', now)
      this.db.prepare('UPDATE chat_threads SET updatedAt=? WHERE id=?').run(now, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { userId, answerId }
  }
  finish(id: string, text: string, state: ChatMessage['state'], sources: SearchResult[] = []): void {
    this.db.prepare('UPDATE chat_messages SET text=?,state=?,sources=? WHERE id=?').run(text, state, JSON.stringify(sources), id)
  }
  close(): void { this.database?.close(); this.database = null }
}
