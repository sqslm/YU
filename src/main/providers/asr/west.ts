/**
 * Adapters for the western vendors that look OpenAI-shaped from a distance and
 * stop looking that way the moment a request is actually sent.
 *
 * The shared path in `../asr.ts` is: one POST of multipart to
 * `<base>/audio/transcriptions`, `Authorization: Bearer <key>`, and a `text`
 * field back. Every spec below breaks at least one of those three assumptions —
 * a body that is raw bytes, a header that is `Token`/`api-key`/`Key`, a job id
 * that has to be polled, a file that has to be uploaded somewhere first. None of
 * that is reachable by editing a base URL, so each vendor owns its own request
 * shape here and the caller only has to pick a spec.
 */
import { ProviderError } from '../providerError'
import {
  type AsrAdapterContext,
  type AsrAdapterInput,
  type AsrAdapterSpec,
  extraHeaders,
  failUnless,
  field,
  need,
  pickString,
  request
} from './types'
import { mt } from '@shared/mainI18n'

/**
 * AssemblyAI, Gladia and Rev.ai use the same ballpark for a job that runs while
 * the user watches: poll often enough to feel responsive, but give up before the
 * take looks hung. Their documented worst case for a short clip is well under
 * two minutes.
 */
const POLL_INTERVAL_MS = 1_500
const POLL_BUDGET_MS = 120_000

/** A poll is a tiny GET; taking longer than this means the socket, not the vendor. */
const POLL_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Shared plumbing
//
// None of it is vendor specific: the specs below only exist to describe how one
// JSON body or one multipart form differs from the next.
// ---------------------------------------------------------------------------

/** The profile's base URL, or the vendor's own root when the profile left it blank. */
function apiBase(ctx: AsrAdapterContext, fallback: string): string {
  const base = ctx.baseUrl.trim().replace(/\/+$/, '')
  return base || fallback
}

/**
 * Appends `path` under `<base>/<version>`.
 *
 * The profile's base URL is whatever the preset wrote (`…/v2`, `…/speechtotext/v1`)
 * or whatever a user typed, and both spellings are common, so the version segment
 * is added only when the base does not already end with it.
 */
function versioned(base: string, version: string, path: string): string {
  const root = base.replace(/\/+$/, '').endsWith(`/${version}`)
    ? base.replace(/\/+$/, '')
    : `${base.replace(/\/+$/, '')}/${version}`
  return `${root}/${path.replace(/^\/+/, '')}`
}

/**
 * Required headers win over the profile's extra lines.
 *
 * Every vendor here rejects the wrong auth header with a 401, so a leftover
 * `Authorization: Bearer …` from an older profile must not be allowed to ride
 * along next to `Token …` / `api-key` / `xi-api-key`.
 */
function headersWith(
  ctx: AsrAdapterContext,
  // `undefined` is how a caller says "no key configured": the header is simply
  // absent, and it claims nothing, so an explicitly typed extra line still wins.
  required: Record<string, string | undefined>
): Record<string, string> {
  const claimed = new Set<string>()
  for (const [name, value] of Object.entries(required)) {
    if (value !== undefined) claimed.add(name.toLowerCase())
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(extraHeaders(ctx))) {
    if (!claimed.has(name.toLowerCase())) headers[name] = value
  }
  for (const [name, value] of Object.entries(required)) {
    if (value !== undefined) headers[name] = value
  }
  return headers
}

/** `auto` and an empty value both mean "let the vendor detect it". */
function languageOf(input: AsrAdapterInput): string {
  const language = input.language.trim()
  return language && language !== 'auto' ? language : ''
}

function mimeOf(input: AsrAdapterInput): string {
  return input.mime || 'audio/wav'
}

/** `fetch` wants `ArrayBuffer`-backed bytes; re-wrapping also detaches a subarray view. */
function sendBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data)
}

function ok(status: number): boolean {
  return status >= 200 && status < 300
}

/** A short single-line excerpt, so a proxy's HTML error page is not pasted whole. */
function snippet(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim()
  return text.slice(0, 200) || mt('（空响应）')
}

interface FormPart {
  name: string
  /** Present on file parts; the value becomes `filename=`. */
  filename?: string
  contentType?: string
  /** Present on text parts (`config`, `model`, …). */
  value?: string
  /** Present on file parts. */
  data?: Uint8Array
}

function multipart(parts: FormPart[]): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----typeless${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n`, 'utf8'))
    if (part.filename) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n`, 'utf8'))
    }
    chunks.push(Buffer.from('\r\n', 'utf8'))
    chunks.push(Buffer.from(part.data ?? Buffer.from(part.value ?? '', 'utf8')))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: sendBytes(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** Vendors that accept an inline payload want it as a data URI, exactly like a browser would. */
function dataUri(input: AsrAdapterInput): string {
  return `data:${mimeOf(input)};base64,${Buffer.from(input.wav).toString('base64')}`
}

/** Read a nested value without assuming the shape; vendors return nullable objects freely. */
function pick(source: unknown, ...path: (string | number)[]): unknown {
  let cursor: unknown = source
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string | number, unknown>)[step]
  }
  return cursor
}

function pickArray(source: unknown, ...path: (string | number)[]): unknown[] {
  const value = pick(source, ...path)
  return Array.isArray(value) ? value : []
}

/** Waits between polls, but a cancelled take must not sit in this sleep. */
function pause(ctx: AsrAdapterContext, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new ProviderError(mt('转写已取消')))
      return
    }
    let timer: NodeJS.Timeout
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ProviderError(mt('转写已取消')))
    }
    timer = setTimeout(() => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Polls until `check` returns text instead of `null`.
 *
 * `null` means "the job is still running", which is why an empty transcript is a
 * legitimate `''` answer: the vendor said it is done, it just heard nothing.
 */
async function pollFor(
  ctx: AsrAdapterContext,
  what: string,
  check: () => Promise<string | null>
): Promise<string> {
  const deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    const text = await check()
    if (text !== null) return text
    if (Date.now() >= deadline) {
      throw new ProviderError(
        mt('{{what}}超过 {{seconds}} s 还没有结果', {
          what,
          seconds: Math.round(POLL_BUDGET_MS / 1000)
        })
      )
    }
    await pause(ctx, POLL_INTERVAL_MS)
  }
}

/**
 * Same contract as `request`, plus the response headers.
 *
 * Speechmatics hands back the job id only in the `Job-ID` header, and the shared
 * helper deliberately surfaces body and status only, so this one call brings its
 * own small transport instead of widening the shared contract for everybody.
 */
async function requestWithHeaders(
  ctx: AsrAdapterContext,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; body: string; json: unknown }> {
  const controller = new AbortController()
  const forward = (): void => controller.abort()
  if (ctx.signal.aborted) controller.abort()
  ctx.signal.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.text()
    let json: unknown = null
    try {
      json = body ? JSON.parse(body) : null
    } catch {
      json = null
    }
    return { status: response.status, headers: response.headers, body, json }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const label = (() => {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    })()
    throw new ProviderError(
      controller.signal.aborted
      ? mt('{{label}} 超时或已取消', { label })
      : mt('{{label}} 请求失败：{{reason}}', { label, reason })
    )
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', forward)
  }
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

/**
 * Deepgram does not take a file upload at all: the body *is* the audio, so the
 * model and the formatting switches have to travel in the query string, and the
 * key rides on `Authorization: Token …` instead of `Bearer`.
 */
const deepgram: AsrAdapterSpec = {
  id: 'deepgram',
  label: 'Deepgram',
  hosts: ['api.deepgram.com'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.deepgram.com')
    const params = new URLSearchParams({
      model: input.model || 'nova-3',
      smart_format: 'true',
      punctuate: 'true'
    })
    const language = languageOf(input)
    if (language) params.set('language', language)

    const res = await request(ctx, `${versioned(base, 'v1', 'listen')}?${params.toString()}`, {
      method: 'POST',
      headers: headersWith(ctx, {
        ...(ctx.apiKey ? { Authorization: `Token ${ctx.apiKey}` } : {}),
        'content-type': mimeOf(input)
      }),
      body: sendBytes(input.wav)
    })
    failUnless(ok(res.status), res.status, res.body, mt('Deepgram 转写'))
    // The transcript sits four levels deep and the response has no `text` field
    // at any level, so the shared body reader would return ''.
    return pickString(res.json, 'results', 'channels', 0, 'alternatives', 0, 'transcript').trim()
  }
}

/**
 * AssemblyAI is two asynchronous steps: the bytes go to `/v2/upload` only to earn
 * a URL, then a JSON job is created on that URL and polled. Its auth header is
 * the bare key — adding `Bearer` is a 401, which is why the OpenAI path cannot
 * reach it.
 */
const assemblyai: AsrAdapterSpec = {
  id: 'assemblyai',
  label: 'AssemblyAI',
  hosts: ['api.assemblyai.com'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.assemblyai.com/v2')
    const auth = ctx.apiKey ? { authorization: ctx.apiKey } : {}

    const upload = await request(
      ctx,
      versioned(base, 'v2', 'upload'),
      {
        method: 'POST',
        headers: headersWith(ctx, { ...auth, 'content-type': mimeOf(input) }),
        body: sendBytes(input.wav)
      },
      120_000
    )
    failUnless(ok(upload.status), upload.status, upload.body, mt('AssemblyAI 上传音频'))
    const audioUrl = pickString(upload.json, 'upload_url')
    if (!audioUrl) throw new ProviderError(
      mt('AssemblyAI 没有返回 upload_url：{{snippet}}', { snippet: snippet(upload.body) })
    )

    const language = languageOf(input)
    const created = await request(ctx, versioned(base, 'v2', 'transcript'), {
      method: 'POST',
      headers: headersWith(ctx, { ...auth, 'content-type': 'application/json' }),
      body: JSON.stringify({
        audio_url: audioUrl,
        // AssemblyAI calls the model `speech_model`; `best` is the accurate default.
        speech_model: input.model || 'best',
        ...(language ? { language_code: language } : {})
      })
    })
    failUnless(ok(created.status), created.status, created.body, mt('AssemblyAI 建转写任务'))
    const id = pickString(created.json, 'id')
    if (!id) throw new ProviderError(
      mt('AssemblyAI 没有返回任务 id：{{snippet}}', { snippet: snippet(created.body) })
    )

    return pollFor(ctx, mt('AssemblyAI 转写'), async () => {
      const poll = await request(
        ctx,
        `${versioned(base, 'v2', 'transcript')}/${encodeURIComponent(id)}`,
        { method: 'GET', headers: headersWith(ctx, auth) },
        POLL_TIMEOUT_MS
      )
      failUnless(ok(poll.status), poll.status, poll.body, mt('AssemblyAI 查询任务'))
      const state = pickString(poll.json, 'status')
      if (state === 'completed') return pickString(poll.json, 'text').trim()
      if (state === 'error') {
        throw new ProviderError(
          mt('AssemblyAI 转写失败：{{reason}}', {
            reason: pickString(poll.json, 'error') || snippet(poll.body)
          })
        )
      }
      ctx.log(`[asr] assemblyai ${state || 'queued'}`)
      return null
    })
  }
}

/**
 * ElevenLabs is multipart, but every name differs from the OpenAI form: the file
 * field is still `file` while the model is `model_id`, the language is
 * `language_code`, and the key must be `xi-api-key`.
 */
const elevenlabs: AsrAdapterSpec = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  hosts: ['api.elevenlabs.io'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.elevenlabs.io/v1')
    const language = languageOf(input)
    const form = multipart([
      { name: 'file', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav },
      { name: 'model_id', value: input.model || 'scribe_v1' },
      ...(language ? [{ name: 'language_code', value: language }] : [])
    ])

    const res = await request(ctx, versioned(base, 'v1', 'speech-to-text'), {
      method: 'POST',
      headers: headersWith(ctx, {
        ...(ctx.apiKey ? { 'xi-api-key': ctx.apiKey } : {}),
        'content-type': form.contentType
      }),
      body: form.body
    })
    failUnless(ok(res.status), res.status, res.body, mt('ElevenLabs 转写'))
    return pickString(res.json, 'text').trim()
  }
}

/**
 * Gladia refuses to look at the audio directly: `/v2/upload` stores it and
 * returns a URL, `/v2/pre-recorded` creates the job, and the job is read from a
 * third URL the vendor hands back. The key header is `x-gladia-key`.
 */
const gladia: AsrAdapterSpec = {
  id: 'gladia',
  label: 'Gladia',
  hosts: ['api.gladia.io'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.gladia.io/v2')
    const auth = ctx.apiKey ? { 'x-gladia-key': ctx.apiKey } : {}

    const form = multipart([
      { name: 'audio', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav }
    ])
    const upload = await request(
      ctx,
      versioned(base, 'v2', 'upload'),
      { method: 'POST', headers: headersWith(ctx, { ...auth, 'content-type': form.contentType }), body: form.body },
      120_000
    )
    failUnless(ok(upload.status), upload.status, upload.body, mt('Gladia 上传音频'))
    // Gladia's own pages disagree on the field name, so both are accepted.
    const audioUrl = pickString(upload.json, 'audio_url') || pickString(upload.json, 'file_url')
    if (!audioUrl) throw new ProviderError(
      mt('Gladia 没有返回音频地址：{{snippet}}', { snippet: snippet(upload.body) })
    )

    const language = languageOf(input)
    const created = await request(ctx, versioned(base, 'v2', 'pre-recorded'), {
      method: 'POST',
      headers: headersWith(ctx, { ...auth, 'content-type': 'application/json' }),
      body: JSON.stringify({
        audio_url: audioUrl,
        // Without a hint Gladia detects the language itself, which is exactly what
        // an empty `language_config` means; sending `["auto"]` is not a valid code.
        ...(language ? { language_config: { languages: [language] } } : {}),
        diarization: false
      })
    })
    failUnless(ok(created.status), created.status, created.body, mt('Gladia 建转写任务'))
    const resultUrl = pickString(created.json, 'result_url')
    if (!resultUrl) throw new ProviderError(
      mt('Gladia 没有返回 result_url：{{snippet}}', { snippet: snippet(created.body) })
    )

    return pollFor(ctx, mt('Gladia 转写'), async () => {
      const poll = await request(
        ctx,
        resultUrl,
        { method: 'GET', headers: headersWith(ctx, auth) },
        POLL_TIMEOUT_MS
      )
      failUnless(ok(poll.status), poll.status, poll.body, mt('Gladia 查询结果'))
      const state = pickString(poll.json, 'status')
      if (state === 'done') {
        const utterances = pickArray(poll.json, 'result', 'transcription', 'utterances')
        if (utterances.length > 0) {
          return utterances
            .map((utterance) => pickString(utterance, 'text'))
            .filter(Boolean)
            .join(' ')
            .trim()
        }
        // Diarization off still returns an utterances array, but a silent clip can
        // leave it empty while the flattened transcript has the words.
        return pickString(poll.json, 'result', 'transcription', 'full_transcript').trim()
      }
      if (state === 'error' || state === 'failed') {
        throw new ProviderError(
          mt('Gladia 转写失败：{{reason}}', {
            reason:
              pickString(poll.json, 'error', 'message') ||
              pickString(poll.json, 'message') ||
              snippet(poll.body)
          })
        )
      }
      ctx.log(`[asr] gladia ${state || 'processing'}`)
      return null
    })
  }
}

/** Speechmatics words only; punctuation results would otherwise double the spaces. */
function speechmaticsWords(json: unknown): string {
  const words: string[] = []
  for (const result of pickArray(json, 'results')) {
    if (pickString(result, 'type') !== 'word') continue
    const content = pickString(pickArray(result, 'alternatives')[0], 'content')
    if (content) words.push(content)
  }
  return words.join(' ').trim()
}

/**
 * Speechmatics is multipart, but the form is `data_file` plus one `config` field
 * holding a JSON string — model and language are configuration, not form fields.
 * The job is then read back either inline or by polling a transcript endpoint.
 */
const speechmatics: AsrAdapterSpec = {
  id: 'speechmatics',
  label: 'Speechmatics',
  hosts: ['asr.api.speechmatics.com'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://asr.api.speechmatics.com/v2')
    const auth = ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
    // `auto` is not one of the config's accepted language codes; English is the
    // documented fallback when the user has not picked one.
    const language = languageOf(input) || 'en'
    const config = {
      type: 'transcription',
      transcription_config: { language, enable_partials: false }
    }
    const form = multipart([
      { name: 'data_file', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav },
      { name: 'config', value: JSON.stringify(config) }
    ])

    const created = await requestWithHeaders(
      ctx,
      versioned(base, 'v2', 'jobs'),
      {
        method: 'POST',
        headers: headersWith(ctx, {
          ...auth,
          Accept: 'application/json',
          'content-type': form.contentType
        }),
        body: form.body
      },
      120_000
    )
    failUnless(ok(created.status), created.status, created.body, mt('Speechmatics 提交任务'))

    // Some gateways answer a batch request with the finished transcript inline.
    const inline = speechmaticsWords(created.json)
    if (inline) return inline

    // Otherwise the id lives in the `Job-ID` header, and `/v2/jobs` is the poll.
    const jobId =
      created.headers.get('job-id') ||
      pickString(created.json, 'job', 'id') ||
      pickString(created.json, 'id')
    if (!jobId) throw new ProviderError(
      mt('Speechmatics 没有返回任务 id：{{snippet}}', { snippet: snippet(created.body) })
    )

    return pollFor(ctx, mt('Speechmatics 转写'), async () => {
      const poll = await requestWithHeaders(
        ctx,
        `${versioned(base, 'v2', 'jobs')}/${encodeURIComponent(jobId)}/transcript?format=txt`,
        { method: 'GET', headers: headersWith(ctx, auth) },
        POLL_TIMEOUT_MS
      )
      // Before the job finishes the transcript endpoint answers 404/409 rather
      // than a "not ready" body, so those two mean "keep waiting".
      if (poll.status === 404 || poll.status === 409) {
        ctx.log(`[asr] speechmatics ${poll.status === 404 ? 'pending' : 'busy'}`)
        return null
      }
      failUnless(ok(poll.status), poll.status, poll.body, mt('Speechmatics 取转写'))
      if (poll.json) {
        // No words in the body yet: the job is still working.
        return speechmaticsWords(poll.json)
      }
      // `format=txt` answers 200 with an empty body once the job finished and
      // nothing was said. Treating that as "not ready" burned the whole poll
      // budget on a silent take and then reported a timeout.
      return poll.body.trim()
    })
  }
}

/** Fullwidth / CJK starts that already carry their own spacing, so no space is inserted before them. */
const CJK_START = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * Rev.ai streams `monologues[].elements[]` where punctuation is its own element.
 * Words must be space-joined (the transcript is space-delimited English), but a
 * comma or full stop glues to the word before it — and after a glued punctuation
 * a CJK word still takes no space, otherwise 你好，世界 would come back as
 * 你好， 世界.
 */
function revaiText(json: unknown): string {
  let text = ''
  let afterPunct = false
  for (const monologue of pickArray(json, 'monologues')) {
    for (const element of pickArray(monologue, 'elements')) {
      const value = pickString(element, 'value')
      if (!value) continue
      const isPunct = pickString(element, 'type') === 'punct'
      const spaced = text !== '' && !isPunct && !(afterPunct && CJK_START.test(value))
      text += spaced ? ` ${value}` : value
      afterPunct = isPunct
    }
  }
  return text
}

/**
 * Rev.ai is an asynchronous job addressed by `/speechtotext/v1`: submit the media,
 * poll the job until `transcribed`, then fetch a separate transcript document
 * whose shape is `monologues[].elements[]`, not `{text}`.
 */
const revai: AsrAdapterSpec = {
  id: 'revai',
  label: 'Rev.ai',
  hosts: ['api.rev.ai'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.rev.ai/speechtotext/v1')
    const auth = ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}
    const language = languageOf(input)
    const form = multipart([
      { name: 'media', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav }
    ])
    const jobs = versioned(base, 'v1', 'jobs')
    const submitUrl = language ? `${jobs}?language=${encodeURIComponent(language)}` : jobs

    const created = await request(
      ctx,
      submitUrl,
      {
        method: 'POST',
        headers: headersWith(ctx, {
          ...auth,
          Accept: 'application/vnd.rev.transcript.v1.0+json',
          'content-type': form.contentType
        }),
        body: form.body
      },
      120_000
    )
    failUnless(ok(created.status), created.status, created.body, mt('Rev.ai 提交任务'))
    const id = pickString(created.json, 'id')
    if (!id) throw new ProviderError(
      mt('Rev.ai 没有返回任务 id：{{snippet}}', { snippet: snippet(created.body) })
    )
    const jobUrl = `${jobs}/${encodeURIComponent(id)}`

    return pollFor(ctx, mt('Rev.ai 转写'), async () => {
      const poll = await request(
        ctx,
        jobUrl,
        { method: 'GET', headers: headersWith(ctx, auth) },
        POLL_TIMEOUT_MS
      )
      failUnless(ok(poll.status), poll.status, poll.body, mt('Rev.ai 查询任务'))
      const state = pickString(poll.json, 'status')
      if (state === 'failed') {
        throw new ProviderError(
          mt('Rev.ai 转写失败：{{reason}}', {
            reason: pickString(poll.json, 'failure_detail') || snippet(poll.body)
          })
        )
      }
      if (state !== 'transcribed') {
        ctx.log(`[asr] revai ${state || 'in_progress'}`)
        return null
      }
      const transcript = await request(
        ctx,
        `${jobUrl}/transcript`,
        {
          method: 'GET',
          headers: headersWith(ctx, { ...auth, Accept: 'application/vnd.rev.transcript.v1.0+json' })
        },
        POLL_TIMEOUT_MS
      )
      failUnless(ok(transcript.status), transcript.status, transcript.body, mt('Rev.ai 取转写'))
      return revaiText(transcript.json)
    })
  }
}

/**
 * Azure OpenAI breaks the shared path in three places at once: the deployment name
 * is a path segment in the middle, `api-version` is a mandatory query parameter,
 * and the key travels in `api-key` rather than `Authorization`.
 */
const azureOpenai: AsrAdapterSpec = {
  id: 'azure-openai',
  label: mt('Azure OpenAI（转写）'),
  // A suffix: the resource name is the subdomain (`myres.openai.azure.com`).
  hosts: ['openai.azure.com'],
  fields: [
    {
      key: 'deployment',
      label: mt('Azure 部署名'),
      hint: mt('Azure 门户里给模型起的 deployment 名字，不是模型名本身。'),
      placeholder: 'whisper',
      required: true
    },
    {
      key: 'apiVersion',
      label: 'api-version',
      hint: mt('不填就用 2024-06-01。'),
      placeholder: '2024-06-01',
      value: '2024-06-01'
    }
  ],
  async run(ctx, input) {
    const deployment = need(ctx, 'deployment', mt('Azure 部署名'))
    const apiVersion = field(ctx, 'apiVersion', '2024-06-01')
    const base = apiBase(ctx, '')
    if (!base) {
      throw new ProviderError(mt('Azure 端点地址没有填（baseUrl 要指向 https://<resource>.openai.azure.com）'))
    }
    let target: URL
    try {
      target = new URL(base)
    } catch {
      throw new ProviderError(mt('Azure 端点地址看不懂：{{base}}', { base }))
    }

    // The preset's own template already ends in `/openai/deployments/DEPLOYMENT`,
    // and users paste that verbatim; building on top of it would double the
    // segment and 404, so the Azure prefix is stripped before it is re-added.
    let url: string
    const azureShaped = /(^|\.)openai\.azure\.com$/i.test(target.hostname) || /\/openai(\/|$)/i.test(target.pathname)
    if (azureShaped) {
      const prefix = target.pathname.replace(/\/openai(\/deployments\/[^/]+)?\/?$/i, '').replace(/\/+$/, '')
      url =
        `${target.origin}${prefix}/openai/deployments/${encodeURIComponent(deployment)}` +
        `/audio/transcriptions?api-version=${encodeURIComponent(apiVersion)}`
    } else {
      // An OpenAI-compatible host that is not Azure (self-hosted gateway, a test
      // stub pointed at by a profile): keep the standard path instead of inventing
      // a `/openai/deployments/...` that does not exist there.
      url = `${base}/audio/transcriptions`
    }

    const form = multipart([
      { name: 'file', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav },
      { name: 'model', value: input.model || 'whisper' }
    ])
    const res = await request(ctx, url, {
      method: 'POST',
      headers: headersWith(ctx, {
        ...(ctx.apiKey ? { 'api-key': ctx.apiKey } : {}),
        'content-type': form.contentType
      }),
      body: form.body
    })
    failUnless(ok(res.status), res.status, res.body, mt('Azure OpenAI 转写'))
    return pickString(res.json, 'text').trim()
  }
}

/**
 * Cohere's transcription endpoint is multipart, but it lives under `/v2` and its
 * own key travels as a normal Bearer; only the missing-language behaviour differs.
 */
const cohere: AsrAdapterSpec = {
  id: 'cohere',
  label: mt('Cohere（转写）'),
  hosts: ['api.cohere.com', 'api.cohere.ai'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.cohere.com/v2')
    const language = languageOf(input)
    const form = multipart([
      { name: 'file', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav },
      { name: 'model', value: input.model || 'cohere-transcribe-03-2026' },
      // Cohere requires `language`, unlike OpenAI where it is optional; when the
      // user has not chosen one the vendor itself answers with the error.
      ...(language ? [{ name: 'language', value: language }] : [])
    ])
    const res = await request(ctx, versioned(base, 'v2', 'audio/transcriptions'), {
      method: 'POST',
      headers: headersWith(ctx, {
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
        'content-type': form.contentType
      }),
      body: form.body
    })
    failUnless(ok(res.status), res.status, res.body, mt('Cohere 转写'))
    return pickString(res.json, 'text').trim()
  }
}

/**
 * MiniMax wraps the transcript one level deeper (`data.text`) than the OpenAI
 * shape, and the host differs between the China and international accounts.
 */
const minimax: AsrAdapterSpec = {
  id: 'minimax',
  label: mt('MiniMax（语音转文字）'),
  hosts: ['api.minimax.chat', 'api.minimaxi.com', 'api.minimax.io', 'api.minimax.cn'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.minimax.chat/v1')
    const form = multipart([
      { name: 'file', filename: 'audio.wav', contentType: mimeOf(input), data: input.wav },
      { name: 'model', value: input.model || 'speech-01' }
    ])
    const res = await request(ctx, versioned(base, 'v1', 'audio/transcriptions'), {
      method: 'POST',
      headers: headersWith(ctx, {
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
        'content-type': form.contentType
      }),
      body: form.body
    })
    failUnless(ok(res.status), res.status, res.body, mt('MiniMax 转写'))
    return (pickString(res.json, 'text') || pickString(res.json, 'data', 'text')).trim()
  }
}

/**
 * Replicate predictions address a model as `owner/name` in the path, take the
 * audio as a data URI inside a JSON `input` object, and may answer `starting`
 * before the transcript exists — `Prefer: wait=60` usually avoids the poll but
 * cannot be relied on.
 */
function replicateText(output: unknown): string {
  if (typeof output === 'string') return output.trim()
  if (Array.isArray(output)) {
    return output
      .map((part) => (typeof part === 'string' ? part : pickString(part, 'text') || pickString(part, 'transcription')))
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  return (pickString(output, 'transcription') || pickString(output, 'text')).trim()
}

const replicate: AsrAdapterSpec = {
  id: 'replicate',
  label: 'Replicate',
  hosts: ['api.replicate.com'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://api.replicate.com/v1')
    const model = input.model || 'openai/whisper'
    if (!/^[^/]+\/[^/]+$/.test(model)) {
      throw new ProviderError(
        mt('Replicate 的模型要写成 owner/name（现在是「{{model}}」），例如 openai/whisper', {
          model
        })
      )
    }
    const auth = ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}

    const created = await request(
      ctx,
      versioned(base, 'v1', `models/${model}/predictions`),
      {
        method: 'POST',
        headers: headersWith(ctx, {
          ...auth,
          // Ask Replicate to hold the connection until the prediction finishes;
          // when that window is missed the poll below takes over.
          Prefer: 'wait=60',
          'content-type': 'application/json'
        }),
        body: JSON.stringify({ input: { audio: dataUri(input) } })
      },
      90_000
    )
    failUnless(ok(created.status), created.status, created.body, mt('Replicate 预测'))

    const state = pickString(created.json, 'status')
    const immediate = replicateText(pick(created.json, 'output'))
    if (state === 'succeeded' || (!state && immediate)) return immediate
    if (state === 'failed' || state === 'canceled') {
      throw new ProviderError(
      mt('Replicate 预测{{state}}：{{reason}}', {
        state,
        reason: pickString(created.json, 'error') || snippet(created.body)
      })
    )
    }

    const getUrl = pickString(created.json, 'urls', 'get')
    if (!getUrl) throw new ProviderError(
      mt('Replicate 没有返回结果：{{snippet}}', { snippet: snippet(created.body) })
    )

    return pollFor(ctx, mt('Replicate 预测'), async () => {
      const poll = await request(ctx, getUrl, { method: 'GET', headers: headersWith(ctx, auth) }, POLL_TIMEOUT_MS)
      failUnless(ok(poll.status), poll.status, poll.body, mt('Replicate 查询预测'))
      const status = pickString(poll.json, 'status')
      if (status === 'failed' || status === 'canceled') {
        throw new ProviderError(
          mt('Replicate 预测{{status}}：{{reason}}', {
            status,
            reason: pickString(poll.json, 'error') || snippet(poll.body)
          })
        )
      }
      if (status === 'succeeded') return replicateText(pick(poll.json, 'output'))
      ctx.log(`[asr] replicate ${status || 'processing'}`)
      return null
    })
  }
}

/**
 * fal.ai is synchronous, which is the only simple part: the model id *is* the path,
 * the key header is `Authorization: Key …`, and the audio is a JSON `audio_url`
 * (a data URI works, a local file path does not).
 */
const fal: AsrAdapterSpec = {
  id: 'fal',
  label: 'fal.ai',
  hosts: ['fal.run', 'queue.fal.run'],
  fields: [],
  async run(ctx, input) {
    const base = apiBase(ctx, 'https://fal.run')
    const model = (input.model || 'fal-ai/whisper').replace(/^\/+/, '')
    const res = await request(
      ctx,
      `${base}/${model}`,
      {
        method: 'POST',
        headers: headersWith(ctx, {
          ...(ctx.apiKey ? { Authorization: `Key ${ctx.apiKey}` } : {}),
          'content-type': 'application/json'
        }),
        body: JSON.stringify({ audio_url: dataUri(input) })
      },
      120_000
    )
    failUnless(ok(res.status), res.status, res.body, mt('fal.ai 转写'))
    const direct = pickString(res.json, 'text').trim()
    if (direct) return direct
    // Some whisper deployments on fal return per-chunk text instead of one field.
    return pickArray(res.json, 'chunks')
      .map((chunk) => pickString(chunk, 'text').trim())
      .filter(Boolean)
      .join(' ')
  }
}

export const WEST_SPECS: AsrAdapterSpec[] = [
  deepgram,
  assemblyai,
  elevenlabs,
  gladia,
  speechmatics,
  revai,
  azureOpenai,
  cohere,
  minimax,
  replicate,
  fal
]
