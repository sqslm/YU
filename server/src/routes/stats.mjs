import { HttpError } from '../http.mjs'
import { requireUser } from '../session.mjs'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_FIELDS = ['entries', 'len', 'ms', 'used', 'records', 'usedMs', 'chars', 'units', 'measured', 'measuredUnits', 'measuredMs', 'savedMs']

function count(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new HttpError(400, 'bad_stats', `${field} 不合法`)
  return number
}

function cleanStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) {
    throw new HttpError(400, 'bad_stats', '统计数据格式不支持')
  }
  const days = {}
  if (raw.days !== undefined && (!raw.days || typeof raw.days !== 'object' || Array.isArray(raw.days))) {
    throw new HttpError(400, 'bad_stats', '日期统计格式不合法')
  }
  const dayEntries = Object.entries(raw.days ?? {})
  if (dayEntries.length > 10000) throw new HttpError(400, 'bad_stats', '日期统计条数过多')
  for (const [day, value] of dayEntries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'bad_stats', '日期统计格式不合法')
    }
    const totals = {}
    for (const field of DAY_FIELDS) totals[field] = count(value[field] ?? 0, `days.${day}.${field}`)
    if (totals.entries > 0) days[day] = totals
  }
  if (raw.apps !== undefined && (!raw.apps || typeof raw.apps !== 'object' || Array.isArray(raw.apps))) {
    throw new HttpError(400, 'bad_stats', '应用统计格式不合法')
  }
  const appEntries = Object.entries(raw.apps ?? {})
  if (appEntries.length > 1000) throw new HttpError(400, 'bad_stats', '应用统计条数过多')
  const apps = {}
  for (const [name, value] of appEntries) {
    if (name.trim() && name.length <= 40) apps[name] = count(value, `apps.${name}`)
  }
  return { version: 1, records: count(raw.records ?? 0, 'records'), lastAt: count(raw.lastAt ?? 0, 'lastAt'), days, apps }
}

export function registerStatsRoutes(router) {
  router.put('/api/v1/stats/devices/:deviceId', async ctx => {
    const user = requireUser(ctx)
    const deviceId = String(ctx.params.deviceId ?? '')
    if (!ID.test(deviceId)) throw new HttpError(400, 'bad_device_id', '设备标识不合法')
    const stats = cleanStats(ctx.body?.stats)
    ctx.db.prepare(`INSERT INTO usage_stats (user_id, device_id, payload, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET
      payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(user.id, deviceId, JSON.stringify(stats), ctx.now)
    return { ok: true }
  })

  router.get('/api/v1/stats/devices', async ctx => {
    const user = requireUser(ctx)
    const rows = ctx.db.prepare('SELECT device_id, payload FROM usage_stats WHERE user_id = ? ORDER BY device_id').all(user.id)
    return { devices: rows.map(row => ({ deviceId: row.device_id, stats: JSON.parse(row.payload) })) }
  })
}
