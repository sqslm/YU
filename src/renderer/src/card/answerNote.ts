import type { AnswerCardPayload } from '@shared/types'
import { isSafeLink } from '@shared/links'
import i18n from '../i18n'

/** Preserve the visible answer and citation numbers, without exporting tool state. */
export function answerNote(data: AnswerCardPayload): string {
  const literal = (text: string): string => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')
  const sources = (data.sources ?? []).flatMap((source, index) => isSafeLink(source.url)
    ? [`${index + 1}. ${literal(source.title || source.url)} — ${source.url}`] : [])
  return [
    `## ${i18n.t('问题')}`, literal(data.question.trim()),
    ...(data.stopped ? [i18n.t('已停止生成，以下为部分回答。')] : []),
    `## ${i18n.t('回答')}`, data.answer,
    ...(sources.length ? [`## ${i18n.t('来源')}`, sources.join('\n')] : [])
  ].join('\n\n')
}
