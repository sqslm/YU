import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Schema and migrations.
 *
 * Three shapes are deliberate and worth stating once:
 *
 *  - `history` stores the client's dictation entry as an opaque JSON payload. The
 *    client owns that shape; the server only needs identity, ordering and a
 *    tombstone. `notes` is the opposite: the spec asks the server to understand
 *    the note (raw ASR, polished text, tags, audio metadata), so it gets real
 *    columns and a version number for conflict detection.
 *  - Deletions are tombstones, never `DELETE`. A push/pull client cannot tell a
 *    missing row from "not pushed yet", so a real delete would resurrect.
 *  - `seq` is the pull cursor. Client clocks disagree with the server's, and two
 *    events inside one millisecond would make a timestamp cursor skip a row
 *    forever. One server-side counter has neither problem.
 */

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens (user_id);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS history_user_updated ON history (user_id, updated_at);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_user ON orders (user_id);
CREATE TABLE IF NOT EXISTS email_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  user_agent TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_access ON sessions (access_hash);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '',
  polished TEXT NOT NULL DEFAULT '',
  polish_status TEXT NOT NULL DEFAULT 'pending',
  polish_error TEXT,
  category_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  edited_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  server_updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_user_seq ON notes (user_id, seq);
CREATE INDEX IF NOT EXISTS notes_user_updated ON notes (user_id, updated_at);

CREATE TABLE IF NOT EXISTS note_audio (
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL,
  format TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_audio_user ON note_audio (user_id);
`

function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name))
}

function addColumn(db, table, column, definition) {
  if (tableColumns(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/** Version 1: the 1.0.x schema, made idempotent so a legacy file passes through. */
function migration1(db) {
  db.exec(BASE_SCHEMA)
  if (!tableColumns(db, 'history').includes('seq')) {
    db.exec('ALTER TABLE history ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    db.exec('UPDATE history SET seq = rowid')
  }
  db.exec('CREATE INDEX IF NOT EXISTS history_user_seq ON history (user_id, seq)')
}

/**
 * Version 2: revocable sessions, the note store, and per-purpose e-mail codes.
 *
 * `email_codes` used one row per address, so a password-reset code would have
 * overwritten a pending sign-up code and the two flows could never be rate
 * limited apart. SQLite cannot change a primary key in place, so the table is
 * rebuilt and the old rows are carried over as purpose `register`.
 */
function migration2(db) {
  addColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'users', 'storage_quota_bytes', 'INTEGER NOT NULL DEFAULT 0')

  if (!tableColumns(db, 'email_codes').includes('purpose')) {
    db.exec('ALTER TABLE email_codes RENAME TO email_codes_v1')
    db.exec(`CREATE TABLE email_codes (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (email, purpose)
    )`)
    db.exec(`INSERT INTO email_codes (email, purpose, code_hash, created_at, expires_at, attempts)
             SELECT email, 'register', code_hash, created_at, expires_at, attempts FROM email_codes_v1`)
    db.exec('DROP TABLE email_codes_v1')
  }
  db.exec(V2_SCHEMA)
}

const MIGRATIONS = [
  { version: 1, name: 'baseline', up: migration1 },
  { version: 2, name: 'sessions-notes-audio', up: migration2 },
  { version: 3, name: 'note-titles', up: db => addColumn(db, 'notes', 'title', "TEXT NOT NULL DEFAULT ''") }
]

/**
 * Applies every migration the file has not seen yet.
 *
 * `user_version` is SQLite's own integer slot, so the version travels inside the
 * database file and a container rebuild cannot lose it. Each step runs in its own
 * transaction: a failure leaves the previous version intact instead of a
 * half-migrated schema.
 */
export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${err.message}`)
    }
  }
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'app.db'))
  // WAL keeps a reader (a listing request) from blocking the writer (an upload
  // landing at the same moment); NORMAL is the durability level SQLite recommends
  // for WAL.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

/** Reads one meta counter, treating an absent key as zero. */
export function readCounter(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row ? Number(row.value) : 0
}

export function writeMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function readMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
}

export function bumpCounter(db, key) {
  const next = readCounter(db, key) + 1
  writeMeta(db, key, next)
  return next
}

/** Highest `seq` handed out in `table`, so a fresh push cannot reuse a cursor. */
export function lastSeq(db, table = 'notes') {
  return Number(db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM ${table}`).get()?.n ?? 0)
}
