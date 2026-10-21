import type { ModelInfo } from './types'

/**
 * UI-facing reasoning-effort helpers.
 *
 * `off` is a purely local value: it never reaches the wire as
 * `reasoning_effort`, it becomes `thinking: { type: 'disabled' }` in
 * `src/main/providers/llm.ts`. Everything here is pure so both the renderer and
 * the main process can share it (and vitest can test it without Electron).
 */
import { mt } from './mainI18n'


/** The one value the UI invents; every other value comes from the gateway. */
export const EFFORT_OFF = 'off'

/** Shown under the select when the gateway cannot switch thinking off. */
export const EFFORT_UNAVAILABLE_HINT = mt('该模型不支持关闭思考')

/** Trims, drops blanks and de-duplicates while keeping the gateway's order. */
function cleanEfforts(values: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const effort = value.trim()
    if (!effort || out.includes(effort)) continue
    out.push(effort)
  }
  return out
}

/**
 * Values the effort dropdown may offer for `model`, in display order.
 *
 * `off` comes first and is only present when the gateway actually honours
 * `thinking: { type: 'disabled' }`. A model without reasoning support yields an
 * empty list, which is the UI's signal to hide the dropdown entirely.
 */
export function effortOptions(model?: ModelInfo | null): string[] {
  const efforts = cleanEfforts(model?.reasoningSupportedEfforts)
  const values = model?.canDisableThinking === true ? [EFFORT_OFF, ...efforts] : efforts
  const out: string[] = []
  for (const value of values) {
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * What the app should send when the user has not picked a value (or the picked
 * value stops existing): the gateway's declared default, else its first
 * supported effort, else `''` = "let the model decide".
 */
export function defaultEffort(model?: ModelInfo | null): string {
  const declared = model?.reasoningDefaultEffort
  if (typeof declared === 'string' && declared.trim()) return declared.trim()
  return cleanEfforts(model?.reasoningSupportedEfforts)[0] ?? ''
}

/**
 * Why `off` cannot be offered for this model, or `null` when it can.
 * The UI renders this as helper text next to the disabled `off` menu item.
 */
export function effortUnavailable(model?: ModelInfo | null): string | null {
  return model?.canDisableThinking === true ? null : EFFORT_UNAVAILABLE_HINT
}
