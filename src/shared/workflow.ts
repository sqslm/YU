/**
 * The saved-workflow contract shared by the main process, the store and (later)
 * the UI.
 *
 * A workflow is a user-named, ordered list of tool calls for the "every time I
 * do this, it is the same few steps" case. Running one does not involve a model:
 * the steps are replayed verbatim, so what the receipt says happened is what the
 * tools actually did.
 *
 * Everything here is data plus pure helpers: no `fs`, no `electron`, no network.
 * The store lives in `main/workflows.ts`.
 *
 * Two rules worth knowing before editing this file:
 *
 * 1. `run_workflow` is not a legal step. A saved workflow that could call a saved
 *    workflow makes both recursion and an execution-order question appear where
 *    the product only promised "repeat these steps".
 * 2. `replace_selection` is not a legal step either. Rewriting the user's text is
 *    the one action that must stay one-shot with one confirmation, and a replay
 *    would apply it silently minutes later under a different task.
 */
import { mt } from '@shared/mainI18n'

export const MAX_WORKFLOWS = 50
export const MAX_WORKFLOW_STEPS = 8
export const MAX_WORKFLOW_NAME = 40
export const MAX_WORKFLOW_LABEL = 60

/**
 * The tools a step may name.
 *
 * Read-only lookups and tools whose own layer already asks for confirmation
 * before a destructive write. Kept as an explicit allowlist rather than a
 * denylist so a newly added tool cannot become replayable by accident.
 */
export const WORKFLOW_STEP_TOOLS: readonly string[] = [
  'get_datetime',
  'calculate',
  'get_weather',
  'web_search',
  'read_webpage',
  'list_reminders',
  'create_reminder',
  'manage_reminder',
  'create_note',
  'search_notes',
  'search_history',
  'read_clipboard',
  'copy_to_clipboard',
  'open_page',
  'list_events',
  'create_event',
  'manage_event',
  'daily_briefing',
  'speak_text',
  'get_selection',
  'get_active_window',
  'get_disk_space'
  ,'open_application','open_folder','open_file','open_url','search_files','search_file_contents','search_files_everything','get_current_folder','get_current_page',
  'search_file_activity','get_system_info','get_system_volume','set_system_volume','control_note_audio','get_prompt_info','note_sync_status','control_speech','configure_speech','stop_speaking','briefing_delivery_status','send_briefing'
]

export interface WorkflowStep {
  tool: string
  args: Record<string, unknown>
  label: string
  when?: { ref: string; op: 'exists' | 'eq' | 'gt' | 'lt' | 'contains'; value?: unknown }
  otherwise?: { tool: string; args: Record<string, unknown>; label: string }
}

function reference(ref: unknown, prior: number): string[] {
  if(typeof ref!=='string')throw new Error(mt('结果引用必须指定前序步骤与字段'))
  const parts=ref.split('.'), step=Number(parts.shift())
  if(!Number.isInteger(step)||step<1||step>prior||parts.some(key=>!key||['__proto__','prototype','constructor'].includes(key)))throw new Error(mt('结果引用只能访问已完成步骤的字段'))
  return [String(step),...parts]
}

function validateBindings(value: unknown, prior:number, depth=0):void {
  if(depth>16)throw new Error(mt('工作流参数嵌套过深'))
  if(Array.isArray(value)){for(const item of value)validateBindings(item,prior,depth+1)}
  else if(isPlainRecord(value)){
    if(Object.hasOwn(value,'$ref')){if(Object.keys(value).length!==1)throw new Error(mt('结果引用不能混合其他字段'));reference(value.$ref,prior)}
    else for(const item of Object.values(value))validateBindings(item,prior,depth+1)
  }
}

export function workflowValue(ref:string, results:readonly (Record<string,unknown>|undefined)[]):unknown {
  const [step,...parts]=reference(ref,results.length)
  let value:unknown=results[Number(step)-1]
  for(const key of parts){if(typeof value!=='object'||value===null||!Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key]}
  return value
}
export function bindWorkflowArgs(args:Record<string,unknown>,results:readonly (Record<string,unknown>|undefined)[]):Record<string,unknown> {
  const bind=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(bind)
    if(!isPlainRecord(value))return value
    if(Object.hasOwn(value,'$ref')){const found=workflowValue(String(value.$ref),results);if(found===undefined)throw new Error(mt('前序步骤没有该结果字段'));return structuredClone(found)}
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,bind(item)]))
  }
  validateBindings(args,results.length)
  return bind(args) as Record<string,unknown>
}
export function workflowCondition(when:NonNullable<WorkflowStep['when']>,results:readonly (Record<string,unknown>|undefined)[]):boolean {
  const value=workflowValue(when.ref,results)
  if(when.op==='exists')return value!==undefined&&value!==null
  if(when.op==='eq')return JSON.stringify(value)===JSON.stringify(when.value)
  if(when.op==='gt'||when.op==='lt')return typeof value==='number'&&typeof when.value==='number'&&(when.op==='gt'?value>when.value:value<when.value)
  return typeof value==='string'&&typeof when.value==='string'?value.includes(when.value):Array.isArray(value)&&value.some(item=>JSON.stringify(item)===JSON.stringify(when.value))
}

export interface Workflow {
  id: string
  name: string
  steps: WorkflowStep[]
  archivedAt?: number
  runs: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface WorkflowInput {
  name: string
  steps: WorkflowStep[]
}

/** Code points, not UTF-16 units: clipping must never split an emoji in a name. */
function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A name as the list shows it: single-spaced, trimmed, clipped, never empty.
 *
 * The throw is deliberate — an unnamed workflow is unfindable in a list that is
 * ordered by name, so refusing the save is friendlier than storing a blank row.
 */
export function normalizeWorkflowName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!text) throw new Error(mt('请给这个工作流起一个名字'))
  return clip(text, MAX_WORKFLOW_NAME)
}

/**
 * Steps as they will be replayed: allowlisted tools, plain-object args, and a
 * label that is never blank.
 *
 * The input is whatever the model actually emitted, which is not the same thing
 * as what the schema asked for. All of these are accepted because refusing them
 * only teaches the user that saving fails:
 *
 * - an array of `{tool, args, label}` objects (the documented shape)
 * - a JSON string holding that array (models double-encode nested structures)
 * - an array of bare tool names, e.g. `["list_events", "daily_briefing"]`
 * - per-step `args` given as a JSON string, and `arguments` as an alias for `args`
 *
 * A step whose label is empty falls back to the tool name instead of being
 * rejected: the tool name is already the one description the user recognises,
 * and losing a half-configured step helps nobody.
 */
export function normalizeWorkflowSteps(value: unknown): WorkflowStep[] {
  const list = stepList(value)
  if (!list) throw new Error(mt('步骤不是一个列表：请给出按顺序排列的步骤数组'))
  if (list.length === 0) throw new Error(mt('工作流至少要有一个步骤'))
  if (list.length > MAX_WORKFLOW_STEPS) {
    throw new Error(mt('一个工作流最多 {{count}} 步', { count: MAX_WORKFLOW_STEPS }))
  }
  const steps: WorkflowStep[] = []
  for (const raw of list) {
    const item = isPlainRecord(raw) ? raw : {}
    // A bare string is the tool name: "list_events" is unambiguous, and asking
    // the model again for the object shape it just failed to produce wastes a
    // round trip on something we can read ourselves.
    const tool = typeof raw === 'string' ? raw.trim() : typeof item.tool === 'string' ? item.tool.trim() : ''
    if (!tool) throw new Error(mt('有一步没写工具名，请给每一步指定工具'))
    if (!WORKFLOW_STEP_TOOLS.includes(tool)) {
      throw new Error(mt('这一步的工具不在允许范围内：{{tool}}', { tool }))
    }
    const label = clip(typeof item.label === 'string' ? item.label.trim() : '', MAX_WORKFLOW_LABEL) || tool
    // Args are copied so a later edit of the caller's object cannot rewrite a
    // saved workflow behind the store's back.
    const args=stepArgs(item.args ?? item.arguments)
    validateBindings(args,steps.length)
    let when:WorkflowStep['when'], otherwise:WorkflowStep['otherwise']
    if(item.when!==undefined){
      if(!isPlainRecord(item.when)||!['exists','eq','gt','lt','contains'].includes(String(item.when.op)))throw new Error(mt('工作流条件无效'))
      reference(item.when.ref,steps.length)
      when={ref:String(item.when.ref),op:item.when.op as NonNullable<WorkflowStep['when']>['op'],...(Object.hasOwn(item.when,'value')?{value:structuredClone(item.when.value)}:{})}
    }
    if(item.otherwise!==undefined){
      if(!when||!isPlainRecord(item.otherwise)||!WORKFLOW_STEP_TOOLS.includes(String(item.otherwise.tool)))throw new Error(mt('工作流备用分支无效'))
      const args=stepArgs(item.otherwise.args);validateBindings(args,steps.length)
      otherwise={tool:String(item.otherwise.tool),args,label:clip(String(item.otherwise.label||item.otherwise.tool),MAX_WORKFLOW_LABEL)}
    }
    steps.push({ tool, args:structuredClone(args), label, ...(when?{when}:{}),...(otherwise?{otherwise}:{}) })
  }
  return steps
}

/** The step array, from an array or from a JSON string that holds one. */
function stepList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Step args, from a plain object or from a JSON string that holds one. */
function stepArgs(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) return { ...value }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isPlainRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * The workflows the lists show, newest edit first.
 *
 * Archived rows keep their data but must not reappear in a picker, and sorting
 * by `updatedAt` (not creation) is what makes "the one I just amended" the first
 * entry the user sees.
 */
export function activeWorkflows(rows: readonly Workflow[]): Workflow[] {
  return rows
    .filter(row => row.archivedAt === undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

/** One-line summary for a tool receipt and a list row. */
export function describeWorkflow(workflow: Workflow): string {
  return mt('{{count}} 步：{{steps}}', {
    count: workflow.steps.length,
    steps: workflow.steps.map(step => step.tool).join(' → ')
  })
}
