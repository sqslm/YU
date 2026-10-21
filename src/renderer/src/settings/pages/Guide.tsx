import { Box, Chip, Stack, Typography } from '@mui/material'
import i18n from '../../i18n'

/**
 * The four questions every section answers, in the order a reader asks them.
 * Keeping the wording in one place means all twelve cards line up when scanned
 * vertically, and a new section cannot invent a fifth shape.
 */
const ASPECT_LABEL = {
  what: '是什么',
  how: '怎么设置',
  limit: '限制',
  fix: '出错怎么办'
} as const

type AspectKey = keyof typeof ASPECT_LABEL

/** Fixed render order; `Object.keys` order is not something to rely on. */
const ASPECT_ORDER: AspectKey[] = ['what', 'how', 'limit', 'fix']

interface GuideSection {
  /** DOM id the table of contents scrolls to. */
  id: string
  title: string
  /** One short bullet per line — this page is read while setting something up. */
  points: Record<AspectKey, string[]>
}

const SECTIONS: GuideSection[] = [
  {
    id: 'guide-start',
    title: i18n.t('快速开始'),
    points: {
      what: [
        '右 Alt 是全局录音键：听写按右 Alt，问答按右 Alt + 空格，翻译按右 Alt + 右 Shift。',
        '识别结果直接打到当前光标处，不用先切窗口再粘贴。'
      ],
      how: [
        '先在「模型」里保存一条能用的转写配置，否则每次录音都会以「未配置」失败。',
        '在记事本里按一次右 Alt 试跑；「触发方式」可以切成「按住说话」或「按一下开始」。'
      ],
      limit: ['单次录音默认上限 540 秒；翻译一次最多 3 个目标语言。'],
      fix: [
        '悬浮条不出现：看快捷键是否被别的程序占用。',
        '有波形但插不进文字：把「文本插入方式」改成「剪贴板 + Ctrl+V」。'
      ]
    }
  },
  {
    id: 'guide-hotkeys',
    title: i18n.t('快捷键'),
    points: {
      what: [
        '听写、问答、翻译、粘贴上一条各自绑一组键，按键由底层钩子拦截，不会漏给前台应用。'
      ],
      how: [
        '设置 → 快捷键 → 点「录制」，按下组合键后松开第一个键即保存。',
        '第一个键是主键，其余键当修饰用；「粘贴上一条」默认 Ctrl + 右 Shift + V。'
      ],
      limit: ['和别的全局热键撞了会被对方抢走；组合越长越容易按错。'],
      fix: ['没反应时换一个不冲突的组合，或把「启用全局快捷键」关掉再打开，让钩子重新注册。']
    }
  },
  {
    id: 'guide-modes',
    title: i18n.t('听写与模式'),
    points: {
      what: [
        '「传统」走两次请求：先把音频转成文字，再交给语言模型润色。',
        '「多模态」把音频直接交给多模态模型，一次请求出结果，模型还能听到语气和停顿。'
      ],
      how: [
        '设置 → 模型 →「模式」里切换；多模态要填 Gemini generateContent 兼容的地址、密钥和模型名。'
      ],
      limit: [
        '多模态单次时长受模型上限约束，默认 120 秒，可调 5–600 秒。',
        '传统链路能接任意 OpenAI 兼容网关，成本更低、每步都可替换。'
      ],
      fix: [
        '多模态报错先核对模型名与请求路径。',
        '传统链路失败多半是转写网关不吃这种音频格式，把「压缩上传（Opus）」关掉再试。'
      ]
    }
  },
  {
    id: 'guide-general',
    title: i18n.t('设置分类'),
    points: {
      what: ['通用管理外观、启动与提示；语音与翻译管理语言和录音；文本输入管理插入与应用排除；数据与存储管理历史和目录。'],
      how: [
        '「语音识别语言」选自动检测适合中英混说；「翻译目标语言」最多选 3 个。',
        '换麦克风后先用「说话测试」看电平条和峰值 dBFS。'
      ],
      limit: [
        '「压缩上传（Opus）」默认关闭：一分钟语音约 180 KB 而不是 2.8 MB，但本地转写服务多数只吃 WAV。',
        '「交互音效」只是提示音，不参与识别。'
      ],
      fix: [
        '电平条不动：换设备或检查 Windows 的输入权限。',
        'Opus 被拒时本机会自动回退 WAV，仍失败就看转写配置，而不是这一页。'
      ]
    }
  },
  {
    id: 'guide-history',
    title: i18n.t('历史记录'),
    points: {
      what: ['每次录音的文本（按策略连录音文件）都写在本机，概览统计和「历史记录」页读的是同一份数据。'],
      how: [
        '设置 → 数据与存储 →「历史记录上限」默认 500 条，超出自动删最旧。',
        '「历史保留期」默认永久，可选 24 小时 / 1 周 / 1 月 / 1 年 / 不保存。'
      ],
      limit: [
        '选「不保存」会立刻清空已有历史和对应录音，且无法撤销。',
        '录音文件默认只在识别失败时保留，删记录会一并删掉。'
      ],
      fix: ['列表空了但录音其实成功：先看保留期是否被设成 24 小时或「不保存」，再回历史页点刷新重新读取。']
    }
  },
  {
    id: 'guide-providers',
    title: i18n.t('模型配置'),
    points: {
      what: [
        '转写、语言模型、多模态各自维护一串配置链，从上到下依次尝试，前一个失败自动换下一个。'
      ],
      how: [
        '设置 → 模型 → 新建，填 baseUrl、API Key、模型名；同类配置拖成一条链。',
        '「模式」决定这一条走传统还是多模态那串配置。'
      ],
      limit: [
        '最多 40 个配置；链里靠前的失败会先耗掉时间再切换，把最稳的放最前面。',
        '密钥只写在本机设置文件里。'
      ],
      fix: [
        '401：查 Key，或换成 x-api-key 鉴权头。',
        '404：查请求路径与模型名。整条链都失败时看最后一条错误，通常所有配置共用了一个写错的 Key。'
      ]
    }
  },
  {
    id: 'guide-prompts',
    title: i18n.t('提示词卡片'),
    points: {
      what: ['五类卡片：AI 工具、润色、翻译、文档、邮件；每类可以有多张，最终用哪张由「窗口归类」决定。'],
      how: [
        '设置 → 提示词 里按类型建卡片，写清语气、格式和该保留的内容。',
        '打开「自动激活」让系统按前台应用挑卡，再设「主模式 + 主卡片」当兜底。'
      ],
      limit: [
        '关掉自动激活后所有窗口固定用主模式，规则和内置分类表都不参与。',
        '卡片正文留空会回落到内置提示词。'
      ],
      fix: ['结果语气不对：先看该窗口命中哪一类，再检查这一类的卡片是否被停用或内容被清空。']
    }
  },
  {
    id: 'guide-routing',
    title: i18n.t('窗口归类'),
    points: {
      what: ['决定每个前台窗口用哪一类卡片，顺序是：手动规则 → 内置分类表 → 兜底润色。'],
      how: [
        '设置 → 窗口归类 → 新建规则，用关键词或域名匹配「进程名 + 窗口标题」，忽略大小写；域名规则优先于关键词。',
        '要改一类窗口的默认行为，也可以直接动内置分类表那几行。'
      ],
      limit: [
        '同一个窗口只有第一条命中的规则生效。',
        '按标题匹配的规则在改文档名后可能失配。',
        '内置表把 AI 工具与终端归 AI、邮件客户端归邮件、Office 与 Notion 归文档、微信 QQ Slack 归润色。'
      ],
      fix: ['用「测试窗口」输入进程名和标题看会归到哪类，标着「兜底」就说明该给这个窗口补一条规则。']
    }
  },
  {
    id: 'guide-search',
    title: i18n.t('搜索'),
    points: {
      what: ['问答需要联网时先取回网页摘要，再让模型带着来源回答，来源附在答案后面。'],
      how: [
        '设置 → 搜索 → 打开「允许联网检索」，选服务：DuckDuckGo 免密钥、Tavily 与 Brave 填 Key、SearXNG 填实例地址并开启 format=json。',
        '结果条数可调 1–10。'
      ],
      limit: [
        '每个服务商各自保存密钥、地址和条数，切换不会串台。',
        '关掉「先让模型判断是否需要检索」，每次提问都会先检索一次。'
      ],
      fix: ['检索失败会自动退回纯模型回答；SearXNG 报错多半是地址写错或实例没开 JSON 输出。']
    }
  },
  {
    id: 'guide-dictionary',
    title: i18n.t('纠正规则'),
    points: {
      what: ['一份规则表：左边写「识别成什么」，右边写「替换成什么」，润色前后都会用上。'],
      how: [
        '设置 → 纠正规则 里手动加规则，或导入 CSV（一行一词，或「原文,替换」两列）。',
        '「建议」页会把同一处人工改动累计 3 次的收纳进来，采纳后才进规则表。'
      ],
      limit: [
        '上限 500 条，单条最多 64 个字符。',
        '右边留空就是只做提示（hint）：只把词喂给模型、不改动文字；填了内容才会做字面替换。',
        '每条最右边的数字是命中次数：每次转写里出现它的原文就加 1，只做提示的规则按最终文本算。'
      ],
      fix: ['词还是被写错：确认那条是不是 hint。导入没效果就看预览里的重复、超长、超容量数字。']
    }
  },
  {
    id: 'guide-privacy',
    title: i18n.t('隐私与数据'),
    points: {
      what: ['设置、历史、录音和日志默认保存在本机；登录自行部署的服务端并启用同步后，可同步历史与随记。'],
      how: ['设置 → 数据与存储 →「用户数据总目录」可打开设置、历史和日志目录；随记目录在同页单独设置。'],
      limit: [
        '卸载应用不会删除这个目录。',
        '随记的录音一定留在本机（随记 → 数据目录里的 notes/audio）；听写记录默认只保留失败那次的音频，成功的转写只留文本。',
        '音频只在你配置的转写服务上过一遍，密钥也以本机设置文件的形式保存。'
      ],
      fix: ['写入失败会提示目录是否可写，先看磁盘权限再重试；清空历史前先确认保留期。']
    }
  },
  {
    id: 'guide-trouble',
    title: i18n.t('故障排查'),
    points: {
      what: ['按「录音 → 识别 → 润色 → 插入」四段定位，就能判断问题出在配置、网络还是前台应用。'],
      how: [
        '右 Alt 没反应：检查全局按键钩子与缓存键冲突。',
        '有波形没文字：看历史记录里的失败原因，多半是转写配置。',
        '文字插错位置：改用「剪贴板 + Ctrl+V」并打开「粘贴后恢复剪贴板内容」。'
      ],
      limit: ['典型报错只有三类：401（密钥）、404（路径或模型名）、超时（音频太长或网络）。'],
      fix: ['想看真实错误就打开数据目录里的日志文件，按时间戳对上一分钟的那次录音。']
    }
  }
]

/** Shared card shell: lifted surface, hairline border, anchor-friendly margin. */
const cardSx = {
  p: 2,
  borderRadius: '12px',
  bgcolor: 'background.paper',
  border: 1,
  borderColor: 'divider',
  scrollMarginTop: '12px'
} as const

/**
 * The 说明 page.
 *
 * It is reached from the settings sheet (between 搜索 and 关于), so `embedded`
 * drops the page-level padding and the big "说明" heading: the sheet draws both
 * already, and keeping them pushed the first card halfway down the scroll area.
 */
export function GuidePage({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  /**
   * `scrollIntoView` walks up to the shell's scroll container on its own, so the
   * page does not need a ref to it; `block: 'start'` keeps the heading in view.
   */
  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <Box sx={embedded ? { pb: 1 } : { px: 4, py: 4, pb: 6 }}>
      {!embedded && (
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 20, fontWeight: 600, letterSpacing: -0.3 }}>
            {i18n.t('说明')}
          </Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
            {i18n.t('每节都写清四件事：它是什么、怎么设置、有什么限制、出错第一步做什么')}
          </Typography>
        </Box>
      )}

      <Box sx={{ ...cardSx, mt: embedded ? 0 : 2 }}>
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t('目录')}</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
          {SECTIONS.map((section, index) => (
            <Chip
              key={section.id}
              size="small"
              variant="outlined"
              onClick={() => jump(section.id)}
              label={`${index + 1}. ${i18n.t(section.title)}`}
              sx={{
                height: 24,
                fontSize: 11.5,
                color: 'text.secondary',
                borderColor: 'divider',
                bgcolor: 'action.hover',
                '& .MuiChip-label': { px: 1.25 },
                '&:hover': { color: 'text.primary', borderColor: 'text.disabled' }
              }}
            />
          ))}
        </Box>
      </Box>

      <Stack spacing={2} sx={{ mt: 2 }}>
        {SECTIONS.map((section, index) => (
          <Box key={section.id} id={section.id} component="section" sx={cardSx}>
            <Typography sx={{ fontSize: 14.5, fontWeight: 600, letterSpacing: -0.2 }}>
              {index + 1}. {i18n.t(section.title)}
            </Typography>
            <Stack spacing={1.25} sx={{ mt: 1.25 }}>
              {ASPECT_ORDER.map((key) => (
                <Box key={key} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
                  <Box
                    sx={{
                      flex: '0 0 60px',
                      pt: '2px',
                      fontSize: 11,
                      lineHeight: 1.6,
                      textAlign: 'right',
                      color: 'text.disabled'
                    }}
                  >
                    {i18n.t(ASPECT_LABEL[key])}
                  </Box>
                  <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                    {section.points[key].map((line) => (
                      <Typography
                        key={line}
                        sx={{ fontSize: 12.5, lineHeight: 1.65, color: 'text.secondary' }}
                      >
                        {`· ${i18n.t(line)}`}
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  )
}
