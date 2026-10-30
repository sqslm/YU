/**
 * Network egress: what the main process says about how it reaches the internet.
 *
 * The types live in `shared` (not in `main/net/egress`) because the settings page
 * has to render the diagnosis and the renderer may not import main-process code.
 * `src/main/net/egress.ts` imports these; nothing here imports back.
 */

/** What the user picked. Mirrors `NetworkSettings.mode` in `types.ts`. */
export type NetworkMode = 'system' | 'direct' | 'custom'

/**
 * What Chromium was actually told to do.
 *
 * `fixed_servers` is the `custom` case after normalization; `custom` with an
 * address that does not parse falls back to `system`, which is what this field
 * reports — the honest answer, not the requested one.
 */
export type EffectiveProxyMode = 'system' | 'direct' | 'fixed_servers'

/** One reachability check. `ok` means a response arrived, whatever its status. */
export interface NetworkProbe {
  label: string
  url: string
  ok: boolean
  status?: number
  /** Wall time until the response headers arrived. */
  ms: number
  error?: string
}

/** Terminal-only proxy variables; the GUI process usually has none of these. */
export interface NetworkEnvProxy {
  http?: string
  https?: string
  noProxy?: string
}

export interface EgressDiagnosis {
  /** The configured mode, as saved. */
  mode: NetworkMode
  /** The raw configured address (empty unless `mode === 'custom'`). */
  proxyUrl: string
  /** The mode Chromium is really running with. */
  effective: EffectiveProxyMode
  /** `resolveProxy()` for https://www.bing.com: `DIRECT`, `PROXY host:port`, `PAC …`. */
  resolved: string
  envProxy: NetworkEnvProxy
  probes: NetworkProbe[]
  /** Executable next steps, already localized by the main process. */
  advice: string[]
}
