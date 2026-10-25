import { directVoiceIntent, isDictatedContent, isReminderCreationRequest } from './voice-intent'

/** Authority comes from the request, never from quoted examples or model-generated arguments. */
export function requestsContextRead(input: string, resource: 'selection' | 'clipboard'): boolean {
  if (isDictatedContent(input)) return false
  const intent = directVoiceIntent(input)
  if (intent?.kind === 'reminder' || intent?.kind === 'notes') return false
  const text = input.replace(/[“「『"][^”」』"\n]*[”」』"]/gu, '')
  return text.split(/[，,;；。!?！？\n]/u).some(clause => {
    if (isReminderCreationRequest(clause.trim())) return false
    const target = resource === 'clipboard' ? /剪贴板|刚(?:刚|才)复制|\b(?:clipboard|copied)\b/iu : /选中|选区|这段(?:代码|文字|文本|注释)|\b(?:selected|selection|this code|this text|this comment)\b/iu
    if (!target.test(clause) || /不要|别|无需|不必|禁止|未授权|\b(?:do not|don't|never|without)\b/iu.test(clause)) return false
    return /读|读取|查看|获取|看看|解释|说明|分析|总结|润色|改写|修改|替换|翻译|保存|\b(?:read|get|show|explain|summari[sz]e|analy[sz]e|describe|polish|rewrite|edit|replace|translate|save)\b/iu.test(clause)
  })
}
