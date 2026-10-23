import type { BarAlert, BarActionId, BarAlertKind } from '@shared/types'
import { mt } from '@shared/mainI18n'

/**
 * One pipeline failure turned into something the floating bar can show and act
 * on. `retryable` drives whether the alert carries a retry button (REQ-12).
 */
export interface ClassifiedError {
  kind: BarAlertKind
  /** Short, user-facing sentence — never a raw stack message. */
  message: string
  retryable: boolean
}

interface Rule extends ClassifiedError {
  test: RegExp
}

/**
 * Ordered matchers. The first hit wins, so the most specific patterns come
 * first: `fetch failed` (undici) also contains "failed", and a 401 body often
 * mentions the model name.
 */
const RULES: Rule[] = [
  {
    // Nothing is configured yet. This must not read as a network problem: the
    // fix lives in settings and a retry would fail identically forever.
    test: /没有可用的提供商配置|no_provider/i,
    kind: 'no_provider',
    message: mt('还没有可用的模型配置，去「模型」里添加一条'),
    retryable: false
  },
  {
    test: /invalid api key|incorrect api key|unauthorized|\b401\b|\b403\b|authentication|api[ _-]?key/i,
    kind: 'auth',
    message: mt('密钥无效或没有权限'),
    retryable: false
  },
  {
    test: /\b429\b|rate limit|too many requests|quota|insufficient_quota/i,
    kind: 'rate_limit',
    message: mt('请求太频繁或额度用尽'),
    retryable: true
  },
  // Microphone failures come from the bar renderer, not from a provider, so they
  // must be claimed before the generic network/timeout/server rules: "could not
  // start audio source" would otherwise read as a service problem (ACC-12).
  // They sit after auth/rate_limit because a 401 body may mention permissions.
  {
    // Deliberately narrow. A bare `/permission/` also matched the word inside a
    // provider's 5xx body, so a server outage told the user their microphone was
    // blocked. Only the microphone wordings Chromium actually emits are claimed.
    test:
      /notallowed|permission denied|permission dismissed|(?:microphone|capture|audio)[^.]{0,40}permission|permission[^.]{0,40}(?:microphone|capture|audio)/i,
    kind: 'mic_denied',
    message: mt('麦克风权限被拒绝，请在系统设置里允许'),
    retryable: false
  },
  {
    // `\bnotfound`, not bare `notfound`: DNS failures surface as ENOTFOUND and
    // must stay network errors instead of becoming a missing-microphone alert.
    // The spaced form matters too — Chrome words a vanished device as
    // "Requested device not found".
    test: /requested device not found|device not found|devices?notfound|\bnotfound|no microphone|overconstrained|notreadable|could not start audio source|microphone lost|track ended/i,
    kind: 'mic_missing',
    message: mt('没有找到可用的麦克风'),
    retryable: false
  },
  {
    test: /enotfound|econnrefused|econnreset|etimedout|getaddrinfo|fetch failed|network|offline|socket hang up/i,
    kind: 'no_network',
    message: mt('连不上服务，检查网络或后端地址'),
    retryable: true
  },
  {
    test: /timeout|timed out|aborted due to timeout/i,
    kind: 'server_error',
    message: mt('服务响应超时'),
    retryable: true
  },
  {
    test: /^asr|转写|transcri/i,
    kind: 'asr_failed',
    message: mt('转写失败'),
    retryable: true
  },
  {
    test: /\b5\d\d\b|internal server error|bad gateway|service unavailable/i,
    kind: 'server_error',
    message: mt('服务端出错'),
    retryable: true
  },
  {
    test: /录音超过|too long|exceeds/i,
    kind: 'server_error',
    message: mt('录音过长，超出当前上限'),
    retryable: false
  }
]

const FALLBACK: ClassifiedError = {
  kind: 'llm_failed',
  message: mt('处理失败'),
  retryable: true
}

/**
 * Maps an error message (or Error) to a bar alert kind. Unknown messages fall
 * back to a retryable `llm_failed`, because the overwhelming majority of
 * failures at that point are model-side and worth one more try.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  const selectionMessages = ['没有选中文字', '目标窗口已变化，请重新选择文字', '无法返回原输入框，请重新选择文字',
    '选区已变化，未修改文字；请重新选择', '此应用不允许自动读取选区', '敏感应用不允许读取上下文']
  if (selectionMessages.some(text => message === text || message === mt(text))) {
    return { kind: 'selection', message: mt(message), retryable: false }
  }
  for (const rule of RULES) {
    if (rule.test.test(message)) {
      return { kind: rule.kind, message: rule.message, retryable: rule.retryable }
    }
  }
  return FALLBACK
}

/** The retry/dismiss buttons an alert of this kind should carry. */
export function actionsFor(classified: ClassifiedError): BarActionId[] {
  if (classified.kind === 'auth') return ['open_settings', 'dismiss']
  // Retrying is meaningless for a microphone: the device is gone or the OS will
  // not ask for the permission again, so the fix has to happen in settings.
  if (classified.kind === 'mic_missing') return ['choose_mic', 'open_settings', 'dismiss']
  if (classified.kind === 'mic_denied') return ['open_settings', 'dismiss']
  // No provider means nothing to retry: the next attempt fails the same way
  // until a profile is added.
  if (classified.kind === 'no_provider') return ['open_settings', 'dismiss']
  // A dead network is retried by the user (it usually comes back) but it is also
  // the symptom of a wrong backend URL, so settings has to be one click away.
  if (classified.kind === 'no_network') return ['retry', 'open_settings', 'dismiss']
  if (classified.retryable) return ['retry', 'dismiss']
  return ['dismiss']
}

/** Builds the `BarAlert` pushed to the renderer, with Chinese button labels. */
export function buildBarAlert(classified: ClassifiedError): BarAlert {
  const labels: Record<BarActionId, string> = {
    open_assistant: mt('查看详情'),
    retry: mt('重试'),
    cancel: mt('取消'),
    copy: mt('复制'),
    open_settings: mt('设置'),
    choose_mic: mt('换麦克风'),
    download: mt('下载'),
    dismiss: mt('关闭'),
    'undo-reminder': mt('撤销')
  }
  const level = classified.retryable ? 'error' : 'warn'
  return {
    kind: classified.kind,
    level,
    text: classified.message,
    actions: actionsFor(classified).map((id) => ({ id, label: labels[id] }))
  }
}
