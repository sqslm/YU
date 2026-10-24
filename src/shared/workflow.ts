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
]

export interface WorkflowStep {
  tool: string
  args: Record<string, unknown>
  label: string
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
 * A step whose label is empty falls back to the tool name instead of being
 * rejected: the tool name is already the one description the user recognises,
 * and losing a half-configured step helps nobody.
 */
export function normalizeWorkflowSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(mt('工作流至少要有一个步骤'))
  if (value.length > MAX_WORKFLOW_STEPS) {
    throw new Error(mt('一个工作流最多 {{count}} 步', { count: MAX_WORKFLOW_STEPS }))
  }
  const steps: WorkflowStep[] = []
  for (const raw of value) {
    const item = isPlainRecord(raw) ? raw : {}
    const tool = typeof item.tool === 'string' ? item.tool.trim() : ''
    if (!WORKFLOW_STEP_TOOLS.includes(tool)) {
      throw new Error(mt('这一步的工具不在允许范围内：{{tool}}', { tool }))
    }
    const label = clip(typeof item.label === 'string' ? item.label.trim() : '', MAX_WORKFLOW_LABEL) || tool
    // Args are copied so a later edit of the caller's object cannot rewrite a
    // saved workflow behind the store's back.
    steps.push({ tool, args: isPlainRecord(item.args) ? { ...item.args } : {}, label })
  }
  return steps
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
