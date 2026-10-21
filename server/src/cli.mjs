#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { loadConfig } from './config.mjs'
import { openDatabase, readMeta, writeMeta } from './db.mjs'
import { hashPassword } from './password.mjs'

const USAGE = `typeless-server 管理命令

  create-admin --email <邮箱> [--password <密码>]
      创建管理员；邮箱已存在时直接提升为管理员。
      省略 --password 时生成一次性随机密码并打印。

  promote   --email <邮箱>        提升为管理员
  demote    --email <邮箱>        取消管理员
  disable   --email <邮箱>        禁用账号（已签发的会话一并失效）
  enable    --email <邮箱>        恢复账号
  list-users                      列出账号、角色、配额与用量
  set-quota --email <邮箱> --mb <MB>
                                  单独设置存储配额，--mb 0 表示恢复默认
  registration on|off             开关公开注册（覆盖环境变量）
  backup   [--out <目录>]         一致性备份数据库与音频（默认 <DATA_DIR>/backups/<时间>）
  help                            显示这段说明

连接参数与服务器一致，全部来自环境变量：DATA_DIR 必填项见 .env.example。
`

const TEN_YEARS = 10 * 365 * 24 * 3600 * 1000

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      flags[key] = value
    } else {
      positional.push(arg)
    }
  }
  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags }
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function requireEmail(flags) {
  const email = String(flags.email ?? '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('需要合法的 --email')
  return email
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function findUser(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email)
}

async function createAdmin(db, flags) {
  const email = requireEmail(flags)
  const existing = findUser(db, email)
  const password = flags.password && flags.password !== 'true' ? String(flags.password) : randomBytes(9).toString('base64url')
  if (password.length < 8) fail('密码至少 8 位')

  if (existing) {
    if (flags.password && flags.password !== 'true') {
      const { salt, hash } = await hashPassword(password)
      db.prepare('UPDATE users SET is_admin = 1, password_salt = ?, password_hash = ?, disabled = 0 WHERE id = ?').run(
        salt,
        hash,
        existing.id
      )
      process.stdout.write(`已提升为管理员并重置密码：${email}\n`)
    } else {
      db.prepare('UPDATE users SET is_admin = 1, disabled = 0 WHERE id = ?').run(existing.id)
      process.stdout.write(`已提升为管理员（密码未改动）：${email}\n`)
    }
    return
  }

  const { salt, hash } = await hashPassword(password)
  const now = Date.now()
  // users.id has no default: every writer mints the id itself.
  db.prepare(
    `INSERT INTO users (id, email, password_salt, password_hash, created_at, plan, trial_ends_at,
                        current_period_end, cancel_at_period_end, is_admin)
     VALUES (?, ?, ?, ?, ?, 'pro', ?, ?, 0, 1)`
  ).run(randomUUID(), email, salt, hash, now, now + TEN_YEARS, now + TEN_YEARS)
  process.stdout.write(`管理员已创建：${email}\n密码：${password}\n请登录后立即在客户端修改密码。\n`)
}

function listUsers(db, config) {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.is_admin, u.disabled, u.storage_quota_bytes,
              (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id AND n.deleted = 0) AS notes,
              (SELECT COALESCE(SUM(a.bytes), 0) FROM note_audio a WHERE a.user_id = u.id) AS used
         FROM users u ORDER BY u.id ASC`
    )
    .all()
  if (rows.length === 0) {
    process.stdout.write('还没有任何账号，用 create-admin 创建第一个管理员。\n')
    return
  }
  for (const row of rows) {
    // Zero means "follow the instance default", same contract as quotaBytesFor.
    const quota = Number(row.storage_quota_bytes) > 0
      ? Number(row.storage_quota_bytes)
      : config.defaultStorageQuotaBytes
    const role = Number(row.is_admin) === 1 ? 'admin' : 'user'
    const state = Number(row.disabled) === 1 ? 'disabled' : 'active'
    process.stdout.write(
      `#${row.id}  ${row.email}  ${role}  ${state}  ${row.notes} 条随记  ` +
        `${humanBytes(Number(row.used))}/${humanBytes(quota)}\n`
    )
  }
}

function backup(db, config, flags) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = flags.out && flags.out !== 'true'
    ? resolve(String(flags.out))
    : join(config.dataDir, 'backups', stamp)
  if (existsSync(out)) fail(`备份目录已存在：${out}`)
  mkdirSync(out, { recursive: true })

  // VACUUM INTO writes a consistent snapshot of a database that is still being
  // written to; copying app.db by hand can capture a torn WAL.
  const target = join(out, 'app.db')
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)

  const audio = join(config.dataDir, 'audio')
  if (existsSync(audio)) {
    cpSync(audio, join(out, 'audio'), { recursive: true })
  }
  const bytes = statSync(target).size
  process.stdout.write(`数据库备份完成：${target}（${humanBytes(bytes)}）\n`)
  if (existsSync(audio)) process.stdout.write(`音频目录已复制：${join(out, 'audio')}\n`)
  process.stdout.write('恢复：停服 → 用备份覆盖 data/app.db 与 data/audio → 启动。\n')
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (command === 'help' || flags.help) {
    process.stdout.write(USAGE)
    return
  }

  const config = loadConfig()
  const db = openDatabase(config.dataDir)
  try {
    switch (command) {
      case 'create-admin':
        await createAdmin(db, flags)
        return
      case 'promote':
      case 'demote': {
        const email = requireEmail(flags)
        const user = findUser(db, email)
        if (!user) fail(`没有这个账号：${email}`)
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(command === 'promote' ? 1 : 0, user.id)
        process.stdout.write(`${email} ${command === 'promote' ? '已成为管理员' : '已取消管理员'}\n`)
        return
      }
      case 'disable':
      case 'enable': {
        const email = requireEmail(flags)
        const user = findUser(db, email)
        if (!user) fail(`没有这个账号：${email}`)
        const disabled = command === 'disable' ? 1 : 0
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled, user.id)
        if (disabled) {
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
            Date.now(),
            user.id
          )
        }
        process.stdout.write(`${email} ${disabled ? '已禁用，会话已撤销' : '已恢复'}\n`)
        return
      }
      case 'list-users':
      case 'users':
        listUsers(db, config)
        return
      case 'set-quota': {
        const email = requireEmail(flags)
        const user = findUser(db, email)
        if (!user) fail(`没有这个账号：${email}`)
        const mb = Number(flags.mb)
        if (!Number.isFinite(mb) || mb < 0) fail('需要 --mb，0 表示恢复默认配额')
        const value = mb === 0 ? 0 : Math.round(mb * 1024 * 1024)
        db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(value, user.id)
        process.stdout.write(
          `${email} 配额：${value === 0 ? `默认（${humanBytes(config.defaultStorageQuotaBytes)}）` : humanBytes(value)}\n`
        )
        return
      }
      case 'registration': {
        const value = positional[0] ?? flags.value
        if (value !== 'on' && value !== 'off') fail('用法：registration on|off')
        writeMeta(db, 'registration_enabled', value === 'on' ? '1' : '0')
        process.stdout.write(`公开注册：${value === 'on' ? '开放' : '关闭'}\n`)
        return
      }
      case 'backup':
        backup(db, config, flags)
        return
      case 'status': {
        const users = Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n)
        const notes = Number(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted = 0').get().n)
        const audio = Number(db.prepare('SELECT COUNT(*) AS n FROM note_audio').get().n)
        const registration = readMeta(db, 'registration_enabled')
        process.stdout.write(
          `数据目录：${config.dataDir}\n账号：${users}  随记：${notes}  音频：${audio}\n` +
            `公开注册：${registration === null ? (config.registrationEnabled ? '开放（默认）' : '关闭（默认）') : registration === '1' ? '开放' : '关闭'}\n`
        )
        return
      }
      default:
        fail(`未知命令：${command}\n\n${USAGE}`)
    }
  } finally {
    db.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exit(1)
})
