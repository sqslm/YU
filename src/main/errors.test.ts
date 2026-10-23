import { describe, expect, it } from 'vitest'
import { actionsFor, buildBarAlert, classifyError } from './errors'

/**
 * The bar is the only surface these classifications ever reach, so each case
 * asserts what the user would actually see: a kind, a Chinese sentence, whether
 * a retry button may be offered, and the button set itself.
 */

describe('classifyError — provider failures', () => {
  it.each(['没有选中文字', '目标窗口已变化，请重新选择文字', '选区已变化，未修改文字；请重新选择'])('shows an actionable selection failure without blaming the model: %s', message => {
    expect(classifyError(new Error(message))).toEqual({ kind: 'selection', message, retryable: false })
  })
  it('treats a 401 as a credential problem the user must fix in settings', () => {
    const result = classifyError(new Error('ASR HTTP 401'))
    expect(result).toEqual({ kind: 'auth', message: '密钥无效或没有权限', retryable: false })
  })

  it('reads an OpenAI-style key complaint as auth, not as a server fault', () => {
    expect(classifyError('Incorrect API key provided').kind).toBe('auth')
  })

  it('classifies 429 as a retryable rate limit', () => {
    const result = classifyError(new Error('429 Too Many Requests'))
    expect(result.kind).toBe('rate_limit')
    expect(result.retryable).toBe(true)
  })

  it('classifies a DNS failure as a network problem', () => {
    const result = classifyError(new Error('getaddrinfo ENOTFOUND api.example.invalid'))
    expect(result.kind).toBe('no_network')
    expect(result.retryable).toBe(true)
  })

  it('classifies undici "fetch failed" as a network problem', () => {
    expect(classifyError(new Error('fetch failed')).kind).toBe('no_network')
  })

  it('classifies the 25 s ASR budget expiring as a retryable server error', () => {
    const result = classifyError(
      new Error('ASR timed out after 25000 ms (set TYPELESS_ASR_TIMEOUT_MS to raise it)')
    )
    expect(result.kind).toBe('server_error')
    expect(result.retryable).toBe(true)
  })

  it('classifies a 5xx as a server error', () => {
    expect(classifyError(new Error('HTTP 503 Service Unavailable')).kind).toBe('server_error')
  })

  it('classifies a provider-side transcript failure as asr_failed', () => {
    expect(classifyError(new Error('asr returned an empty transcript')).kind).toBe('asr_failed')
  })

  it('refuses to retry a take that was too long for the backend', () => {
    const result = classifyError(new Error('录音超过上限'))
    expect(result.kind).toBe('server_error')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyError — microphone failures', () => {
  it('maps a denied getUserMedia permission to mic_denied', () => {
    const result = classifyError(
      new Error('microphone unavailable: NotAllowedError: Permission denied')
    )
    expect(result).toEqual({
      kind: 'mic_denied',
      message: '麦克风权限被拒绝，请在系统设置里允许',
      retryable: false
    })
  })

  it('maps a dismissed permission prompt to mic_denied', () => {
    expect(classifyError(new Error('microphone unavailable: Permission dismissed')).kind).toBe(
      'mic_denied'
    )
  })

  it('maps a missing device to mic_missing', () => {
    const result = classifyError(
      new Error('microphone unavailable: NotFoundError: Requested device not found')
    )
    expect(result).toEqual({
      kind: 'mic_missing',
      message: '没有找到可用的麦克风',
      retryable: false
    })
  })

  it('maps a device that disappears mid-recording to mic_missing', () => {
    expect(classifyError(new Error('microphone lost: track ended')).kind).toBe('mic_missing')
  })

  it('maps an unreadable audio source to mic_missing', () => {
    expect(
      classifyError(new Error('microphone unavailable: NotReadableError: Could not start audio source'))
        .kind
    ).toBe('mic_missing')
  })

  it('maps an overconstrained device request to mic_missing', () => {
    expect(classifyError(new Error('microphone unavailable: OverconstrainedError')).kind).toBe(
      'mic_missing'
    )
  })

  it('keeps a 403 that mentions permissions on the auth path', () => {
    // The microphone rules must not swallow provider messages that merely talk
    // about permissions: a bad key is still fixed by opening settings for the key.
    expect(classifyError(new Error('ASR HTTP 403: permission denied for project')).kind).toBe(
      'auth'
    )
  })
})

describe('classifyError — unknown input', () => {
  it('falls back to a retryable llm_failed for an unrelated message', () => {
    const result = classifyError(new Error('something exploded'))
    expect(result).toEqual({ kind: 'llm_failed', message: '处理失败', retryable: true })
  })

  it('survives a non-Error, empty input without throwing', () => {
    expect(classifyError(undefined).kind).toBe('llm_failed')
    expect(classifyError('').kind).toBe('llm_failed')
  })
})

describe('actionsFor', () => {
  it('offers a microphone switch, settings and dismiss for a missing device', () => {
    expect(actionsFor(classifyError(new Error('no microphone')))).toEqual([
      'choose_mic',
      'open_settings',
      'dismiss'
    ])
  })

  it('offers only settings and dismiss for a denied permission', () => {
    expect(actionsFor(classifyError(new Error('Permission denied')))).toEqual([
      'open_settings',
      'dismiss'
    ])
  })

  it('never offers retry for a microphone failure, since the device will not recover', () => {
    for (const message of ['no microphone', 'Permission denied']) {
      expect(actionsFor(classifyError(new Error(message)))).not.toContain('retry')
    }
  })

  it('keeps retry for a transient backend failure', () => {
    expect(actionsFor(classifyError(new Error('429 Too Many Requests')))).toEqual([
      'retry',
      'dismiss'
    ])
  })

  it('offers no retry when the failure is permanent but not about credentials', () => {
    expect(actionsFor(classifyError(new Error('录音超过上限')))).toEqual(['dismiss'])
  })
})

describe('buildBarAlert', () => {
  it('renders the Chinese microphone labels the bar shows', () => {
    const alert = buildBarAlert(classifyError(new Error('Requested device not found')))
    expect(alert.kind).toBe('mic_missing')
    expect(alert.text).toBe('没有找到可用的麦克风')
    // Neither microphone failure is retryable, so the bar must warn rather than
    // paint the red "we failed and you can try again" state.
    expect(alert.level).toBe('warn')
    expect(alert.actions?.map((action) => action.label)).toEqual(['换麦克风', '设置', '关闭'])
  })

  it('renders the denied-permission text plus its two buttons', () => {
    const alert = buildBarAlert(classifyError(new Error('Permission dismissed')))
    expect(alert.text).toBe('麦克风权限被拒绝，请在系统设置里允许')
    expect(alert.actions?.map((action) => action.id)).toEqual(['open_settings', 'dismiss'])
  })
})
