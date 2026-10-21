import { publicUser, quotaBytesFor, requireUser } from '../session.mjs'
import { usageBytes } from '../storage.mjs'

/** The signed-in account plus the storage numbers a client shows in settings. */
export function registerUserRoutes(router) {
  router.get('/api/v1/user/info', async (ctx) => {
    const user = requireUser(ctx)
    return { user: publicUser(user, ctx.now) }
  })

  router.get('/api/v1/user/storage', async (ctx) => {
    const user = requireUser(ctx)
    const noteRow = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND deleted = 0')
      .get(user.id)
    const audioRow = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM note_audio WHERE user_id = ?')
      .get(user.id)
    const used = usageBytes(ctx.db, user.id)
    return {
      usedBytes: used,
      quotaBytes: quotaBytesFor(user, ctx.config),
      noteCount: Number(noteRow?.n ?? 0),
      audioCount: Number(audioRow?.n ?? 0),
      maxAudioUploadBytes: ctx.config.maxAudioUploadBytes
    }
  })
}
