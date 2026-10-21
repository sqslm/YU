/**
 * The one error type every provider path throws.
 *
 * It lives in its own module because both the OpenAI-shaped client (`asr.ts`) and
 * the per-vendor adapters need it, and the adapters are imported *by* `asr.ts`.
 * Keeping the class here breaks that cycle: importing `ProviderError` from `../asr`
 * inside an adapter made `WEST_SPECS` undefined at module-init time, which showed
 * up as `WEST_SPECS is not iterable`.
 */
export class ProviderError extends Error {
  readonly status?: number
  readonly body?: string

  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.body = body
  }
}
