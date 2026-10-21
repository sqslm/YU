/**
 * Audio on the local filesystem.
 *
 * The layout is fixed by the deployment contract:
 *
 *   <DATA_DIR>/app.db
 *   <DATA_DIR>/audio/<user-id>/<note-id>.opus
 *   <DATA_DIR>/backups/
 *
 * Three properties matter more than cleverness here:
 *  - a request can only ever touch its own user's directory, and the note id is
 *    validated before it becomes part of a path;
 *  - a failed upload never damages the file it was replacing (write to a temp
 *    name in the same directory, fsync-free rename);
 *  - the bytes are hashed while they stream, so a download can be verified and
 *    the quota record is written from the same numbers that landed on disk.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { HttpError } from './http.mjs'

const EXTENSIONS = { ogg: 'opus', opus: 'opus', wav: 'wav' }

export function normalizeAudioFormat(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'audio/ogg' || raw === 'audio/opus' || raw === 'application/ogg') return 'ogg'
  if (raw === 'audio/wav' || raw === 'audio/wave' || raw === 'audio/x-wav') return 'wav'
  return EXTENSIONS[raw] ? raw : null
}

export function audioRoot(config) {
  return join(config.dataDir, 'audio')
}

export function userAudioDir(config, userId) {
  return join(audioRoot(config), userId)
}

/**
 * Absolute path of one note's recording.
 *
 * `userId` and `noteId` come from the database and a validated route parameter;
 * the containment check is the second lock on the same door, because a future
 * caller could pass something unvalidated and a path traversal here would read
 * another account's audio.
 */
export function noteAudioPath(config, userId, noteId, format) {
  const extension = EXTENSIONS[format] ?? 'opus'
  const dir = resolve(userAudioDir(config, userId))
  const file = resolve(dir, `${noteId}.${extension}`)
  if (file !== join(dir, `${noteId}.${extension}`) || !file.startsWith(dir + sep)) {
    throw new HttpError(400, 'bad_note_id', '随记 id 不合法')
  }
  return file
}

export function contentTypeFor(format) {
  return format === 'wav' ? 'audio/wav' : 'audio/ogg'
}

/** Bytes of audio a user currently stores, per the database. */
export function usageBytes(db, userId) {
  const row = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM note_audio WHERE user_id = ?').get(userId)
  return Number(row?.n ?? 0)
}

/**
 * Streams the request body into a temp file next to its destination.
 *
 * Returning the temp path instead of renaming here lets the caller finish its
 * database bookkeeping first: if the quota check or the upsert fails, only the
 * temp file is removed and the previous recording is untouched.
 */
export async function receiveToTemp(req, targetPath, limitBytes) {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.upload-${randomUUID()}.tmp`)
  const hash = createHash('sha256')
  let bytes = 0
  const out = createWriteStream(temp, { mode: 0o600 })
  try {
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > limitBytes) {
        throw new HttpError(
          413,
          'audio_too_large',
          `单个音频不能超过 ${Math.round(limitBytes / (1024 * 1024))} MB`
        )
      }
      hash.update(chunk)
      if (!out.write(chunk)) await once(out, 'drain')
    }
    await new Promise((resolvePromise, rejectPromise) => {
      out.end((error) => (error ? rejectPromise(error) : resolvePromise()))
    })
  } catch (error) {
    out.destroy()
    removeFile(temp)
    throw error
  }
  return { temp, bytes, sha256: hash.digest('hex') }
}

/** Replaces `targetPath` with the temp file. Atomic on one filesystem. */
export function commitUpload(temp, targetPath) {
  try {
    renameSync(temp, targetPath)
  } catch (error) {
    removeFile(temp)
    throw error
  }
}

export function removeFile(path) {
  try {
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** Drops everything a deleted account owned; the CLI calls this. */
export function removeUserAudio(config, userId) {
  rmSync(userAudioDir(config, userId), { recursive: true, force: true })
}

/**
 * Writes an audio response with a strong ETag.
 *
 * `HEAD` is answered from the same numbers so a client can check whether its copy
 * is current without downloading the file again. Range requests are deliberately
 * unsupported: the clients stream the whole note, and a half-implemented `Range`
 * is a correctness hazard, not a feature.
 */
export function sendAudio(res, filePath, { format, sha256, bytes }, method = 'GET') {
  let stats
  try {
    stats = statSync(filePath)
  } catch {
    throw new HttpError(404, 'audio_not_found', '这条随记没有音频文件')
  }
  res.writeHead(200, {
    'content-type': contentTypeFor(format),
    'content-length': stats.size,
    etag: `"${sha256}"`,
    'cache-control': 'private, max-age=0, must-revalidate',
    'accept-ranges': 'none',
    'x-content-type-options': 'nosniff'
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    // The size was read a moment ago; a failure here means the file vanished.
    res.destroy()
  })
  stream.pipe(res)
  void bytes
}
