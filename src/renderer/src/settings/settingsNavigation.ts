export const SETTINGS_GROUPS = [
  { id: 'preferences', label: '偏好与快捷键' },
  { id: 'voice', label: '语音与输入' },
  { id: 'ai', label: '模型与智能' },
  { id: 'assistant', label: '助手与自动化' },
  { id: 'daily', label: '日程与提醒' },
  { id: 'app', label: '数据与应用' }
] as const

type SettingsGroupId = typeof SETTINGS_GROUPS[number]['id']
interface SettingsPage {
  id: string
  group: SettingsGroupId
  label: string
  description: string
  keywords: string
}

/** Every destination is also searchable, including the former horizontal tabs. */
export const SETTINGS_PAGES = [
  { id: 'general', group: 'preferences', label: 'settings.nav.general', description: '外观、语言、启动与交互反馈。', keywords: '主题 theme appearance language startup 界面 音效 提示' },
  { id: 'shortcuts', group: 'preferences', label: 'settings.nav.shortcuts', description: '为常用操作配置顺手的快捷键。', keywords: 'hotkey keyboard 快捷键 按键 录音 截图' },
  { id: 'speech', group: 'voice', label: '录音与语言', description: '选择麦克风，调整识别语言与音频处理。', keywords: 'microphone mic audio device language 麦克风 设备 识别 翻译 语言 音频 降噪' },
  { id: 'wake', group: 'voice', label: '语音唤醒', description: '使用唤醒词打开语音入口，并学习你的发音。', keywords: 'wake word training confidence 唤醒词 置信度 学习' },
  { id: 'commands', group: 'voice', label: '语音指令', description: '管理口头指令与对应的输入操作。', keywords: 'voice command 语音 指令 口令' },
  { id: 'input', group: 'voice', label: '文本插入', description: '调整文本插入、剪贴板恢复与应用排除。', keywords: 'clipboard paste selection SendInput 剪贴板 粘贴 选区 换行 排除' },
  { id: 'entities', group: 'voice', label: '实体增强', description: '让人名、术语与专有名词的识别更准确。', keywords: 'entity vocabulary 人名 专有名词 术语 热词 实体' },
  { id: 'models', group: 'ai', label: 'LLM模型', description: '连接理解、处理与生成文字的模型。', keywords: 'llm api key base url provider connection token 密钥 模型 连接 提供商 多模态' },
  { id: 'asr', group: 'ai', label: 'ASR模型', description: '配置语音识别连接，或使用本地模型。', keywords: 'asr speech local offline 识别 离线 本地 模型 下载 密钥' },
  { id: 'tts', group: 'ai', label: 'TTS模型', description: '选择朗读声音，配置语速与语音服务。', keywords: 'tts read aloud voice speech 朗读 声音 语速 播放' },
  { id: 'prompts', group: 'ai', label: 'settings.nav.prompts', description: '按任务管理提示词与文本处理风格。', keywords: 'prompt polish 翻译 润色 提示词' },
  { id: 'routing', group: 'ai', label: 'settings.nav.routing', description: '按应用与网页选择提示词和文本处理场景。', keywords: 'routing window app domain prompt category 窗口归类 域名 提示词 场景' },
  { id: 'search', group: 'ai', label: 'settings.nav.search', description: '管理联网搜索的服务连接与检索范围。', keywords: 'search web internet 搜索 联网 检索 密钥' },
  { id: 'memory', group: 'assistant', label: '长期记忆', description: '管理助手可以记住的偏好与个人信息。', keywords: 'memory learning privacy 记忆 学习 偏好 隐私' },
  { id: 'assistant', group: 'assistant', label: '助手与权限', description: '设置工具权限、文件范围与本地搜索。', keywords: 'permissions tools file Everything 权限 工具 文件 下载目录 搜索' },
  { id: 'automation', group: 'assistant', label: 'settings.nav.automation', description: '管理可由一句话触发的工作流。', keywords: 'workflow automation 工作流 自动化 条件' },
  { id: 'life', group: 'daily', label: '日历与订阅', description: '设置日程提醒，并连接外部订阅日历。', keywords: 'calendar ics subscription 日程 日历 订阅 提前提醒' },
  { id: 'briefing', group: 'daily', label: '每日简报', description: '安排简报时间、内容与免打扰时段。', keywords: 'briefing daily quiet 简报 每日 时间 免打扰' },
  { id: 'delivery', group: 'daily', label: '简报投递', description: '配置简报的邮件与手机推送渠道。', keywords: 'delivery email ntfy resend push 邮件 手机 推送 投递' },
  { id: 'reminders', group: 'daily', label: '提醒与待办', description: '调整通知、强提醒提示音与稍后提醒。', keywords: 'reminder todo notification snooze 通知 提醒 待办 稍后' },
  { id: 'storage', group: 'app', label: 'settings.nav.storage', description: '管理历史保留、随记目录与本地数据。', keywords: 'storage history notes folder retention 数据 历史 随记 目录 迁移' },
  { id: 'resources', group: 'app', label: 'settings.nav.resources', description: '查看资源使用，并管理游戏模式与性能。', keywords: 'resources performance game cpu memory 性能 资源 内存 游戏模式' },
  { id: 'account', group: 'app', label: 'settings.nav.account', description: '管理账户登录与设备间的数据同步。', keywords: 'account sync login server 账户 账号 登录 同步 服务端' },
  { id: 'about', group: 'app', label: 'settings.nav.about', description: '了解产品、检查版本与查看诊断信息。', keywords: 'about version update diagnostics 关于 版本 更新 诊断 日志' }
] as const satisfies readonly SettingsPage[]

export type SettingsPageId = typeof SETTINGS_PAGES[number]['id']

export function settingsPageFor(id: string): typeof SETTINGS_PAGES[number] {
  return SETTINGS_PAGES.find(page => page.id === id) ?? SETTINGS_PAGES[0]!
}

export function searchSettings(query: string, translate: (key: string) => string): Array<typeof SETTINGS_PAGES[number]> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return SETTINGS_PAGES.filter(page => {
    const group = SETTINGS_GROUPS.find(group => group.id === page.group)!
    const text = [translate(page.label), translate(page.description), translate(group.label), page.keywords].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
}
