/**
 * Short stamp for a search hit: time of day for today, date for anything older.
 *
 * Search results mix chats, notes, events and history, so a row needs enough of
 * a timestamp to be recognizable without turning into a date column: today's hits
 * are told apart by the minute, older ones by the day, and only a different year
 * gets the year spelled out.
 */
export function hitClock(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const date = new Date(at)
  const today = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() === today.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
