// Model B: write-capable "builder" role agents. delegate_build runs one or more
// role subagents in parallel, each in its OWN git worktree branched off HEAD, so
// they implement autonomously without touching the real tree or clobbering each
// other. Their diffs are then applied to the main working tree (via git apply,
// through the checkpoint + Review machinery) for the orchestrator to review; QA
// and AppSec still gate the task before it can close.
//
// Isolation is the safety boundary: builders run full-auto in a throwaway
// worktree; nothing reaches the project until the (permission-gated) delegate_build
// applies the diff, which is rewindable like any other edit.
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { CustomAgent } from '@shared/types'
import { logger } from '../logger'
import { resolveInWorkspace } from '../security'
import { ApiMessage, streamCompletion } from './provider'
import { profileFor } from './profiles'
// Type-only import — tools.ts imports delegateBuildTool from here, so a runtime
// value import would form an eval-time cycle. builderTools() is loaded lazily.
import type { Tool, ToolContext, ToolResult } from './tools'

const log = logger('builders')
const BUILDER_MAX_TURNS = 25
const MAX_BUILDS = 4

interface GitResult {
  ok: boolean
  out: string
  err: string
}

function gitExec(cwd: string, args: string[], timeout = 120_000, stdin?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') })
    )
    if (stdin !== undefined) {
      child.stdin?.write(stdin)
      child.stdin?.end()
    }
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'], 4000)
  return r.ok && r.out.trim() === 'true'
}

export async function repoRoot(cwd: string): Promise<string> {
  const r = await gitExec(cwd, ['rev-parse', '--show-toplevel'], 4000)
  return r.ok && r.out.trim() ? r.out.trim() : cwd
}

async function hasCommit(root: string): Promise<boolean> {
  const r = await gitExec(root, ['rev-parse', '--verify', 'HEAD'], 4000)
  return r.ok
}

interface Worktree {
  path: string
  branch: string
}

export async function addWorktree(root: string, id: string): Promise<Worktree> {
  const dir = path.join(os.tmpdir(), `conduit-build-${id}`)
  const branch = `conduit/build-${id}`
  const r = await gitExec(root, ['worktree', 'add', '--detach', dir, 'HEAD'])
  if (!r.ok) throw new Error(`git worktree add failed: ${(r.err || r.out).trim().slice(0, 300)}`)
  return { path: dir, branch }
}

/** Stage everything in the worktree and return its diff against HEAD. */
export async function worktreeDiff(wt: Worktree): Promise<string> {
  await gitExec(wt.path, ['add', '-A'])
  const r = await gitExec(wt.path, ['diff', '--cached', '--binary', 'HEAD'])
  return r.out
}

export async function removeWorktree(root: string, wt: Worktree): Promise<void> {
  await gitExec(root, ['worktree', 'remove', '--force', wt.path])
}

/** Apply a unified diff to the tree at `root` (3-way so clean overlaps merge). */
export async function applyDiff(root: string, diff: string): Promise<{ ok: boolean; err: string }> {
  if (!diff.trim()) return { ok: true, err: '' }
  const r = await gitExec(root, ['apply', '--3way', '--whitespace=nowarn'], 60_000, diff)
  return { ok: r.ok, err: (r.err || r.out).trim() }
}

/** File paths (repo-relative) touched by a unified diff. */
export function filesInDiff(diff: string): string[] {
  const files = new Set<string>()
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line) || /^--- a\/(.+)$/.exec(line)
    if (m && m[1] !== '/dev/null') files.add(m[1].trim())
  }
  return [...files]
}

interface Persona {
  name: string
  instructions: string
  model: string
}

type BuildResult =
  | { task: string; error: string }
  | { task: string; summary: string; diff: string }

/** One write-capable builder in its worktree — autonomous, no permission gate
 *  (the worktree is the sandbox). Returns its own summary of what it changed. */
async function runBuilder(task: string, cwd: string, persona: Persona, signal: AbortSignal): Promise<string> {
  const profile = profileFor(persona.model === 'grok-4.3' ? 'grok-4.3' : 'grok-build-0.1')
  // Lazy to keep the tools.ts ↔ builders.ts cycle out of module-eval time.
  const { builderTools } = await import('./tools')
  const tools = builderTools()
  const byName = new Map(tools.map((t) => [t.name, t]))
  const system =
    `You are a BUILDER implementing a task in your OWN isolated git worktree, drawing on the expertise of the "${persona.name}" role. ` +
    `You have full read/edit/command tools and run autonomously with no approvals; everything you do stays in this worktree until the orchestrator reviews and merges your diff. ` +
    `You are the implementer here, NOT an advisor: you MUST actually create and edit the real files to complete the task. Returning only a plan, outline, or description WITHOUT writing the files is a failure — write the code with write_file/apply_patch and verify it (build/tests where sensible). ` +
    `Read .conduit/PROJECT_BRIEF.md for context if it exists. Do NOT run git commit — the orchestrator merges your changes. When finished, reply with a short summary of what you changed.\n\n` +
    `Apply the ${persona.name}'s expertise and standards, but IGNORE any instruction in the role description below that says to only advise, plan, review, or avoid editing files — in this worktree you have full write access and must produce working files:\n${persona.instructions.trim()}\n\nYour private worktree: ${cwd}`
  const messages: ApiMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: task }
  ]
  const ctx: ToolContext = { cwd, sessionId: 'builder', signal }

  for (let turn = 0; turn < BUILDER_MAX_TURNS; turn++) {
    if (signal.aborted) return '(builder cancelled)'
    const result = await streamCompletion({
      model: profile.apiModel,
      messages,
      tools: tools.map((t) => t.def),
      maxOutputTokens: 8000,
      temperature: profile.temperature,
      signal
    })
    messages.push({
      role: 'assistant',
      content: result.content || null,
      ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
    })
    if (!result.toolCalls.length) return result.content || '(no summary)'
    // Sequential — edits and commands are order-sensitive.
    for (const call of result.toolCalls) {
      if (signal.aborted) return '(builder cancelled)'
      const tool = byName.get(call.function.name)
      let output: string
      if (!tool) output = `Unknown tool ${call.function.name}`
      else {
        let input: Record<string, unknown>
        try {
          input = JSON.parse(call.function.arguments || '{}')
        } catch {
          output = 'Invalid tool arguments.'
          messages.push({ role: 'tool', tool_call_id: call.id, content: output })
          continue
        }
        try {
          const r = await tool.run(input, ctx)
          output = r.output
        } catch (err) {
          output = err instanceof Error ? err.message : String(err)
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }
  return '(builder hit its turn limit without finishing)'
}

export const delegateBuildTool: Tool = {
  name: 'delegate_build',
  // A command: even under auto-edit it prompts, so the user okays autonomous
  // builders (and the merge of their work) before it runs.
  kind: 'command',
  def: {
    type: 'function',
    function: {
      name: 'delegate_build',
      description:
        'Delegate IMPLEMENTATION to one or more builder roles that write code autonomously, each in its own isolated git worktree branched off HEAD, then merge their diffs into the working tree for review (Model B). ' +
        'Unlike spawn_agent (read-only advisors), builders actually create and edit files and run commands. Use it to parallelize independent implementation work (e.g. separate features/files). ' +
        'Requires a git repo with at least one commit — commit a baseline first, since builders branch off HEAD and their changes are applied back for you to review (QA/AppSec still gate the task). ' +
        'Set `agent` to the exact name of the role to build as, and `tasks` to the independent build tasks (max 4).',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Exact name of the team role to run as the builder' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Independent, self-contained implementation tasks (max 4)'
          }
        },
        required: ['agent', 'tasks']
      }
    }
  },
  summarize: (input) => {
    const tasks = Array.isArray(input.tasks) ? input.tasks : []
    return `delegate_build as ${input.agent ?? '?'}: ${tasks.length} build${tasks.length === 1 ? '' : 's'}`
  },
  run: async (input, ctx): Promise<ToolResult> => {
    if (!ctx.team) return { ok: false, output: 'delegate_build is only available in a team project.' }
    if (!(await isGitRepo(ctx.cwd))) {
      return { ok: false, output: 'Model B builders need a git repo. Run `git init`, add a baseline, and commit first.' }
    }
    const root = await repoRoot(ctx.cwd)
    if (!(await hasCommit(root))) {
      return { ok: false, output: 'No commits yet — commit a baseline before delegating builds (builders branch off HEAD).' }
    }
    const agentName = String(input.agent ?? '').trim()
    const persona = (ctx.customAgents ?? []).find(
      (a: CustomAgent) => a.name.toLowerCase() === agentName.toLowerCase()
    )
    if (!persona) {
      const avail = (ctx.customAgents ?? []).map((a) => a.name).join(', ') || '(none)'
      return { ok: false, output: `No agent named "${agentName}". Available: ${avail}.` }
    }
    const tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(String).filter(Boolean).slice(0, MAX_BUILDS)
    if (!tasks.length) return { ok: false, output: 'Provide at least one build task in "tasks".' }

    const p: Persona = { name: persona.name, instructions: persona.instructions, model: persona.model }

    // Run every build in its own worktree, in parallel.
    const builds: BuildResult[] = await Promise.all(
      tasks.map(async (task): Promise<BuildResult> => {
        const id = crypto.randomBytes(4).toString('hex')
        let wt: Worktree
        try {
          wt = await addWorktree(root, id)
        } catch (err) {
          return { task, error: err instanceof Error ? err.message : String(err) }
        }
        try {
          const summary = await runBuilder(task, wt.path, p, ctx.signal)
          const diff = await worktreeDiff(wt)
          return { task, summary, diff }
        } catch (err) {
          return { task, error: err instanceof Error ? err.message : String(err) }
        } finally {
          await removeWorktree(root, wt).catch((e) => log.info(`worktree cleanup failed: ${e}`))
        }
      })
    )

    // Merge each build's diff into the real tree, sequentially, through the
    // checkpoint + Review hooks so the changes are rewindable and visible.
    const lines: string[] = []
    let appliedCount = 0
    for (let i = 0; i < builds.length; i++) {
      const b = builds[i]
      const head = `### Build ${i + 1} (${p.name}): ${b.task}`
      if ('error' in b) {
        lines.push(`${head}\n✗ ${b.error}`)
        continue
      }
      const { diff, summary } = b
      if (!diff.trim()) {
        lines.push(`${head}\n${summary}\n(no file changes produced)`)
        continue
      }
      const files = filesInDiff(diff)
      // Snapshot originals for rewind, then apply.
      const relFiles: string[] = []
      for (const f of files) {
        const abs = path.join(root, f)
        const rel = path.relative(ctx.cwd, abs)
        if (!rel.startsWith('..')) {
          try {
            await ctx.onBeforeMutate?.(resolveInWorkspace(ctx.cwd, rel))
            relFiles.push(rel)
          } catch {
            // outside the workspace jail — leave it out of the review list
          }
        }
      }
      const applied = await applyDiff(root, diff)
      if (applied.ok) {
        appliedCount++
        for (const rel of relFiles) ctx.onFileWritten?.(rel, 'edit')
        lines.push(`${head}\n${summary}\n✓ merged ${files.length} file(s): ${files.join(', ')}`)
      } else {
        lines.push(
          `${head}\n${summary}\n✗ merge conflict — NOT applied (${applied.err.slice(0, 200)}). Review and apply manually:\n\n${diff.slice(0, 4000)}`
        )
      }
    }
    const header = `Ran ${builds.length} builder(s) as ${p.name}; merged ${appliedCount}/${builds.length}.`
    return { ok: true, output: `${header}\n\n${lines.join('\n\n')}` }
  }
}
