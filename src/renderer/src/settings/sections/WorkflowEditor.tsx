import { useEffect, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { MAX_WORKFLOW_NAME, MAX_WORKFLOW_STEPS, normalizeWorkflowName, normalizeWorkflowSteps, removeWorkflowStep, type Workflow, type WorkflowStep, type WorkflowTool } from '@shared/workflow'
import { registerGameModePreparation } from '../gameModePreparation'
import i18n from '../../i18n'

const LABELS: Record<string, string> = {
  get_datetime: '日期与时间', calculate: '计算', get_weather: '天气', web_search: '网页检索', read_webpage: '读取网页',
  list_reminders: '查看待办', create_reminder: '创建提醒', manage_reminder: '管理提醒', create_note: '创建随记', search_notes: '搜索随记',
  search_history: '搜索历史记录', read_clipboard: '读取剪贴板', copy_to_clipboard: '复制到剪贴板', open_page: '打开页面',
  list_events: '查看日程', create_event: '创建日程', manage_event: '管理日程', daily_briefing: '生成简报', speak_text: '朗读文字',
  get_selection: '读取选中', get_active_window: '读取窗口信息', get_disk_space: '磁盘容量', open_application: '打开应用',
  open_folder: '打开文件夹', open_file: '打开文件', open_url: '打开网页', search_files: '搜索文件', search_file_contents: '搜索文件正文',
  search_files_everything: 'Everything 搜索', get_current_folder: '当前文件夹', get_current_page: '当前网页地址', get_system_info: '系统信息',
  get_system_volume: '读取音量', set_system_volume: '设置音量', stop_speaking: '停止朗读', search_file_activity: '搜索最近文件',
  control_note_audio: '随记录音播放', get_prompt_info: '查看提示词信息', note_sync_status: '随记同步状态', control_speech: '朗读控制',
  configure_speech: '朗读设置', briefing_delivery_status: '简报投递状态', send_briefing: '发送简报'
}
const FIELDS: Record<string, string> = { text: '文字', title: '标题', content: '内容', query: '关键词', url: '网页地址', location: '城市',
  expression: '算式', name: '名称', folder: '文件夹', timezone: '时区', offsetDays: '日期偏移', when: '时间范围', language: '语言', limit: '数量上限',
  day: '日期', action: '操作类型', id: '项目 ID', start: '开始时间', end: '结束时间', from: '起始日期', to: '截止日期', enabled: '启用',
  volume: '音量', rate: '语速', speed: '倍速', voice: '声音', muted: '静音', status: '状态', level: '提醒类型', priority: '优先级',
  minutes: '分钟', date: '日期', noteId: '随记 ID', channel: '投递方式', positionMs: '播放位置（毫秒）', recursive: '包含子文件夹',
  extension: '扩展名', type: '类型', sort: '排序', after: '晚于', before: '早于', minBytes: '最小字节数', kind: '范围', freshness: '新鲜度' }
const toolLabel = (name: string): string => LABELS[name] ? i18n.t(LABELS[name]) : name
type Field = { type?: string; enum?: unknown[]; description?: string }

export function WorkflowEditor({ workflow, close, saved }: { workflow: Workflow | null; close(): void; saved(): void }): JSX.Element {
  const [name, setName] = useState(workflow?.name ?? '')
  const [steps, setSteps] = useState<WorkflowStep[]>(() => structuredClone(workflow?.steps ?? [{ tool: 'list_events', label: '', args: {} }]))
  const [tools, setTools] = useState<WorkflowTool[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Raw advanced edits remain separate until Save, so incomplete JSON never replaces valid steps.
  const [advanced, setAdvanced] = useState<Record<number, string>>({})
  useEffect(() => { let active = true; void window.api.workflow.tools().then(value => { if (active) setTools(value) }).catch(error => { if (active) setError(String(error)) }); return () => { active = false } }, [])
  useEffect(() => registerGameModePreparation(async () => false), [])
  const update = (index: number, patch: Partial<WorkflowStep>): void => setSteps(rows => rows.map((row, at) => at === index ? { ...row, ...patch } : row))
  const values = (): WorkflowStep[] => normalizeWorkflowSteps(steps.map((step, index) => {
    if (advanced[index] === undefined) return { ...step, label: step.label || toolLabel(step.tool) }
    const value = JSON.parse(advanced[index])
    if (!value || typeof value !== 'object' || Array.isArray(value) || !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) throw new Error(i18n.t('高级参数必须包含 args 对象'))
    return { tool: step.tool, label: step.label || toolLabel(step.tool), args: value.args, ...(value.when !== undefined ? { when: value.when } : {}), ...(value.otherwise !== undefined ? { otherwise: value.otherwise } : {}) }
  }))
  const save = async (): Promise<void> => {
    setError('')
    try {
      const input = { name: normalizeWorkflowName(name), steps: values() }
      input.steps.forEach((step, index) => {
        const definition = tools.find(tool => tool.name === step.tool)
        for (const key of (definition?.parameters.required ?? []) as string[]) {
          if (step.args[key] === undefined || step.args[key] === '') throw new Error(i18n.t('步骤 {{n}}：请填写 {{field}}', { n: index + 1, field: i18n.t(FIELDS[key] ?? key) }))
        }
      })
      setBusy(true)
      const result = await window.api.workflow.save(input, workflow?.id)
      if (!result) throw new Error(i18n.t('保存失败，请重试'))
      saved()
    } catch (error) { setError(error instanceof SyntaxError ? i18n.t('高级参数不是有效的 JSON，请检查后保存') : String(error).replace(/^Error: /, '')) }
    finally { setBusy(false) }
  }
  return <Dialog open fullWidth maxWidth="md" onClose={() => { if (!busy) close() }}>
    <DialogTitle>{i18n.t(workflow ? '编辑工作流' : '新建工作流')}</DialogTitle>
    <DialogContent dividers><Stack spacing={2}>
      <TextField autoFocus size="small" label={i18n.t('工作流名称')} value={name} disabled={busy} inputProps={{ maxLength: MAX_WORKFLOW_NAME }} onChange={event => setName(event.target.value)} />
      <Typography variant="body2" color="text.secondary">{i18n.t('按顺序执行下列步骤。保存后说“运行”加工作流名称即可使用。')}</Typography>
      {steps.map((step, index) => {
        const definition = tools.find(tool => tool.name === step.tool)
        const properties = (definition?.parameters.properties ?? {}) as Record<string, Field>
        const required = (definition?.parameters.required ?? []) as string[]
        return <Box key={index} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 2 }}><Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between"><Typography fontWeight={600}>{i18n.t('步骤 {{n}}', { n: index + 1 })}</Typography>
            <Button size="small" disabled={busy || steps.length === 1} onClick={() => { try { setSteps(removeWorkflowStep(values(), index)); setAdvanced({}); setError('') } catch (error) { setError(error instanceof SyntaxError ? i18n.t('高级参数不是有效的 JSON，请检查后保存') : String(error).replace(/^Error: /, '')) } }}>{i18n.t('删除步骤')}</Button></Stack>
          <TextField select size="small" label={i18n.t('操作')} value={step.tool} disabled={busy} onChange={event => { update(index, { tool: event.target.value, args: {}, label: '', when: undefined, otherwise: undefined }); setAdvanced(old => { const next = { ...old }; delete next[index]; return next }) }}>
            {!definition && <MenuItem value={step.tool}>{toolLabel(step.tool)}</MenuItem>}
            {tools.map(tool => <MenuItem key={tool.name} value={tool.name}>{toolLabel(tool.name)}</MenuItem>)}
          </TextField>
          <TextField size="small" label={i18n.t('步骤说明')} value={step.label} disabled={busy} placeholder={toolLabel(step.tool)} onChange={event => update(index, { label: event.target.value })} />
          {advanced[index] === undefined && Object.entries(properties).map(([key, field]) => {
            const value = step.args[key]
            // References/objects keep their exact structure in the advanced editor.
            if (value !== null && typeof value === 'object' || field.type === 'object' || field.type === 'array') return null
            const options = field.enum ?? (field.type === 'boolean' ? [true, false] : undefined)
            return <TextField key={key} size="small" label={i18n.t(FIELDS[key] ?? key)} required={required.includes(key)} disabled={busy} select={Boolean(options)}
              multiline={!options && field.type === 'string' && ['text', 'content'].includes(key)} minRows={!options && ['text', 'content'].includes(key) ? 2 : undefined}
              value={value === undefined ? '' : String(value)} helperText={i18n.language === 'en' || /[\u3400-\u9fff]/.test(field.description ?? '') ? field.description : undefined} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
              onChange={event => { const args = { ...step.args }; if (event.target.value === '') delete args[key]; else args[key] = field.type === 'boolean' ? event.target.value === 'true' : field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value; update(index, { args }) }}>
              {options && [<MenuItem key="empty" value="">{i18n.t('默认')}</MenuItem>, ...options.map(option => <MenuItem key={String(option)} value={String(option)}>{typeof option === 'boolean' ? i18n.t(option ? '是' : '否') : String(option)}</MenuItem>)]}
            </TextField>
          })}
          <Button size="small" sx={{ alignSelf: 'flex-start' }} disabled={busy || advanced[index] !== undefined} onClick={() => setAdvanced(old => ({ ...old, [index]: JSON.stringify({ args: step.args, ...(step.when ? { when: step.when } : {}), ...(step.otherwise ? { otherwise: step.otherwise } : {}) }, null, 2) }))}>{i18n.t('高级：参数、条件与结果引用')}</Button>
          {advanced[index] !== undefined && <TextField multiline minRows={4} size="small" label={i18n.t('高级参数 JSON')} value={advanced[index]} disabled={busy} onChange={event => setAdvanced(old => ({ ...old, [index]: event.target.value }))} inputProps={{ style: { fontFamily: 'monospace', fontSize: 12 } }} />}
          {advanced[index] === undefined && (step.when || step.otherwise || Object.values(step.args).some(value => value !== null && typeof value === 'object')) && <Typography variant="caption" color="text.secondary">{i18n.t('此步骤包含条件或结果引用，已保留；可在高级参数中编辑。')}</Typography>}
        </Stack></Box>
      })}
      <Button variant="outlined" disabled={busy || steps.length >= MAX_WORKFLOW_STEPS} onClick={() => setSteps(rows => [...rows, { tool: 'get_datetime', args: {}, label: '' }])}>{i18n.t('添加步骤')}</Button>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack></DialogContent>
    <DialogActions><Button disabled={busy} onClick={close}>{i18n.t('取消')}</Button><Button variant="contained" disabled={busy || !name.trim() || !tools.length} onClick={() => void save()}>{i18n.t(busy ? '保存中…' : '保存')}</Button></DialogActions>
  </Dialog>
}
