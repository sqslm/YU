import type { WorkflowTool } from './workflow'
const GROUPS: Array<{ name: string; tools: string[] }> = [
  { name: '日程与提醒', tools: ['list_events', 'create_event', 'manage_event', 'list_reminders', 'create_reminder', 'manage_reminder', 'daily_briefing', 'send_briefing', 'briefing_delivery_status'] },
  { name: '随记与历史', tools: ['create_note', 'search_notes', 'search_history', 'control_note_audio', 'note_sync_status'] },
  { name: '搜索与网页', tools: ['web_search', 'read_webpage', 'open_url', 'get_current_page'] },
  { name: '文件与应用', tools: ['open_application', 'open_folder', 'open_file', 'search_files', 'search_file_contents', 'search_files_everything', 'search_file_activity', 'get_current_folder', 'get_disk_space'] },
  { name: '朗读与音量', tools: ['speak_text', 'stop_speaking', 'control_speech', 'configure_speech', 'get_system_volume', 'set_system_volume'] },
  { name: '窗口与剪贴板', tools: ['get_active_window', 'get_selection', 'read_clipboard', 'copy_to_clipboard', 'open_page', 'get_system_info', 'get_prompt_info'] },
  { name: '时间、天气与计算', tools: ['get_datetime', 'get_weather', 'calculate'] }
]
export function workflowToolGroups(tools: WorkflowTool[]): Array<{ name: string; tools: WorkflowTool[] }> {
  const groups = GROUPS.map(group => ({ name: group.name, tools: tools.filter(tool => group.tools.includes(tool.name)) }))
  const known = new Set(GROUPS.flatMap(group => group.tools)), other = tools.filter(tool => !known.has(tool.name))
  return [...groups, { name: '其他操作', tools: other }].filter(group => group.tools.length > 0)
}
