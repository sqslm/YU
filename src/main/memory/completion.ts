import type { ChatMessage } from '../providers/llm'
import { validateMemoryReply, type MemoryReplyKind } from '@shared/memory-reply'

export class MemoryReplyError extends Error {}

/** One format retry using the original SDK request. Malformed output never becomes learning input. */
export async function memoryCompletion(messages: ChatMessage[], kind: MemoryReplyKind, signal: AbortSignal,
  request: (messages: ChatMessage[]) => Promise<string>): Promise<string> {
  const contract = kind === 'facts'
    ? '只返回 {"facts":[]} 形态的 JSON 对象，facts 是从原始输入提取的事实字符串数组。先整理再提取：删除“嗯、呃、那个、呢”等口头语、重复和自我修正；每条改写为第三人称的简洁独立事实，不复制整段转写。保留原意、专名、数值与约束，不添加信息。例：“我现在在制作语的介绍视频，呃，预计3分半，重点展示智能路由和长期记忆”应整理为“用户正在制作语的介绍视频，预计3分半，重点展示智能路由和长期记忆”。无可记内容时为空数组。最多20条，每条不超过2000字。'
    : '只返回 {"memory":[]} 形态的 JSON 对象，memory 是操作数组。每项包含 id 字符串、event 字符串和 text 正文；event 仅限 ADD、UPDATE、DELETE、NONE 四者之一。无变化时为空数组。UPDATE/DELETE必须使用输入提供的数字ID，不要猜测。最多20条，每条正文不超过2000字。'
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted()
    const reply = await request([...messages, { role: 'system', content: contract + ' 不要输出思考过程、解释或 Markdown。严格遵守原提取规则，不推测事实。' + (attempt ? ' 上一次输出的格式校验未通过，请根据原始输入重新输出完整、合法的 JSON，不改变原意。' : '') }])
    signal.throwIfAborted()
    try { return validateMemoryReply(reply, kind) }
    catch { if (attempt) throw new MemoryReplyError('Memory JSON validation failed') }
  }
  throw new MemoryReplyError('Memory JSON validation failed')
}
