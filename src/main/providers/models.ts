import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ModelInfo, ModelListResult } from '@shared/types'
import { joinUrl, parseHeaderLines } from './asr'
import { REALTIME_SPECS } from './asr/realtime'
import { mt } from '@shared/mainI18n'

/**
 * One-click `GET {baseUrl}/models` for the settings dialog, plus the on-disk
 * cache that keeps the dropdown usable when the gateway is offline.
 *
 * The module is deliberately free of a static `electron` import: the only
 * Electron facts it needs (`userData` path, app version) are looked up through
 * a guarded `require`, so the pure helpers below stay importable from plain
 * Node (vitest) and the cache directory can be redirected in tests.
 */

/** Cached lists older than this are refreshed even when `refresh` is not set. */
export const MODELS_CACHE_TTL_MS = 10 * 60 * 1000

const CACHE_FILE = 'models-cache.json'
const REQUEST_TIMEOUT_MS = 15_000
const UA_PREFIX = 'typeless-rebuild'
const UA_FALLBACK_VERSION = '0.3.0'

export interface ListModelsInput {
  baseUrl: string
  apiKey: string
  extraHeaders?: string
  /** Adapter id, when the profile already knows which one it uses. */
  asrAdapter?: string
  /** Bypass the cache and hit the network. */
  refresh?: boolean
}

/** The account and organization scope is hashed; credentials are never cached. */
export interface ModelsCache {
  baseUrl: string
  authScope: string
  fetchedAt: number
  models: ModelInfo[]
}

interface ElectronAppLike {
  getPath?: (name: string) => string
  getVersion?: () => string
}

/** Test seam: point the cache at a temp directory instead of `userData`. */
let cacheDirectoryOverride: string | null = null

export function setModelsCacheDirectory(dir: string | null): void {
  cacheDirectoryOverride = dir
}

/**
 * The Electron `app` object, or `null` outside Electron. `require` only exists
 * in the bundled CJS main process; the `typeof` guard keeps this safe in ESM
 * test runners, and a plain-Node `require('electron')` returns a path string
 * which the object check rejects.
 */
function electronApp(): ElectronAppLike | null {
  try {
    if (typeof require !== 'function') return null
    const loaded: unknown = require('electron')
    if (!loaded || typeof loaded !== 'object') return null
    const candidate = (loaded as { app?: unknown }).app
    if (!candidate || typeof candidate !== 'object') return null
    return candidate as ElectronAppLike
  } catch {
    return null
  }
}

/** `typeless-rebuild/<version>`; falls back to the package version when unknown. */
export function requestUserAgent(): string {
  const version = electronApp()?.getVersion?.()
  const trimmed = typeof version === 'string' ? version.trim() : ''
  return `${UA_PREFIX}/${trimmed || UA_FALLBACK_VERSION}`
}

/** Absolute path of the cache file, or `null` when there is nowhere to write. */
export function modelsCachePath(): string | null {
  const dir = cacheDirectoryOverride ?? electronApp()?.getPath?.('userData') ?? null
  if (!dir) return null
  return join(dir, CACHE_FILE)
}

/* -------------------------------- pure logic ------------------------------- */

/** `https://host/v1` -> `https://host/v1/models` (no doubled slashes). */
export function modelsUrl(baseUrl: string): string {
  return joinUrl(baseUrl, 'models')
}

/** The `Name: value` lines the user typed, as a header record. */
export function flattenExtraHeaders(extraHeaders?: string): Record<string, string> {
  return { ...parseHeaderLines(extraHeaders) }
}

/** True while a cache timestamp is still worth showing without a request. */
export function isFresh(fetchedAt: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false
  const age = now - fetchedAt
  return age >= 0 && age < MODELS_CACHE_TTL_MS
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.round(parsed)
}

function readEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    const effort = readString(item)
    if (effort && !out.includes(effort)) out.push(effort)
  }
  return out.length > 0 ? out : undefined
}

/** snake_case or camelCase, whichever the gateway happens to send. */
function readField(record: Record<string, unknown>, snake: string, camel: string): unknown {
  return record[snake] !== undefined ? record[snake] : record[camel]
}

/**
 * One gateway entry -> `ModelInfo`. Returns `null` when `id` is missing, which
 * is the only field this app cannot invent. Unknown fields are intentionally
 * dropped (`credits`, `vendor`, `supports_images` …).
 */
export function normalizeModel(raw: unknown): ModelInfo | null {
  const record = asRecord(raw)
  if (!record) return null
  const id = readString(record.id)
  if (!id) return null

  const model: ModelInfo = { id, name: readString(record.name) ?? id }
  if (typeof record.description === 'string') model.description = record.description

  const contextLength = readPositiveInt(readField(record, 'context_length', 'contextLength'))
  if (contextLength !== undefined) model.contextLength = contextLength
  const maxOutputTokens = readPositiveInt(readField(record, 'max_output_tokens', 'maxOutputTokens'))
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens

  const supportsReasoning = readField(record, 'supports_reasoning', 'supportsReasoning')
  if (typeof supportsReasoning === 'boolean') model.supportsReasoning = supportsReasoning
  const onlyReasoning = readField(record, 'only_reasoning', 'onlyReasoning')
  if (typeof onlyReasoning === 'boolean') model.onlyReasoning = onlyReasoning
  const canDisableThinking = readField(record, 'can_disable_thinking', 'canDisableThinking')
  if (typeof canDisableThinking === 'boolean') model.canDisableThinking = canDisableThinking

  const efforts = readEfforts(
    readField(record, 'reasoning_supported_efforts', 'reasoningSupportedEfforts')
  )
  if (efforts) model.reasoningSupportedEfforts = efforts
  const defaultEffort = readString(
    readField(record, 'reasoning_default_effort', 'reasoningDefaultEffort')
  )
  if (defaultEffort) model.reasoningDefaultEffort = defaultEffort

  return model
}

/**
 * `{ data: [...] }` (OpenAI), `{ models: [...] }` or a bare array -> unique,
 * valid `ModelInfo`s in gateway order.
 */
export function normalizeModels(payload: unknown): ModelInfo[] {
  const record = asRecord(payload)
  const list = Array.isArray(payload)
    ? payload
    : record && Array.isArray(record.data)
      ? record.data
      : record && Array.isArray(record.models)
        ? record.models
        : []

  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const model = normalizeModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/* --------------------------------- caching -------------------------------- */

/** Cached list, or `null` when the file is missing/unreadable/empty. */
export async function readModelsCache(): Promise<ModelsCache | null> {
  const file = modelsCachePath()
  if (!file) return null
  try {
    const parsed = asRecord(JSON.parse(await fs.readFile(file, 'utf8')))
    if (!parsed) return null
    const baseUrl = readString(parsed.baseUrl)
    const authScope = readString(parsed.authScope)
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : Number.NaN
    if (!baseUrl || !authScope || !Number.isFinite(fetchedAt)) return null
    const models = normalizeModels(parsed.models)
    if (models.length === 0) return null
    return { baseUrl, authScope, fetchedAt, models }
  } catch {
    return null
  }
}

/** Best-effort cache write; a failure here must never break the UI. */
export async function writeModelsCache(cache: ModelsCache): Promise<void> {
  const file = modelsCachePath()
  if (!file) return
  try {
    await fs.writeFile(
      file,
      JSON.stringify(cache),
      'utf8'
    )
  } catch {
    // Cache is a convenience only.
  }
}

/* --------------------------------- fetching -------------------------------- */

async function fetchModels(input: ListModelsInput, baseUrl: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { 'user-agent': requestUserAgent() }
  Object.assign(headers, flattenExtraHeaders(input.extraHeaders))
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`

  const res = await fetch(modelsUrl(baseUrl), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const body = await res.text()
  if (!res.ok) {
    const detail = body.trim().slice(0, 200)
    throw new Error(
      mt('模型列表 HTTP {{status}}{{detail}}', {
        status: res.status,
        detail: detail ? `：${detail}` : ''
      })
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(mt('模型列表返回的不是 JSON'))
  }
  return normalizeModels(parsed)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return mt('获取模型列表超时（15 秒）')
    if (error.name === 'AbortError') return mt('获取模型列表被中断')
    return error.message || error.name
  }
  return String(error)
}

/** A failed live request degrades to the last good list, never to an exception. */
function failed(message: string, cache: ModelsCache | null): ModelListResult {
  return cache
    ? { models: cache.models, fetchedAt: cache.fetchedAt, cached: true, error: message }
    : { models: [], fetchedAt: 0, cached: false, error: message }
}

/**
 * The IPC-facing entry point.
 *
 * - A fresh cache for the same URL, key and headers -> no network unless refreshed.
 * - Success -> cache is rewritten and `cached: false`.
 * - Failure -> last good list + `error` (or an empty result), never a throw.
 */
export async function listModels(input: ListModelsInput): Promise<ModelListResult> {
  // A socket session has no `/models` route, so asking one answers 404 and looks
  // like a broken connection. Answer from the adapter's own table instead.
  const streaming = REALTIME_SPECS.find((spec) => spec.id === input.asrAdapter)
  if (streaming) {
    const models = (streaming.models ?? []).map((id) => ({ id }))
    return {
      models,
      fetchedAt: Date.now(),
      cached: false,
      error: models.length === 0 ? mt('这条连接用「引擎」参数而不是模型 ID，模型可以留空') : undefined
    }
  }
  const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
  const authScope = createHash('sha256').update(JSON.stringify([input.apiKey, flattenExtraHeaders(input.extraHeaders)])).digest('hex')
  const cached = await readModelsCache()
  const cacheHit = cached && cached.baseUrl === baseUrl && cached.authScope === authScope ? cached : null

  if (input.refresh !== true && cacheHit && isFresh(cacheHit.fetchedAt)) {
    return { models: cacheHit.models, fetchedAt: cacheHit.fetchedAt, cached: true }
  }
  if (!baseUrl) return failed('LLM base URL is empty', cacheHit)

  try {
    const models = await fetchModels(input, baseUrl)
    const fetchedAt = Date.now()
    await writeModelsCache({ baseUrl, authScope, fetchedAt, models })
    return { models, fetchedAt, cached: false }
  } catch (error) {
    return failed(describeError(error), cacheHit)
  }
}
