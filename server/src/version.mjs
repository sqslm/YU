/**
 * The protocol/version pair the client can check.
 *
 * `SERVER_VERSION` follows package.json by hand on purpose: reading the file at
 * runtime breaks as soon as the server is packaged or run from another directory,
 * and one string is cheaper than that failure mode.
 */
export const SERVER_VERSION = '2.1.0'

/** Bumped only when the REST contract changes incompatibly. */
export const PROTOCOL_VERSION = 1
