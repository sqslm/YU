/** Host privacy scope, not a replacement for Mem0's retrieval/ranking engine. */
export function personalMemoryQuery(text: string): boolean {
  return /我|我们|记得|记住|之前|上次|刚才|习惯|偏好|推荐|项目|\b(?:i|me|my|mine|we|our|remember|previous|preference|prefer|recommend|project)\b/iu.test(text.replace(/^(?:请)?(?:帮我|替我|给我|为我)|^(?:please\s+)?(?:help me|tell me|show me)\s*/iu, ''))
}
