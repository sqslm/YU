import { createApp } from './app.mjs'
import { loadConfig } from './config.mjs'
import { createLogger } from './log.mjs'
import { SERVER_VERSION } from './version.mjs'

const config = loadConfig()
const log = createLogger({ level: config.logLevel })

for (const warning of config.warnings) log.warn(warning)

const app = createApp({ config, logger: log })

app.server.listen(config.port, config.host, () => {
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  log.log(`typeless-server ${SERVER_VERSION} listening on http://${config.host}:${port}`)
  log.log(`data directory: ${config.dataDir}`)
  log.log(
    `registration: ${config.registrationEnabled ? 'open' : 'closed'} · email verification: ${
      config.emailVerificationRequired ? 'required' : 'off'
    } · smtp: ${config.smtpConfigured ? 'configured' : 'not configured'}`
  )
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log.log(`${signal} received, shutting down`)
  // Never wait forever for keep-alive connections to notice.
  const force = setTimeout(() => {
    log.warn('forced exit after 10s')
    process.exit(1)
  }, 10_000)
  force.unref()
  app.server.close((error) => {
    if (error) log.error('error while closing server', error)
    try {
      app.close()
    } catch (closeError) {
      log.error('error while closing database', closeError)
    }
    clearTimeout(force)
    process.exit(error ? 1 : 0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (error) => {
  log.error('unhandled rejection', error)
})
