import { registrationOpen } from './auth.mjs'
import { PROTOCOL_VERSION, SERVER_VERSION } from '../version.mjs'

/**
 * Unauthenticated capability probe.
 *
 * The client calls this before showing a login form: it needs to know whether
 * sign-up is open and whether a code will be mailed, and it must not learn any
 * account detail to do so.
 */
export function registerMetaRoutes(router) {
  router.get('/api/v1/meta', async (ctx) => ({
    name: 'typeless-server',
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    registrationEnabled: registrationOpen(ctx),
    emailVerificationRequired: ctx.config.emailVerificationRequired,
    smtpConfigured: ctx.config.smtpConfigured,
    publicUrl: ctx.config.publicUrl,
    limits: {
      maxAudioUploadBytes: ctx.config.maxAudioUploadBytes,
      defaultStorageQuotaBytes: ctx.config.defaultStorageQuotaBytes,
      maxJsonBytes: ctx.config.maxJsonBytes,
      notesPerPush: 200,
      notesPerPull: 500
    },
    features: {
      notes: true,
      notesAudio: true,
      history: true,
      statistics: true,
      passwordReset: ctx.config.smtpConfigured
    }
  }))
}
