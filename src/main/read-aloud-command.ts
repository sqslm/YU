/** Explicit read-aloud commands resolve real sources before any model round. */
export function readAloudCommand(input: string): { name: 'read_aloud'; args: Record<string, unknown> } | null {
  const value = input.trim().replace(/[。！!.?？]+$/u, '')
  const prefix = /^(?:(?:请|帮我|请帮我|麻烦你?|你帮我)\s*)?(?:把|将)?\s*/u
  const raw = value.replace(prefix, '')
  let target: string | undefined
  const first = /^(?:朗读|读给我听|念给我听|念一遍|读一遍|读一下|读出来|念出来|播报)(?:一下)?\s*(.*)$/u.exec(raw)
  const last = /^(.*?)\s*(?:朗读|读给我听|念给我听|读一遍|念一遍|读出来|念出来)(?:一下)?$/u.exec(raw)
  const english = /^(?:please\s+)?(?:read(?:\s+aloud)?|speak)\s+(.+?)(?:\s+(?:aloud|to me))?$/iu.exec(value)
  target = first?.[1] ?? last?.[1] ?? english?.[1]
  if (target === undefined || /不要|不用|别|无需|然后|并且|同时|\b(?:don't|do not|never|then|also)\b/iu.test(raw)) return null
  const args: Record<string, unknown> = {}
  if (/^[：:]?\s*https?:\/\//iu.test(target)) {
    args.source = 'webpage'; args.url = target.match(/https?:\/\/[^\s<>"，。！？]+/iu)?.[0]
  } else if (/^[：:]/u.test(target) || /^[「『“"].*[」』”"]$/u.test(target)) {
    args.source = 'text'; args.text = target.replace(/^[：:「『“"]\s*|[」』”"]$/gu, '')
  } else if (/https?:\/\//iu.test(target)) {
    args.source = 'webpage'; args.url = target.match(/https?:\/\/[^\s<>"，。！？]+/iu)?.[0]
  } else if (/随记|笔记|\bnote\b/iu.test(target)) {
    args.source = 'note'
    const named = /(?:标题(?:为|是|叫做?|叫作)?|名为|叫做?|叫作)\s*[「『“"《]?(.+?)[」』”"》]?(?:的(?:正文|内容|随记|笔记))?$/u.exec(target) || /\bnote\s+(?:titled|named|called)\s+["']?(.+?)["']?$/iu.exec(target)
    if (named) args.title = named[1].trim()
    else if (/最近|最新|刚才|上一条|\b(?:latest|last|recent)\b/iu.test(target)) args.latest = true
    else {
      const title = target.replace(/^(?:我(?:的)?)?(?:随记|笔记)(?:里(?:面)?|中)?(?:的)?\s*/u, '').replace(/(?:的)?(?:内容|正文)$/u, '').replace(/^[「『“"《]|[」』”"》]$/gu, '').trim()
      if (title) args.title = title
    }
  } else if (/选中|选区|\b(?:selected|selection)\b/iu.test(target) && !/文件|文档|\b(?:file|document)\b/iu.test(target)) args.source = 'selection'
  else if (/剪贴板|\bclipboard\b/iu.test(target)) args.source = 'clipboard'
  else if (/简报|\bbriefing\b/iu.test(target)) args.source = 'briefing'
  else if (/待办|提醒|\b(?:todos?|reminders?)\b/iu.test(target)) args.source = 'reminders'
  else if (/日程|日历|\b(?:calendar|schedule|events?)\b/iu.test(target)) args.source = 'calendar'
  else if (/润色|听写|翻译|\b(?:polished|polish|dictation|translation)\b/iu.test(target)) {
    args.source = 'result'; args.mode = /翻译|\btranslation\b/iu.test(target) ? 'translate' : 'dictation'
  } else if (/回答|回复|答案|\b(?:answer|reply|response)\b/iu.test(target)) args.source = 'answer'
  else if (/网页|文章|页面|网站|文件|文档|表格|PDF|Word|Excel|PPT|\b(?:page|article|website|file|document|spreadsheet|presentation|pdf)\b/iu.test(target) && /当前|这个|这篇|这份|打开|正在|浏览器|\b(?:this|current|open|active)\b/iu.test(target)) args.source = 'current_content'
  else if (/^(?:这(?:段|些)(?:文字|文本|内容)|以下(?:文字|内容)?|下面(?:文字|内容)?|(?:the )?following(?: text)?)[：:\s]+/iu.test(target)) {
    args.source = 'text'; args.text = target.replace(/^[^：:]*[：:]\s*/u, '')
  } else return target ? null : { name: 'read_aloud', args: { source: 'unspecified' } }
  if (args.source === 'calendar' || args.source === 'reminders') {
    if (/明天|\btomorrow\b/iu.test(target)) args.day = 'tomorrow'
    else if (/今天|\btoday\b/iu.test(target) || args.source === 'calendar') args.day = 'today'
  }
  return { name: 'read_aloud', args }
}
