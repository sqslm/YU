/**
 * A tiny logger with the one property this server needs: call sites decide what
 * is safe to print. Verification codes, passwords, tokens and SMTP credentials
 * never reach a log line — the helpers here cannot redact what they are not told
 * about, so the rule is "do not pass it".
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function describe(error) {
  if (!error) return ''
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

export function createLogger({ level = 'info', out = process.stdout, err = process.stderr, silent = false } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info
  const write = (stream, text) => {
    if (silent) return
    try {
      stream.write(text)
    } catch {
      // A closed stdout must never take the request path down.
    }
  }
  const stamp = () => new Date().toISOString()

  return {
    setLevel(value) { threshold = LEVELS[value] ?? LEVELS.info },
    log(message) {
      if (threshold >= LEVELS.info) write(out, `${stamp()} INFO  ${message}\n`)
    },
    warn(message) {
      if (threshold >= LEVELS.warn) write(err, `${stamp()} WARN  ${message}\n`)
    },
    error(message, error) {
      if (threshold < LEVELS.error) return
      const detail = describe(error)
      write(err, `${stamp()} ERROR ${message}${detail ? ` — ${detail}` : ''}\n`)
    }
  }
}

/** The shape `createApp` expects; a bare console satisfies it too. */
export const silentLogger = {
  log() {},
  warn() {},
  error() {}
}
