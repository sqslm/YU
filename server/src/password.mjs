import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)

/**
 * scrypt from the standard library: memory-hard, no native module to compile in
 * the image, and these are the parameters Node's own docs suggest for
 * interactive logins (64-byte key, N=16384, r=8, p=1 by default).
 */
const KEY_LENGTH = 64

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, KEY_LENGTH)
  return { salt: salt.toString('base64'), hash: key.toString('base64') }
}

export async function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false
  const salt = Buffer.from(stored.salt, 'base64')
  const expected = Buffer.from(stored.hash, 'base64')
  if (expected.length !== KEY_LENGTH) return false
  const key = await derive(password, salt, KEY_LENGTH)
  return timingSafeEqual(key, expected)
}

/**
 * Tokens are stored hashed, so a database dump is not a pile of usable logins.
 * SHA-256 is enough here because the token itself is 32 random bytes — there is
 * no low-entropy guess space to defend against, unlike a password. The same
 * applies to the six-digit mail code: hashing removes it from a dump, and the
 * attempt counter is what limits guessing.
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('base64url')
}

/** 32 random bytes, URL-safe: the only secret a session ever carries. */
export function newToken() {
  return randomBytes(32).toString('base64url')
}

/** Kept for the refresh-token table that 1.0.x created; same value space. */
export const newRefreshToken = newToken
