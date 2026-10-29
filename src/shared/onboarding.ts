import type { ProviderProfile, Settings } from './types'
import { missingVendorFields } from './providerFields'

export function configuredProfile(profile: ProviderProfile): boolean {
  let protocol: string
  try { protocol = new URL(profile.baseUrl.trim()).protocol } catch { return false }
  return profile.enabled && (['http:', 'https:'].includes(protocol) || profile.kind === 'asr' && ['ws:', 'wss:'].includes(protocol)) && Boolean(profile.model.trim()) && missingVendorFields(profile.preset, profile.vendor).length === 0
}
export function onboardingCapabilities(settings: Settings, localPresent = false): { text: boolean; voice: boolean } {
  const has = (kind: ProviderProfile['kind']): boolean => settings.profiles.some(profile => profile.kind === kind && configuredProfile(profile))
  return { text: has('llm'), voice: settings.pipelineMode === 'multimodal' ? has('multimodal') : has('asr') || settings.localAsr.enabled && localPresent }
}
export interface OnboardingExample { id: string; title: string; text: string; createsData?: boolean }
export function onboardingExamples(settings: Settings, localPresent = false): OnboardingExample[] {
  const capabilities = onboardingCapabilities(settings, localPresent)
  const examples: OnboardingExample[] = []
  if (capabilities.voice) examples.push({ id: 'dictation', title: '语音听写', text: '今天的想法先记录下来，稍后再整理成计划。' })
  if (!capabilities.text) return examples
  examples.push({ id: 'polish', title: '润色表达', text: '帮我润色这句话：那个就是我们明天下午开个会，然后讨论一下新版本怎么做。' },
    { id: 'translate', title: '翻译', text: '请把这句话翻译成英文：谢谢你的帮助，我们下周再联系。' },
    { id: 'reminder', title: '提醒', text: '十分钟后提醒我起来活动一下。', createsData: true },
    { id: 'todo', title: '待办', text: '帮我添加一个待办：完成本周计划。', createsData: true },
    { id: 'calendar', title: '日程', text: '帮我在明天下午三点添加一个三十分钟的日程，标题是项目评审。', createsData: true },
    { id: 'ask', title: '问一问', text: '用三句话解释什么是番茄工作法。' })
  const blocked = settings.assistantAccess.disabledTools
  return examples.filter(item => !((item.id === 'reminder' || item.id === 'todo') && blocked.includes('create_reminder')) && !(item.id === 'calendar' && blocked.includes('create_event')))
}
