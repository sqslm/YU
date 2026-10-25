import { directVoiceIntent, isDictatedContent, isReminderCreationRequest, screenshotNeedsEditor } from './voice-intent'

/** Authority comes from the request, never from quoted examples or model-generated arguments. */
export function requestsContextRead(input: string, resource: 'selection' | 'clipboard' | 'screenshot'): boolean {
  if (isDictatedContent(input)) return false
  const intent = directVoiceIntent(input)
  if (intent?.kind === 'reminder' || intent?.kind === 'notes') return false
  if (resource === 'screenshot' && screenshotNeedsEditor(input) && !/不要|别|无需|不必|禁止|\b(?:do not|don't|never)\b/iu.test(input)) return true
  const text = input.replace(/[“「『"][^”」』"\n]*[”」』"]/gu, '')
  return text.split(/[，,;；。!?！？\n]/u).some(clause => {
    if (isReminderCreationRequest(clause.trim())) return false
    const target = resource === 'screenshot' ? /截图|截屏|屏幕|当前(?:窗口|界面)|这个界面|(?:这张|这个|当前|屏幕上).{0,10}(?:图|图片|图表)|\b(?:screenshot|screen|interface|this image|current image)\b/iu : resource === 'clipboard' ? /剪贴板|刚(?:刚|才)复制|\b(?:clipboard|copied)\b/iu : /选中|选区|这段(?:代码|文字|文本|注释)|\b(?:selected|selection|this code|this text|this comment)\b/iu
    if (!target.test(clause) || /不要|别|无需|不必|禁止|未授权|\b(?:do not|don't|never|without)\b/iu.test(clause)) return false
    return /截(?:图|屏|一下)|反映|提取|识别|读|读取|查看|获取|看看|解释|说明|分析|总结|润色|改写|修改|替换|翻译|保存|\b(?:extract|capture|read|get|show|explain|summari[sz]e|analy[sz]e|describe|polish|rewrite|edit|replace|translate|save)\b/iu.test(clause)
  })
}
