import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatDetail, ChatEdit, ChatGroup, ChatMessage, ChatThread } from '@shared/chat'
import type { SearchResult } from '@shared/types'
import type { StoredChatAttachment } from './chat-attachments'

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
      let db: DatabaseSync
      try { mkdirSync(dirname(this.path), { recursive: true }); db = new DatabaseSync(this.path) }
      catch (error) { throw new Error('无法打开安装目录中的对话数据，请确认安装目录可写；可将软件安装到有写入权限的目录。', { cause: error }) }
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS chat_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, groupId TEXT REFERENCES chat_groups(id) ON DELETE SET NULL, updatedAt INTEGER NOT NULL, manualTitle INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS chat_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, threadId TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(threadId,seq);
        CREATE TABLE IF NOT EXISTS chat_attachments (id TEXT PRIMARY KEY, messageId TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, name TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, thumbnail TEXT, truncated INTEGER NOT NULL, text TEXT, image TEXT, original BLOB);
        CREATE INDEX IF NOT EXISTS chat_attachments_message ON chat_attachments(messageId);
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
    return { ...row, manualTitle: Boolean(row.manualTitle), memoryTemporary: Boolean(row.memoryTemporary), messages: messages.map(message => ({ id: message.id, role: message.role, text: message.text, state: message.state, createdAt: message.createdAt, sources: JSON.parse(String(message.sources)), attachments: this.db.prepare('SELECT id,name,size,kind,thumbnail,truncated FROM chat_attachments WHERE messageId=? ORDER BY rowid').all(String(message.id)).map(file => ({ ...file, truncated: Boolean(file.truncated) })) })) as ChatMessage[], total: Number(this.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE threadId=?').get(id)!.n) } as ChatDetail
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
  attach(messageId: string, files: StoredChatAttachment[]): void {
    this.db.exec('BEGIN')
    try {
      const insert = this.db.prepare('INSERT INTO chat_attachments(id,messageId,name,size,kind,thumbnail,truncated,text,image,original) VALUES(?,?,?,?,?,?,?,?,?,?)')
      for (const file of files) insert.run(file.id, messageId, file.name, file.size, file.kind, file.thumbnail ?? null, Number(file.truncated), file.text ?? null, file.image ?? null, file.original ?? null)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  references(threadId: string): StoredChatAttachment[] {
    return this.db.prepare('SELECT a.id,a.name,a.size,a.kind,a.truncated,a.text,a.image FROM chat_attachments a JOIN chat_messages m ON m.id=a.messageId WHERE m.threadId=? ORDER BY m.seq DESC,a.rowid DESC LIMIT 5').all(threadId).reverse().map(file => ({ ...file, truncated: Boolean(file.truncated) })) as unknown as StoredChatAttachment[]
  }
  attachment(threadId: string, attachmentId: string): { name: string; url?: string; text?: string } {
    const file = this.db.prepare('SELECT a.name,a.image,a.text FROM chat_attachments a JOIN chat_messages m ON m.id=a.messageId WHERE m.threadId=? AND a.id=?').get(threadId, attachmentId)
    if (!file) throw Error('附件不存在，请刷新对话')
    return { name: String(file.name), url: file.image ? String(file.image) : undefined, text: file.text ? String(file.text) : undefined }
  }
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
