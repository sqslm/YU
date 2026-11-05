/**
 * The one place a knowledge source is actually opened.
 *
 * Resolution and execution share the same boundary: a target is produced from the
 * source record the main process trusts, and only a `url` or an app-owned file
 * reaches the OS. Nothing the renderer sends — path, protocol, command — can add
 * permission here, and a source row's own locator never counts as evidence.
 */

import type { KnowledgeSource, SourceTarget } from '@shared/knowledge'

export interface OpenResult {
  opened: boolean
  reason: string
}

export interface OpenDeps {
  /** Same resolver the target channel uses, so both paths agree. */
  resolve(source: KnowledgeSource): SourceTarget
  /** Opens an http(s) address in the user's browser. */
  external(url: string): void
  /** Opens a file the app owns. Returns an empty string on success. */
  file(path: string): Promise<string>
}

export async function openSource(source: KnowledgeSource, deps: OpenDeps): Promise<OpenResult> {
  const target = deps.resolve(source)
  if (target.kind === 'url') {
    if (!/^https?:\/\//i.test(target.url)) return { opened: false, reason: '该来源没有可打开的网页地址' }
    deps.external(target.url)
    return { opened: true, reason: '' }
  }
  if (target.kind === 'file') {
    const failure = await deps.file(target.path)
    return { opened: failure === '', reason: failure }
  }
  return { opened: false, reason: target.kind === 'none' ? target.reason : '请打开对应记录' }
}
