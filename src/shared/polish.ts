/** Shared by dictation, selected prose and notes; ASR originals are never changed. */
export const POLISH_OUTPUT_RULES = 'Return only the final edited source text. Do not append stray characters, explanations, reasoning tags, labels, new requirements or alternative versions. Express each requirement once, merging accidental repetition. Never restate one instruction as both a heading and its only child: use a topic heading only to group multiple distinct instructions; otherwise write that instruction on one line. Preserve deliberate repetition, negations, numbers, dates, identifiers and code. Never insert a fact or requirement that is absent from the source.'

/** Remove identifiable output artifacts; never guess which ordinary letters/words are wrong. */
export function cleanPolishedText(output: string, source: string): string {
  let text = output.trim()
  if (!/<(?:think|analysis)>/i.test(source)) text = text.replace(/^(?:<(think|analysis)>[\s\S]*?<\/\1>\s*)+/i, '')
  if (!/以下是.*(?:润色|修改)|润色(?:结果|后)/u.test(source)) text = text.replace(/^(?:以下是(?:润色|修改|整理)后的(?:文本|内容)|润色(?:结果|后的文本))[：:]\s*/u, '')
  for (const artifact of ['\uFFFD', '\u200B', '\uFEFF']) if (!source.includes(artifact)) text = text.split(artifact).join('')
  if (/重复[两二三四五\d].{0,2}遍|写[两二三四五\d]遍|repeat.{0,20}(?:twice|times)/iu.test(source)) return text.trim()
  const original = source.replace(/\s/g, '')
  const seen = new Set<string>()
  return text.split(/(```[\s\S]*?```)/g).map((part, index) => {
    if (index % 2) return part
    return part.split(/(?<=[。！？!?\n])/u).filter(chunk => {
      if (/^\s*(?:\/\/|#|\*)/u.test(chunk)) return true
      const key = chunk.trim().replace(/^(?:\d+[.)、]|[（(][a-z\d][)）]|[-•])\s*/iu, '').replace(/[。.!?！？]+$/u, '').replace(/\s/g, '')
      if (key.length < 8 || original.split(key).length > 2) return true
      if (seen.has(key)) return false
      seen.add(key); return true
    }).join('')
  }).join('').trim()
}
