// Agent tool implementations. Dependency-free: bash via child_process,
// search via a bounded recursive walk.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ApiToolDef } from './provider'
import { newFilePreview, unifiedDiff } from './diff'
import { MemoryTarget, memoryStore } from './memory'
import { skillStore } from './skills'
import { spawnAgentTool } from './subagent'
import { sessionStore } from '../sessions'

// 'memory' mutates only the agent's own memory store — never the user's
// files or shell — so it runs without a permission prompt, like reads.
export type ToolKind = 'read' | 'write' | 'command' | 'memory'

export interface ToolContext {
  cwd: string
  sessionId: string
  signal: AbortSignal
  /** Called with the absolute path before a file tool mutates it (checkpoints) */
  onBeforeMutate?: (absPath: string) => Promise<void>
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

function resolveInCwd(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
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
      const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh'
      const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
      const child = spawn(shellBin, shellArgs, {
        cwd: ctx.cwd,
        env: { ...process.env, CLICOLOR: '0', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
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
          path: { type: 'string', description: 'File path (absolute or relative to workspace)' },
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
        'Create or overwrite a file with the given content. Creates parent directories. ' +
        'For small changes to existing files prefer edit_file.',
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

// ---------------------------------------------------------------- edit_file

const editFileTool: Tool = {
  name: 'edit_file',
  kind: 'write',
  def: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact string in a file. old_string must appear exactly once ' +
        '(or set replace_all). Include surrounding lines to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  summarize: (input) => `Edit ${input.path}`,
  preview: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, 'path'))
    const text = await fsp.readFile(file, 'utf8')
    const applied = applyEdit(text, input)
    return typeof applied === 'string' ? undefined : unifiedDiff(text, applied.next)
  },
  run: async (input, ctx) => {
    const file = resolveInCwd(ctx.cwd, str(input, 'path'))
    const text = await fsp.readFile(file, 'utf8')
    const applied = applyEdit(text, input)
    if (typeof applied === 'string') return { ok: false, output: applied }
    await ctx.onBeforeMutate?.(file)
    await fsp.writeFile(file, applied.next, 'utf8')
    return {
      ok: true,
      output: `Edited ${file} (${applied.count} replacement${applied.count === 1 ? '' : 's'})`
    }
  }
}

/** Shared edit logic so preview and run can't disagree. Returns error string on failure. */
function applyEdit(
  text: string,
  input: Record<string, unknown>
): { next: string; count: number } | string {
  const oldStr = String(input.old_string ?? '')
  const newStr = String(input.new_string ?? '')
  if (!oldStr) return 'old_string is empty'
  const count = text.split(oldStr).length - 1
  if (count === 0) {
    return 'old_string not found in file. Re-read the file and match the text exactly, including whitespace.'
  }
  if (count > 1 && !input.replace_all) {
    return `old_string appears ${count} times. Add surrounding context to make it unique, or set replace_all.`
  }
  return {
    next: input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr),
    count
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

export const TOOLS: Tool[] = [
  bashTool, readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool,
  memoryTool, skillTool, sessionSearchTool, spawnAgentTool
]

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]))

/** Read-only tools handed to subagents (no writes, shell, memory, or recursion). */
export function subagentTools(): Tool[] {
  return [readFileTool, listDirTool, globTool, grepTool, sessionSearchTool]
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
