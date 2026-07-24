// Team-project orchestration tools: a shared task board and project brief the
// orchestrator (CEO) uses to run a team of role agents. The QA/AppSec review
// gate is enforced HERE (in code), so a task cannot be closed until every
// required reviewer role has recorded a pass — the model can't skip it.
//
// Board logic is kept as small pure functions so the gate is unit-testable
// without the agent loop. The tools read/write the session's TeamState through
// ctx.team (mirrors how update_plan mutates session state via ctx.onPlan).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TeamState, TeamTask, TeamTaskReview, TeamTaskStatus } from '@shared/types'
import { resolveInWorkspace } from '../security'
import { Tool, ToolResult } from './tools'

const STATUSES: TeamTaskStatus[] = ['todo', 'in-progress', 'review', 'blocked', 'done']
const BRIEF_REL = path.join('.conduit', 'PROJECT_BRIEF.md')
const MAX_TASKS = 200

function id(): string {
  return crypto.randomBytes(6).toString('hex')
}

/** Latest review a given role recorded for a task (case-insensitive), if any. */
function latestReviewBy(task: TeamTask, role: string): TeamTaskReview | undefined {
  const matches = task.reviews.filter((r) => r.role.toLowerCase() === role.toLowerCase())
  return matches[matches.length - 1]
}

/**
 * Reasons a task cannot close: for each required reviewer role, the latest
 * review must be a pass. Returns [] when the task is clear to close.
 */
export function gateBlockers(task: TeamTask, reviewGates: string[]): string[] {
  if (task.requiresReview === false) return []
  const blockers: string[] = []
  for (const role of reviewGates) {
    const latest = latestReviewBy(task, role)
    if (!latest) blockers.push(`${role}: no review yet`)
    else if (latest.verdict !== 'pass') blockers.push(`${role}: last review failed`)
  }
  return blockers
}

function boardSummary(state: TeamState, gates: string[]): string {
  if (!state.tasks.length) return 'The board is empty. Create tasks with team_task action="create".'
  const byStatus = new Map<TeamTaskStatus, TeamTask[]>()
  for (const s of STATUSES) byStatus.set(s, [])
  for (const t of state.tasks) byStatus.get(t.status)?.push(t)
  const lines: string[] = []
  for (const s of STATUSES) {
    const tasks = byStatus.get(s) ?? []
    if (!tasks.length) continue
    lines.push(`${s.toUpperCase()} (${tasks.length}):`)
    for (const t of tasks) {
      const who = t.assignee ? ` @${t.assignee}` : ''
      const gate =
        t.status !== 'done' && gateBlockers(t, gates).length
          ? ` [needs: ${gateBlockers(t, gates).join(', ')}]`
          : ''
      lines.push(`  · ${t.id} ${t.title}${who}${gate}`)
    }
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------- team_task

export const teamTaskTool: Tool = {
  name: 'team_task',
  kind: 'read', // board bookkeeping — no file mutation, no permission gate
  def: {
    type: 'function',
    function: {
      name: 'team_task',
      description:
        'Manage the team task board (orchestrator only). Actions: ' +
        '"create" — add a task (title, optional description/assignee role); ' +
        '"list" — show the whole board with statuses and review gates; ' +
        '"update" — change a task\'s status/assignee/title/description by id; ' +
        '"review" — record a reviewer role\'s verdict for a task (role, verdict pass|fail, optional notes); ' +
        '"close" — mark a task done, REFUSED until every required review role has passed. ' +
        'Assign implementation tasks to a member role and delegate them with spawn_agent; QA and AppSec must review and pass before you can close a task.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'update', 'review', 'close'] },
          id: { type: 'string', description: 'Task id (update/review/close)' },
          title: { type: 'string', description: 'Task title (create; optional rename on update)' },
          description: { type: 'string', description: 'Task detail (create/update)' },
          assignee: { type: 'string', description: 'Role name to own the task (create/update)' },
          status: {
            type: 'string',
            enum: STATUSES,
            description: 'New status (update). Use "close" action to finish a gated task.'
          },
          requiresReview: {
            type: 'boolean',
            description: 'Whether the review gate applies (create). Defaults true; set false for review/meta tasks.'
          },
          role: { type: 'string', description: 'Reviewer role (review) — must match a gate role to satisfy it' },
          verdict: { type: 'string', enum: ['pass', 'fail'], description: 'Review verdict (review)' },
          notes: { type: 'string', description: 'Review notes (review)' }
        },
        required: ['action']
      }
    }
  },
  summarize: (input) => {
    const a = String(input.action ?? '')
    if (a === 'create') return `team_task create: ${String(input.title ?? '').slice(0, 50)}`
    if (a === 'review') return `team_task review ${input.id ?? ''}: ${input.role ?? ''} ${input.verdict ?? ''}`
    if (a === 'list') return 'team_task list'
    return `team_task ${a} ${input.id ?? ''}`
  },
  run: async (input, ctx): Promise<ToolResult> => {
    if (!ctx.team) {
      return { ok: false, output: 'team_task is only available in a team-project session.' }
    }
    const gates = ctx.team.config.reviewGates
    const action = String(input.action ?? '')
    const state: TeamState = ctx.team.getState()
    const tasks = state.tasks.map((t) => ({ ...t, reviews: [...t.reviews] }))
    const now = Date.now()

    if (action === 'list') {
      return { ok: true, output: boardSummary({ ...state, tasks }, gates) }
    }

    if (action === 'create') {
      const title = String(input.title ?? '').trim().slice(0, 200)
      if (!title) return { ok: false, output: 'A task needs a title.' }
      if (tasks.length >= MAX_TASKS) return { ok: false, output: `Board is full (${MAX_TASKS} tasks).` }
      const task: TeamTask = {
        id: id(),
        title,
        description: String(input.description ?? '').trim().slice(0, 2000) || undefined,
        assignee: String(input.assignee ?? '').trim().slice(0, 80) || undefined,
        status: 'todo',
        requiresReview: input.requiresReview !== false,
        reviews: [],
        createdAt: now,
        updatedAt: now
      }
      tasks.push(task)
      ctx.team.setState({ ...state, tasks })
      return { ok: true, output: `Created task ${task.id}: ${task.title}${task.assignee ? ` (@${task.assignee})` : ''}.` }
    }

    // Remaining actions target a specific task.
    const taskId = String(input.id ?? '').trim()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return { ok: false, output: `No task with id "${taskId}". Use action="list" to see ids.` }

    if (action === 'update') {
      if (typeof input.title === 'string' && input.title.trim()) task.title = input.title.trim().slice(0, 200)
      if (typeof input.description === 'string') task.description = input.description.trim().slice(0, 2000) || undefined
      if (typeof input.assignee === 'string') task.assignee = input.assignee.trim().slice(0, 80) || undefined
      if (typeof input.status === 'string') {
        if (!STATUSES.includes(input.status as TeamTaskStatus)) {
          return { ok: false, output: `Invalid status. Use one of: ${STATUSES.join(', ')}.` }
        }
        if (input.status === 'done') {
          return { ok: false, output: 'Use action="close" to finish a task so the review gate is checked.' }
        }
        task.status = input.status as TeamTaskStatus
      }
      task.updatedAt = now
      ctx.team.setState({ ...state, tasks })
      return { ok: true, output: `Updated ${task.id} (${task.status}${task.assignee ? `, @${task.assignee}` : ''}).` }
    }

    if (action === 'review') {
      const role = String(input.role ?? '').trim().slice(0, 80)
      const verdict = input.verdict === 'pass' ? 'pass' : input.verdict === 'fail' ? 'fail' : null
      if (!role) return { ok: false, output: 'A review needs the reviewer "role".' }
      if (!verdict) return { ok: false, output: 'A review needs "verdict": "pass" or "fail".' }
      task.reviews.push({ role, verdict, notes: String(input.notes ?? '').trim().slice(0, 1000) || undefined, at: now })
      // A failed review sends the task back for rework; a pass moves it to review.
      task.status = verdict === 'fail' ? 'blocked' : task.status === 'todo' ? 'review' : task.status
      task.updatedAt = now
      ctx.team.setState({ ...state, tasks })
      const remaining = gateBlockers(task, gates)
      const tail = remaining.length ? ` Still needed to close: ${remaining.join(', ')}.` : ' All review gates pass — ready to close.'
      return { ok: true, output: `Recorded ${role} → ${verdict} on ${task.id}.${tail}` }
    }

    if (action === 'close') {
      const blockers = gateBlockers(task, gates)
      if (blockers.length) {
        return {
          ok: false,
          output: `Cannot close ${task.id} — review gate not satisfied: ${blockers.join(', ')}. Delegate the review(s) and record a passing verdict first.`
        }
      }
      task.status = 'done'
      task.updatedAt = now
      ctx.team.setState({ ...state, tasks })
      return { ok: true, output: `Closed ${task.id}: ${task.title}.` }
    }

    return { ok: false, output: `Unknown action "${action}". Use create, list, update, review, or close.` }
  }
}

// --------------------------------------------------------------- project_brief

export const projectBriefTool: Tool = {
  name: 'project_brief',
  kind: 'read', // maintains the team's own brief doc — bookkeeping, not a code edit
  def: {
    type: 'function',
    function: {
      name: 'project_brief',
      description:
        'Read or update the shared PROJECT BRIEF for a team project (orchestrator only) — the single source of truth all roles read: scope, features, tech stack, architecture decisions, and current status. ' +
        'Actions: "get" returns the brief; "set" replaces it with new markdown. Keep it current as scope and decisions evolve; delegated roles are told to read it. It is saved to .conduit/PROJECT_BRIEF.md.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'] },
          content: { type: 'string', description: 'Full markdown brief (set)' }
        },
        required: ['action']
      }
    }
  },
  summarize: (input) => `project_brief ${String(input.action ?? '')}`,
  run: async (input, ctx): Promise<ToolResult> => {
    if (!ctx.team) {
      return { ok: false, output: 'project_brief is only available in a team-project session.' }
    }
    const state = ctx.team.getState()
    const action = String(input.action ?? '')

    if (action === 'get') {
      return { ok: true, output: state.brief.trim() || '(The project brief is empty. Set it with action="set".)' }
    }
    if (action === 'set') {
      const content = String(input.content ?? '').slice(0, 40_000)
      ctx.team.setState({ ...state, brief: content })
      // Mirror to a workspace file so read-only role subagents can read it.
      try {
        const abs = resolveInWorkspace(ctx.cwd, BRIEF_REL)
        await ctx.onBeforeMutate?.(abs)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf8')
      } catch {
        // The in-session brief still updated even if the file write failed.
      }
      return { ok: true, output: `Project brief updated (${content.length} chars), saved to ${BRIEF_REL}.` }
    }
    return { ok: false, output: `Unknown action "${action}". Use get or set.` }
  }
}
