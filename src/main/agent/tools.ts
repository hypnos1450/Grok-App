// Agent tool implementations. Dependency-free: bash via child_process,
// search via a bounded recursive walk.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PlanStep } from '@shared/types'
import { ApiToolDef } from './provider'
import { newFilePreview, unifiedDiff } from './diff'
import { parsePatch, applyHunks, PatchError } from './apply-patch'
import { MemoryTarget, memoryStore } from './memory'
import { skillStore } from './skills'
import { spawnAgentTool } from './subagent'
import { sessionStore } from '../sessions'
import { assertPublicUrl, resolveInWorkspace } from '../security'

// 'memory' mutates only the agent's own memory store — never the user's
// files or shell — so it runs without a permission prompt, like reads.
export type ToolKind = 'read' | 'write' | 'command' | 'memory'

export interface ToolContext {
  cwd: string
  sessionId: string
  signal: AbortSignal
  /** Called with the absolute path before a file tool mutates it (checkpoints) */
  onBeforeMutate?: (absPath: string) => Promise<void>
  /** Called when the agent publishes a plan via update_plan */
  onPlan?: (steps: PlanStep[]) => void
  /** Pause and ask the user a question; resolves with their answer ('' if declined). */
  askUser?: (question: string, options?: string[]) => Promise<string>
}

export interface ToolResult {
  ok: boolean
  output: string
}

export interface Tool {
  name: string
  kind: ToolKind
  def: ApiToolDef
  /** One-line human summary for the permission prompt / tool card */
  summarize(input: Record<string, unknown>): string
  /** Optional diff/content preview computed before execution */
  preview?(input: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined>
  /** For kind 'memory': whether this particular call is a write (reads skip approval) */
  requiresApproval?(input: Record<string, unknown>): boolean
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

const MAX_TOOL_OUTPUT = 30_000
const MAX_READ_BYTES = 256 * 1024
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release', '.next', '.venv',
  'venv', '__pycache__', 'target', '.cache', 'coverage'
])

function clamp(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.floor(limit * 0.8))
  const tail = text.slice(-Math.floor(limit * 0.15))
  return `${head}\n… [${text.length - limit} chars truncated] …\n${tail}`
}

/** Workspace-jailed path resolve (absolute/`..`/symlink escape rejected). */
function resolveInCwd(cwd: string, p: string): string {
  return resolveInWorkspace(cwd, p)
}

function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key]
  if (typeof v === 'string' && v.length > 0) return v
  if (required) throw new Error(`Missing required parameter "${key}"`)
  return ''
}

// ---------------------------------------------------------------- bash

// Hard guardrail: patterns that are almost never intended and are
// catastrophic. This is a backstop, NOT the security boundary — the
// permission prompt is. It blocks a confused model from a whole-disk wipe even
// under full-auto.
const DANGEROUS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b[^\n|]*\s(\/|~|\$HOME|\.)\s*($|\s)/i, why: 'recursive force-delete of a root/home path' },
  { re: /\brm\s+-rf\s+\/(\s|$)/i, why: 'rm -rf /' },
  { re: /\b(mkfs|fdisk|:\(\)\s*\{)/i, why: 'disk format or fork bomb' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(disk|sd|nvme|rdisk)/i, why: 'raw write to a disk device' },
  { re: />\s*\/dev\/(sd|disk|nvme|rdisk)/i, why: 'redirect into a disk device' },
  { re: /\bgit\s+push\b[^\n]*--force[^\n]*\b(origin\s+)?(main|master)\b/i, why: 'force-push to a primary branch' }
]

function dangerousCommand(command: string): string | null {
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(command)) return why
  }
  return null
}

const bashTool: Tool = {
  name: 'bash',
  kind: 'command',
  def: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a shell command in the workspace. Returns stdout and stderr. ' +
        'Use for builds, tests, git, package managers, and anything without a dedicated tool. ' +
        'Prefer the dedicated file tools for reading and editing files.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          timeout_seconds: {
            type: 'number',
            description: 'Max runtime in seconds (default 120, max 600)'
          }
        },
        required: ['command']
      }
    }
  },
  summarize: (input) => String(input.command ?? ''),
  run: (input, ctx) =>
    new Promise((resolve) => {
      const command = str(input, 'command')
      const danger = dangerousCommand(command)
      if (danger) {
        resolve({
          ok: false,
          output: `Refused: this command looks destructive (${danger}). If you really intend it, ask the user to run it themselves.`
        })
        return
      }
      const timeoutS = Math.min(Number(input.timeout_seconds) || 120, 600)
      const [shellBin, shellArgs] = shellInvocation(command)
      const child = spawn(shellBin, shellArgs, {
        cwd: ctx.cwd,
        env: commandEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let out = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutS * 1000)
      const onAbort = (): void => {
        child.kill('SIGKILL')
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, output: `Failed to start command: ${err.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const suffix = timedOut
          ? `\n[command timed out after ${timeoutS}s]`
          : code !== 0
            ? `\n[exit code ${code}]`
            : ''
        resolve({ ok: code === 0 && !timedOut, output: clamp(out) + suffix || '(no output)' })
      })
    })
}

/** Shell binary + args for a command, per platform. */
function shellInvocation(command: string): [string, string[]] {
  return process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/zsh', ['-lc', command]]
}

/** Env for spawned commands: inherit, but drop common credential vars so a
 *  confused model can't dump tokens via `env`/`printenv`. */
function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLICOLOR: '0', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' }
  for (const k of Object.keys(env)) {
    if (/^(XAI_|OPENAI_|ANTHROPIC_|AWS_|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|API_KEY|.*_API_KEY|.*_SECRET|.*_TOKEN)$/i.test(k)) {
      delete env[k]
    }
  }
  return env
}

// ---------------------------------------------------------------- monitor

const monitorTool: Tool = {
  name: 'monitor',
  kind: 'command',
  def: {
    type: 'function',
    function: {
      name: 'monitor',
      description:
        'Run a long-running command and watch its output until a condition is met — a dev server booting, ' +
        'CI/tests finishing, or a log line appearing. Returns the collected output and why it stopped. ' +
        'Set `until` to a regular expression to stop as soon as a matching line appears (e.g. "listening on|Compiled|FAIL"). ' +
        'Without `until`, it watches until the command exits or the timeout is reached. ' +
        'Use this instead of bash when you need to wait for something to happen in a process that keeps running.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run and watch' },
          until: {
            type: 'string',
            description: 'Regex; stop as soon as an output line matches it. Omit to watch until the command exits.'
          },
          timeout_seconds: { type: 'number', description: 'Max watch time in seconds (default 120, max 600)' }
        },
        required: ['command']
      }
    }
  },
  summarize: (input) =>
    `monitor: ${String(input.command ?? '')}${input.until ? ` (until /${input.until}/)` : ''}`,
  run: (input, ctx) =>
    new Promise((resolve) => {
      const command = str(input, 'command')
      const danger = dangerousCommand(command)
      if (danger) {
        resolve({ ok: false, output: `Refused: this command looks destructive (${danger}).` })
        return
      }
      let until: RegExp | null = null
      if (typeof input.until === 'string' && input.until) {
        try {
          until = new RegExp(input.until)
        } catch (e) {
          resolve({ ok: false, output: `Invalid \`until\` regex: ${e instanceof Error ? e.message : String(e)}` })
          return
        }
      }
      const timeoutS = Math.min(Number(input.timeout_seconds) || 120, 600)
      const [bin, args] = shellInvocation(command)
      const child = spawn(bin, args, { cwd: ctx.cwd, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })

      let out = ''
      let pending = '' // partial line buffer for `until` matching
      let stop: string | null = null
      const finish = (ok: boolean, reason: string): void => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        if (!child.killed) child.kill('SIGKILL')
        resolve({ ok, output: `${clamp(out).trim() || '(no output)'}\n[${reason}]` })
      }
      const onData = (d: Buffer): void => {
        const s = d.toString('utf8')
        out += s
        if (!until || stop) return
        pending += s
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (until.test(line)) {
            stop = line
            finish(true, `matched /${input.until}/ on: ${line.trim().slice(0, 200)}`)
            return
          }
        }
      }
      const timer = setTimeout(
        () => finish(!until, until ? `timed out after ${timeoutS}s before /${input.until}/ matched — still running` : `watched ${timeoutS}s`),
        timeoutS * 1000
      )
      const onAbort = (): void => finish(false, 'cancelled')
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (err) => finish(false, `failed to start: ${err.message}`))
      child.on('close', (code) => {
        if (stop) return // already resolved on match
        finish(code === 0, `command exited with code ${code}`)
      })
    })
}

// -------------------------------------------------------------- diagnostics

/** Detect the project's check commands from package.json scripts / tsconfig. */
async function detectChecks(cwd: string): Promise<string[]> {
  const cmds: string[] = []
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(cwd, 'package.json'), 'utf8'))
    const scripts: Record<string, unknown> = pkg?.scripts ?? {}
    for (const name of ['typecheck', 'type-check', 'tsc', 'lint', 'check']) {
      if (typeof scripts[name] === 'string') cmds.push(`npm run ${name}`)
    }
  } catch {
    // no package.json — fall through to tsconfig detection
  }
  if (!cmds.some((c) => /typecheck|type-check|tsc/.test(c)) && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    cmds.push('npx tsc --noEmit')
  }
  return cmds
}

/** Run a shell command to completion, collecting output (used by diagnostics). */
function runShell(command: string, cwd: string, signal: AbortSignal, timeoutS: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const [bin, args] = shellInvocation(command)
    const child = spawn(bin, args, { cwd, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutS * 1000)
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `Failed to start: ${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ ok: code === 0 && !timedOut, output: clamp(out).trim() + (timedOut ? `\n[timed out after ${timeoutS}s]` : '') })
    })
  })
}

const diagnosticsTool: Tool = {
  name: 'diagnostics',
  kind: 'command',
  def: {
    type: 'function',
    function: {
      name: 'diagnostics',
      description:
        "Run the project's type-checker and linter and report the errors and warnings — the fast way to surface type errors and lint issues after editing, before declaring work done. Auto-detects the check command from package.json scripts (typecheck, lint) or a tsconfig; pass `command` to run a specific one. Prefer this over a raw bash typecheck so results come back focused.",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Optional: a specific check command to run instead of auto-detecting'
          }
        }
      }
    }
  },
  summarize: (input) => (input.command ? `diagnostics: ${input.command}` : 'diagnostics (auto-detect)'),
  run: async (input, ctx) => {
    let cmds: string[]
    if (typeof input.command === 'string' && input.command.trim()) {
      cmds = [input.command.trim()]
    } else {
      cmds = await detectChecks(ctx.cwd)
      if (cmds.length === 0) {
        return {
          ok: false,
          output:
            'No type-check or lint command detected (no package.json typecheck/lint script and no tsconfig.json). Pass `command` with your project’s check command.'
        }
      }
    }
    const parts: string[] = []
    let allOk = true
    for (const cmd of cmds) {
      const r = await runShell(cmd, ctx.cwd, ctx.signal, 300)
      allOk = allOk && r.ok
      parts.push(`$ ${cmd}\n${r.output || '(no output)'}${r.ok ? '\n[ok]' : ''}`)
    }
    return { ok: allOk, output: clamp(parts.join('\n\n')) }
  }
}

// ---------------------------------------------------------------- read_file

const readFileTool: Tool = {
  name: 'read_file',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file. Returns content with line numbers. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace (absolute paths outside the workspace are rejected)' },
          offset: { type: 'number', description: '1-based line to start from' },
          limit: { type: 'number', description: 'Max lines to return (default 1500)' }
        },
        required: ['path']
      }
    }
  },
  summarize: (input) => `Read ${input.path}`,
  run: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, 'path'))
    const stat = await fsp.stat(file)
    if (stat.isDirectory()) return { ok: false, output: `${file} is a directory` }
    if (stat.size > 8 * 1024 * 1024) {
      return { ok: false, output: `File is ${stat.size} bytes — too large. Use bash (head/tail/grep) instead.` }
    }
    const raw = await fsp.readFile(file)
    const text = raw.subarray(0, MAX_READ_BYTES).toString('utf8')
    const lines = text.split('\n')
    const offset = Math.max(1, Number(input.offset) || 1)
    const limit = Math.min(Number(input.limit) || 1500, 3000)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}→${l}`).join('\n')
    const more =
      offset - 1 + limit < lines.length
        ? `\n… ${lines.length - (offset - 1 + limit)} more lines (${lines.length} total)`
        : ''
    const truncNote = raw.length > MAX_READ_BYTES ? '\n[file truncated at 256KB]' : ''
    return { ok: true, output: clamp(numbered) + more + truncNote }
  }
}

// ---------------------------------------------------------------- write_file

const writeFileTool: Tool = {
  name: 'write_file',
  kind: 'write',
  def: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a whole file with the given content. Creates parent directories. ' +
        'For changes to parts of an existing file prefer apply_patch.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  summarize: (input) => `Write ${input.path}`,
  preview: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, 'path'))
    const content = String(input.content ?? '')
    try {
      const existing = await fsp.readFile(file, 'utf8')
      return unifiedDiff(existing, content)
    } catch {
      return newFilePreview(content)
    }
  },
  run: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, 'path'))
    const content = String(input.content ?? '')
    await ctx.onBeforeMutate?.(file)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, content, 'utf8')
    return { ok: true, output: `Wrote ${content.length} chars to ${file}` }
  }
}

// -------------------------------------------------------------- apply_patch

const APPLY_PATCH_DESC = `Edit files with a patch — the preferred way to create, modify, delete, or rename files. One call can touch several files. Format:

*** Begin Patch
*** Add File: path/new.ts       (each following line is prefixed with +)
+content line
*** Update File: path/existing.ts
*** Move to: path/renamed.ts     (optional — rename on update)
@@ optional locator (a nearby function/class signature)
 unchanged context line
-removed line
+added line
*** Delete File: path/old.ts
*** End Patch

Rules: paths are relative to the workspace. In Update hunks, include a few unchanged context lines around each change so it can be located; prefix context with a space, removals with -, additions with +. The call fails if a hunk's context can't be matched — do NOT re-read the file after a successful patch.`

type PatchChange =
  | { action: 'add'; abs: string; rel: string; after: string }
  | { action: 'delete'; abs: string; rel: string; before: string }
  | { action: 'update'; abs: string; rel: string; before: string; after: string }
  | { action: 'move'; abs: string; rel: string; before: string; toAbs: string; toRel: string; after: string }

/** Compute all file changes in memory. Returns an error string on any failure,
 *  so nothing is written unless the whole patch applies. */
async function computePatch(cwd: string, patchText: string): Promise<PatchChange[] | string> {
  let ops
  try {
    ops = parsePatch(patchText)
  } catch (e) {
    return e instanceof PatchError ? e.message : String(e)
  }
  const changes: PatchChange[] = []
  for (const op of ops) {
    let abs: string
    try {
      abs = resolveInCwd(cwd, op.path)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    if (op.kind === 'add') {
      if (fs.existsSync(abs)) return `Add File: ${op.path} already exists — use Update File.`
      changes.push({ action: 'add', abs, rel: op.path, after: op.content })
    } else if (op.kind === 'delete') {
      let before: string
      try {
        before = await fsp.readFile(abs, 'utf8')
      } catch {
        return `Delete File: ${op.path} does not exist.`
      }
      changes.push({ action: 'delete', abs, rel: op.path, before })
    } else {
      let before: string
      try {
        before = await fsp.readFile(abs, 'utf8')
      } catch {
        return `Update File: ${op.path} does not exist.`
      }
      let after: string
      try {
        after = applyHunks(before, op.hunks)
      } catch (e) {
        return e instanceof PatchError ? `Update File: ${op.path}: ${e.message}` : String(e)
      }
      if (op.moveTo) {
        let toAbs: string
        try {
          toAbs = resolveInCwd(cwd, op.moveTo)
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
        if (fs.existsSync(toAbs) && toAbs !== abs) return `Move to: ${op.moveTo} already exists.`
        changes.push({ action: 'move', abs, rel: op.path, before, toAbs, toRel: op.moveTo, after })
      } else {
        changes.push({ action: 'update', abs, rel: op.path, before, after })
      }
    }
  }
  return changes
}

const applyPatchTool: Tool = {
  name: 'apply_patch',
  kind: 'write',
  def: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: APPLY_PATCH_DESC,
      parameters: {
        type: 'object',
        properties: { patch: { type: 'string', description: 'The patch text, from *** Begin Patch to *** End Patch' } },
        required: ['patch']
      }
    }
  },
  summarize: (input) => {
    const m = String(input.patch ?? '').match(/^\*\*\* (Add|Update|Delete) File: /gm)
    return `apply_patch: ${m ? m.length : 0} file${m && m.length === 1 ? '' : 's'}`
  },
  preview: async (input, ctx) => {
    const res = await computePatch(ctx.cwd, str(input, 'patch'))
    if (typeof res === 'string') return undefined
    return res
      .map((c) => {
        if (c.action === 'add') return `--- ${c.rel} (new)\n${newFilePreview(c.after)}`
        if (c.action === 'delete') return `--- ${c.rel} (deleted)`
        if (c.action === 'move') return `--- ${c.rel} → ${c.toRel}\n${unifiedDiff(c.before, c.after)}`
        return `--- ${c.rel}\n${unifiedDiff(c.before, c.after)}`
      })
      .join('\n\n')
  },
  run: async (input, ctx) => {
    const res = await computePatch(ctx.cwd, str(input, 'patch'))
    if (typeof res === 'string') return { ok: false, output: res }
    const done: string[] = []
    for (const c of res) {
      if (c.action === 'add') {
        await ctx.onBeforeMutate?.(c.abs)
        await fsp.mkdir(path.dirname(c.abs), { recursive: true })
        await fsp.writeFile(c.abs, c.after, 'utf8')
        done.push(`added ${c.rel}`)
      } else if (c.action === 'delete') {
        await ctx.onBeforeMutate?.(c.abs)
        await fsp.rm(c.abs, { force: true })
        done.push(`deleted ${c.rel}`)
      } else if (c.action === 'update') {
        await ctx.onBeforeMutate?.(c.abs)
        await fsp.writeFile(c.abs, c.after, 'utf8')
        done.push(`updated ${c.rel}`)
      } else {
        await ctx.onBeforeMutate?.(c.abs)
        await ctx.onBeforeMutate?.(c.toAbs)
        await fsp.mkdir(path.dirname(c.toAbs), { recursive: true })
        await fsp.writeFile(c.toAbs, c.after, 'utf8')
        if (c.toAbs !== c.abs) await fsp.rm(c.abs, { force: true })
        done.push(`renamed ${c.rel} → ${c.toRel}`)
      }
    }
    return { ok: true, output: `Applied patch: ${done.join(', ')}.` }
  }
}

// ---------------------------------------------------------------- list_dir

const listDirTool: Tool = {
  name: 'list_dir',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path (non-recursive). Directories end with /.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: workspace root)' }
        }
      }
    }
  },
  summarize: (input) => `List ${input.path ?? '.'}`,
  run: async (input, ctx) => {
    const dir = resolveInCwd(ctx.cwd, str(input, 'path', false) || '.')
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const lines = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return { ok: true, output: lines.join('\n') || '(empty directory)' }
  }
}

// ---------------------------------------------------------------- glob

function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
}

async function walk(
  root: string,
  cb: (file: string, rel: string) => boolean | void,
  signal: AbortSignal
): Promise<void> {
  const stack = ['']
  let visited = 0
  while (stack.length > 0 && visited < 50_000 && !signal.aborted) {
    const relDir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(path.join(root, relDir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      visited++
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(rel)
      } else if (e.isFile()) {
        if (cb(path.join(root, rel), rel) === false) return
      }
    }
  }
}

const globTool: Tool = {
  name: 'glob',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern (e.g. "src/**/*.ts"). Skips node_modules, .git, and other build dirs.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern relative to workspace' }
        },
        required: ['pattern']
      }
    }
  },
  summarize: (input) => `Glob ${input.pattern}`,
  run: async (input, ctx) => {
    const re = globToRegExp(str(input, 'pattern'))
    const matches: string[] = []
    await walk(
      ctx.cwd,
      (_file, rel) => {
        if (re.test(rel)) matches.push(rel)
        if (matches.length >= 400) return false
        return undefined
      },
      ctx.signal
    )
    return {
      ok: true,
      output: matches.length ? matches.join('\n') : 'No files matched.'
    }
  }
}

// ---------------------------------------------------------------- grep

const grepTool: Tool = {
  name: 'grep',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents for a regex. Returns matching lines as path:line:text. ' +
        'Skips binary files, node_modules, and build dirs.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for' },
          path: { type: 'string', description: 'Directory to search (default workspace root)' },
          glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.ts"' }
        },
        required: ['pattern']
      }
    }
  },
  summarize: (input) => `Grep /${input.pattern}/${input.glob ? ` in ${input.glob}` : ''}`,
  run: async (input, ctx) => {
    let re: RegExp
    try {
      re = new RegExp(str(input, 'pattern'))
    } catch (e) {
      return { ok: false, output: `Invalid regex: ${e instanceof Error ? e.message : e}` }
    }
    const fileFilter = input.glob ? globToRegExp(String(input.glob)) : null
    const root = resolveInCwd(ctx.cwd, str(input, 'path', false) || '.')
    const results: string[] = []
    const pending: Promise<void>[] = []
    await walk(
      root,
      (file, rel) => {
        if (fileFilter && !fileFilter.test(rel)) return undefined
        if (results.length >= 200) return false
        pending.push(
          (async () => {
            try {
              const stat = await fsp.stat(file)
              if (stat.size > 2 * 1024 * 1024) return
              const buf = await fsp.readFile(file)
              if (buf.includes(0)) return // binary
              const lines = buf.toString('utf8').split('\n')
              for (let i = 0; i < lines.length && results.length < 200; i++) {
                if (re.test(lines[i])) {
                  results.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 300)}`)
                }
              }
            } catch {
              /* unreadable file */
            }
          })()
        )
        return undefined
      },
      ctx.signal
    )
    await Promise.all(pending)
    return {
      ok: true,
      output: results.length ? clamp(results.join('\n')) : 'No matches found.'
    }
  }
}

// ---------------------------------------------------------------- memory

const memoryTool: Tool = {
  name: 'memory',
  kind: 'memory',
  def: {
    type: 'function',
    function: {
      name: 'memory',
      description:
        'Manage your persistent memory across sessions. Three bounded stores: "memory" (global notes: environment facts, lessons learned), "user" (the user: preferences, style, identity), and "project" (this workspace only: conventions, build commands, gotchas). ' +
        'Current contents appear in your system prompt. Save proactively when you learn durable facts; consolidate when a store is near its limit. ' +
        'replace/remove match entries by a unique substring of the existing entry (old_text).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'replace', 'remove'] },
          target: { type: 'string', enum: ['memory', 'user', 'project'], description: 'Which store to modify' },
          content: { type: 'string', description: 'Entry text (for add/replace). Compact and information-dense.' },
          old_text: { type: 'string', description: 'Unique substring of the existing entry (for replace/remove)' }
        },
        required: ['action', 'target']
      }
    }
  },
  summarize: (input) => `${input.action} ${input.target}: ${String(input.content ?? input.old_text ?? '').slice(0, 80)}`,
  preview: async (input) => {
    const target = String(input.target ?? '')
    const action = String(input.action ?? '')
    if (action === 'add') return `+[${target}] ${input.content ?? ''}`
    if (action === 'replace') return `-[${target}] …${input.old_text ?? ''}…\n+[${target}] ${input.content ?? ''}`
    if (action === 'remove') return `-[${target}] …${input.old_text ?? ''}…`
    return undefined
  },
  run: async (input, ctx) => {
    const target = String(input.target ?? '') as MemoryTarget
    if (target !== 'memory' && target !== 'user' && target !== 'project') {
      return { ok: false, output: 'target must be "memory", "user", or "project"' }
    }
    const result = memoryStore.apply({
      action: String(input.action ?? ''),
      target,
      content: input.content === undefined ? undefined : String(input.content),
      old_text: input.old_text === undefined ? undefined : String(input.old_text),
      cwd: ctx.cwd
    })
    return { ok: result.success, output: JSON.stringify(result, null, 2) }
  }
}

// ------------------------------------------------------------- fetch_page

const FETCH_MAX_BYTES = 2 * 1024 * 1024
const FETCH_MAX_CHARS = 40_000
const FETCH_MAX_REDIRECTS = 5

/** Strip an HTML document down to readable text (title, headings, prose, links). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim()
  s = s
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n# ')
    .replace(/<\/(h[1-6])>/gi, '\n')
    .replace(/<(li)[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<a\s[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title ? `Title: ${title}\n\n${s}` : s
}

const fetchPageTool: Tool = {
  name: 'fetch_page',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'fetch_page',
      description:
        'Fetch a web page (or JSON/text URL) and return its readable content. Use this to read a full page that web_search only summarized — docs, articles, READMEs, API responses. Public URLs only.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to fetch' }
        },
        required: ['url']
      }
    }
  },
  summarize: (input) => String(input.url ?? ''),
  run: async (input, ctx) => {
    let url: URL
    try {
      url = new URL(String(input.url ?? ''))
    } catch {
      return { ok: false, output: 'Invalid URL.' }
    }
    try {
      await assertPublicUrl(url)
    } catch (err) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) }
    }
    const timeout = AbortSignal.timeout(20_000)
    const signal = AbortSignal.any([ctx.signal, timeout])
    const headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; Conduit/1.0)',
      Accept: 'text/html,application/json,text/*;q=0.9,*/*;q=0.5'
    }
    // Manual redirects so every hop is re-checked against private IPs/DNS.
    let res: Response
    let current = url
    try {
      for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
        res = await fetch(current, { signal, redirect: 'manual', headers })
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location')
          if (!loc) return { ok: false, output: `HTTP ${res.status} redirect without Location` }
          const next = new URL(loc, current)
          await assertPublicUrl(next)
          current = next
          continue
        }
        break
      }
    } catch (err) {
      return { ok: false, output: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (!res!) return { ok: false, output: 'Empty response.' }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, output: `Too many redirects (max ${FETCH_MAX_REDIRECTS}).` }
    }
    if (!res.ok) return { ok: false, output: `HTTP ${res.status} ${res.statusText}` }
    const ctype = res.headers.get('content-type') ?? ''
    if (!/text|json|xml/i.test(ctype) || /javascript/i.test(ctype)) {
      return { ok: false, output: `Unsupported content type: ${ctype || 'unknown'} (only text-like content).` }
    }
    // Stream with a byte cap so a huge page can't blow up memory.
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, output: 'Empty response.' }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      chunks.push(value)
      if (total >= FETCH_MAX_BYTES) {
        void reader.cancel()
        break
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const text = /html/i.test(ctype) ? htmlToText(raw) : raw
    const clipped = text.length > FETCH_MAX_CHARS
    return {
      ok: true,
      output:
        `[${current.href}]\n` +
        text.slice(0, FETCH_MAX_CHARS) +
        (clipped || total >= FETCH_MAX_BYTES ? '\n\n[...truncated]' : '')
    }
  }
}

// ------------------------------------------------------------ update_plan

const PLAN_STATUSES = new Set(['pending', 'active', 'done'])

const updatePlanTool: Tool = {
  name: 'update_plan',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Publish or update your live plan for the current task — a short checklist the user sees beside the chat. ' +
        'Call it when you start a multi-step task (all steps pending, first active), and again whenever a step completes or the plan changes. ' +
        'Each call replaces the whole plan. Skip it for single-step or conversational requests.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '3-10 short imperative steps in execution order',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short step description' },
                status: { type: 'string', enum: ['pending', 'active', 'done'] }
              },
              required: ['title', 'status']
            }
          }
        },
        required: ['steps']
      }
    }
  },
  summarize: (input) => {
    const steps = Array.isArray(input.steps) ? input.steps : []
    const done = steps.filter((s) => (s as PlanStep)?.status === 'done').length
    return `${done}/${steps.length} steps done`
  },
  run: async (input, ctx) => {
    const raw = Array.isArray(input.steps) ? input.steps : []
    const steps: PlanStep[] = []
    for (const s of raw.slice(0, 20)) {
      const title = String((s as Record<string, unknown>)?.title ?? '').trim().slice(0, 120)
      const status = String((s as Record<string, unknown>)?.status ?? 'pending')
      if (!title) continue
      steps.push({ title, status: PLAN_STATUSES.has(status) ? (status as PlanStep['status']) : 'pending' })
    }
    if (!steps.length) return { ok: false, output: 'Provide at least one step with a title.' }
    ctx.onPlan?.(steps)
    return { ok: true, output: `Plan updated (${steps.length} steps).` }
  }
}

// ----------------------------------------------------------------- skill

const skillTool: Tool = {
  name: 'skill',
  kind: 'memory',
  def: {
    type: 'function',
    function: {
      name: 'skill',
      description:
        'Your procedural memory: reusable playbooks for multi-step workflows you have figured out (deploy steps, codegen dances, test rituals). ' +
        'The skills index in your system prompt lists what exists — read a skill BEFORE redoing a workflow it covers. ' +
        'Create a skill when you complete a non-obvious multi-step procedure likely to recur; update it when the documented procedure proved wrong or incomplete.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'create', 'update', 'delete'] },
          name: { type: 'string', description: 'Kebab-case slug, e.g. "deploy-staging"' },
          description: {
            type: 'string',
            description: 'One line stating when this skill applies (create/update)'
          },
          content: {
            type: 'string',
            description: 'The playbook: numbered steps, exact commands, gotchas (create/update)'
          }
        },
        required: ['action', 'name']
      }
    }
  },
  summarize: (input) => `${input.action} skill: ${input.name}`,
  requiresApproval: (input) => input.action !== 'read',
  preview: async (input) => {
    const action = String(input.action ?? '')
    if (action === 'read') return undefined
    if (action === 'delete') return `-[skill] ${input.name}`
    return `[skill: ${input.name}] ${input.description ?? ''}\n${String(input.content ?? '').slice(0, 1500)}`
  },
  run: async (input) => {
    const action = String(input.action ?? '')
    const name = String(input.name ?? '')
    if (action === 'read') {
      const skill = skillStore.read(name)
      if (!skill) return { ok: false, output: `No skill named "${name}". Check the skills index.` }
      let output = `# ${skill.meta.name}\n${skill.meta.description}\n(updated ${skill.meta.updated})\n\n${skill.content}`
      if (skill.files.length) {
        output +=
          `\n\n## Bundled files (in ${skill.dir})\n` +
          skill.files.map((f) => `- ${f}`).join('\n') +
          `\nWhen the playbook references one of these (a script to run, a reference to consult), use its absolute path under that directory — e.g. read_file or bash with "${skill.dir}/<file>".`
      }
      return { ok: true, output }
    }
    if (action === 'create' || action === 'update' || action === 'delete') {
      const result = skillStore.save({
        action,
        name,
        description: input.description === undefined ? undefined : String(input.description),
        content: input.content === undefined ? undefined : String(input.content)
      })
      return { ok: result.success, output: result.message }
    }
    return { ok: false, output: 'action must be read, create, update, or delete' }
  }
}

// ---------------------------------------------------------- session_search

const sessionSearchTool: Tool = {
  name: 'session_search',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'session_search',
      description:
        'Search your past sessions with this user for something you discussed before ("did we set this up last week?"). ' +
        'Returns matching messages with session title and date. Use memory for always-relevant facts; use this to recall specifics.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' }
        },
        required: ['query']
      }
    }
  },
  summarize: (input) => `Search past sessions: ${input.query}`,
  run: async (input, ctx) => {
    const query = String(input.query ?? '').trim().toLowerCase()
    if (!query) return { ok: false, output: 'query is required' }
    const results: string[] = []
    for (const meta of sessionStore.list()) {
      if (meta.id === ctx.sessionId) continue
      const rec = await sessionStore.load(meta.id)
      if (!rec) continue
      const date = new Date(meta.updatedAt).toISOString().slice(0, 10)
      // Digests summarize whole sessions — they surface matches even when
      // the exact keyword never appeared verbatim in a message.
      if (rec.digest?.toLowerCase().includes(query) && results.length < 25) {
        results.push(`[${date}] "${meta.title}" (summary): ${rec.digest.replace(/\s+/g, ' ').slice(0, 240)}`)
      }
      for (const item of rec.items) {
        if (results.length >= 25) break
        const text =
          item.kind === 'user' || item.kind === 'assistant'
            ? item.text
            : item.kind === 'tool'
              ? `${item.name} ${JSON.stringify(item.input)}`
              : ''
        const idx = text.toLowerCase().indexOf(query)
        if (idx < 0) continue
        const snippet = text
          .slice(Math.max(0, idx - 80), idx + query.length + 160)
          .replace(/\s+/g, ' ')
          .trim()
        results.push(`[${date}] "${meta.title}" (${item.kind}): …${snippet}…`)
      }
      if (results.length >= 25) break
    }
    return {
      ok: true,
      output: results.length ? results.join('\n') : 'No matches in past sessions.'
    }
  }
}

// Compaction replaces older turns in the model's context with a short summary,
// but never touches session.items — the full transcript stays on disk. This is
// the read path back to it: pull-based, so it costs nothing until the model
// actually needs a detail the summary dropped.
const recallHistoryTool: Tool = {
  name: 'recall_history',
  kind: 'read',
  def: {
    type: 'function',
    function: {
      name: 'recall_history',
      description:
        'Search the full transcript of the CURRENT session, including earlier turns that were compacted out of your context. ' +
        'When this conversation gets long, older turns are replaced by a short summary — the full text is still saved, and this reads it back. ' +
        'Use it when you need a specific detail the summary dropped: an exact error message, a file path, a command you already ran and its output, ' +
        'or what was decided earlier and why. Searches message text and tool output. ' +
        'For conversations from OTHER days/sessions, use session_search instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' },
          limit: { type: 'number', description: 'Max matches to return (default 20, max 50)' }
        },
        required: ['query']
      }
    }
  },
  summarize: (input) => `Recall from this session: ${input.query}`,
  run: async (input, ctx) => {
    const query = String(input.query ?? '').trim().toLowerCase()
    if (!query) return { ok: false, output: 'query is required' }
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 20, 1), 50)
    const rec = await sessionStore.load(ctx.sessionId)
    if (!rec) return { ok: false, output: 'This session could not be read.' }

    // Anything before the last compaction is what is no longer in context —
    // worth flagging so the model can tell recovery from redundancy.
    let lastCompaction = -1
    rec.items.forEach((it, i) => {
      if (it.kind === 'compaction') lastCompaction = i
    })

    const matches: string[] = []
    for (let i = 0; i < rec.items.length && matches.length < limit; i++) {
      const item = rec.items[i]
      let label: string
      let text: string
      switch (item.kind) {
        case 'user':
          label = 'user'
          text = item.text
          break
        case 'assistant':
          label = 'assistant'
          text = item.text
          break
        case 'tool':
          label = `tool ${item.name} (${item.status})`
          text = `${JSON.stringify(item.input)}\n${item.output ?? ''}`
          break
        case 'compaction':
          label = 'compaction summary'
          text = item.summary
          break
        case 'error':
          label = 'error'
          text = item.message
          break
        case 'note':
          label = 'note'
          text = item.text
          break
        default:
          continue
      }
      const idx = text.toLowerCase().indexOf(query)
      if (idx < 0) continue
      const snippet = text
        .slice(Math.max(0, idx - 120), idx + query.length + 280)
        .replace(/\s+/g, ' ')
        .trim()
      // Local time, matching the clock the user sees in the transcript.
      const when = new Date(item.ts).toTimeString().slice(0, 5)
      const where = i <= lastCompaction ? 'compacted out of context' : 'still in context'
      matches.push(`#${i} [${when}] ${label} — ${where}:\n…${snippet}…`)
    }

    if (!matches.length) {
      return {
        ok: true,
        output:
          `No match for "${input.query}" in this session's transcript` +
          (lastCompaction === -1 ? ' (nothing has been compacted yet — it is all still in your context).' : '.')
      }
    }
    return { ok: true, output: clamp(matches.join('\n\n')) }
  }
}

// ---------------------------------------------------------------- ask_user

const askUserTool: Tool = {
  name: 'ask_user',
  kind: 'read', // interacting with the user is not a machine mutation — no approval gate
  def: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their answer before continuing. Use only when you genuinely need a decision or missing information to proceed — a choice between real options, a missing value, or confirmation of intent — never for things you can determine yourself by reading the workspace. Prefer offering concrete options. This is your only way to pause for input while running autonomously.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional suggested answers, shown as quick-reply buttons (max 6)'
          }
        },
        required: ['question']
      }
    }
  },
  summarize: (input) => `Ask: ${String(input.question ?? '')}`,
  run: async (input, ctx) => {
    if (!ctx.askUser) return { ok: false, output: 'Cannot ask the user in this context.' }
    const question = str(input, 'question')
    const options = Array.isArray(input.options)
      ? input.options.filter((o): o is string => typeof o === 'string').slice(0, 6)
      : undefined
    const answer = await ctx.askUser(question, options)
    return {
      ok: true,
      output: answer.trim() ? `User answered: ${answer.trim()}` : 'User declined to answer; use your best judgment or stop and explain.'
    }
  }
}

export const TOOLS: Tool[] = [
  bashTool, monitorTool, diagnosticsTool, readFileTool, applyPatchTool, writeFileTool, listDirTool, globTool, grepTool,
  fetchPageTool, updatePlanTool, askUserTool, memoryTool, skillTool, sessionSearchTool, recallHistoryTool,
  spawnAgentTool
]

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]))

/** Read-only tools handed to subagents (no writes, shell, memory, or recursion). */
export function subagentTools(): Tool[] {
  return [readFileTool, listDirTool, globTool, grepTool, sessionSearchTool, fetchPageTool]
}

export function toolDefs(opts?: { memory?: boolean }): ApiToolDef[] {
  const includeMemory = opts?.memory !== false
  return TOOLS.filter(
    (t) => includeMemory || (t.name !== 'memory' && t.name !== 'skill')
  ).map((t) => t.def)
}

/** Fuzzy file suggestions for @-mentions in the composer. */
export async function suggestFiles(cwd: string, query: string, limit = 20): Promise<string[]> {
  const q = query.trim().toLowerCase()
  const matches: { rel: string; score: number }[] = []
  const controller = new AbortController()
  await walk(
    cwd,
    (_file, rel) => {
      const lower = rel.toLowerCase()
      const base = path.basename(lower)
      let score = -1
      if (!q) score = rel.length
      else if (base.startsWith(q)) score = 0
      else if (base.includes(q)) score = 1000 + base.indexOf(q)
      else if (lower.includes(q)) score = 10_000 + lower.indexOf(q)
      if (score >= 0) matches.push({ rel, score: score + rel.length / 1000 })
      if (matches.length >= 3000) return false
      return undefined
    },
    controller.signal
  )
  return matches
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((m) => m.rel)
}
