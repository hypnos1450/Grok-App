// Persistent, bounded, agent-curated memory — modeled after Hermes Agent's
// built-in memory (MEMORY.md / USER.md). Two stores with hard character
// limits, managed by the model via the `memory` tool. Injected into the
// system prompt as a per-session frozen snapshot so the prompt-cache prefix
// stays stable; tool responses always show live state.
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PendingMemoryWrite } from '@shared/types'

export type MemoryTarget = 'memory' | 'user' | 'project'

const LIMITS: Record<MemoryTarget, number> = {
  memory: 2200, // ~800 tokens — environment facts, conventions, lessons learned
  user: 1375, //  ~500 tokens — user identity, preferences, communication style
  project: 2200 // per-workspace conventions, build commands, gotchas
}

const FILES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
  project: '' // resolved per-cwd, see file()
}

const DELIMITER = '\n§\n'

export interface MemoryOpResult {
  success: boolean
  message: string
  usage: string
  currentEntries?: string[]
}

// Entries land in the system prompt, so scan for the obvious injection and
// exfiltration vectors before accepting them.
const INVISIBLE_UNICODE = /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/
const THREAT_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /disregard (your|the) system prompt/i,
  /curl .*(\||;|&&).*(sh|bash)/i,
  /authorized_keys/i,
  /\b(api[_-]?key|secret|password|token)s?\s*[:=]\s*\S{8,}/i
]

export function scanEntry(content: string): string | null {
  if (INVISIBLE_UNICODE.test(content)) {
    return 'Entry contains invisible Unicode characters and was rejected.'
  }
  for (const p of THREAT_PATTERNS) {
    if (p.test(content)) {
      return 'Entry matches an injection/exfiltration pattern and was rejected. Memories must be plain facts, never instructions or credentials.'
    }
  }
  return null
}

// Skill bodies are read on demand into the conversation (not the system
// prompt), and legitimate playbooks routinely show credential-shaped examples
// ("password: ...") or curl pipelines. Only block outright instruction
// hijacking and invisible-unicode smuggling here; command execution stays
// behind the normal bash permission gate.
const BODY_THREAT_PATTERNS = [THREAT_PATTERNS[0], THREAT_PATTERNS[1]]

export function scanSkillBody(content: string): string | null {
  if (INVISIBLE_UNICODE.test(content)) {
    return 'Skill content contains invisible Unicode characters and was rejected.'
  }
  for (const p of BODY_THREAT_PATTERNS) {
    if (p.test(content)) {
      return 'Skill content matches a prompt-injection pattern and was rejected.'
    }
  }
  return null
}

class MemoryStore {
  private dir(): string {
    return path.join(app.getPath('userData'), 'memories')
  }

  private file(target: MemoryTarget, cwd?: string): string {
    if (target === 'project') {
      const key = crypto.createHash('sha1').update(cwd ?? '').digest('hex').slice(0, 12)
      return path.join(this.dir(), 'projects', `${key}.md`)
    }
    return path.join(this.dir(), FILES[target])
  }

  entries(target: MemoryTarget, cwd?: string): string[] {
    if (target === 'project' && !cwd) return []
    try {
      const raw = fs.readFileSync(this.file(target, cwd), 'utf8')
      return raw.split(DELIMITER).map((e) => e.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  private write(target: MemoryTarget, entries: string[], cwd?: string): void {
    const file = this.file(target, cwd)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, entries.join(DELIMITER), 'utf8')
  }

  private used(entries: string[]): number {
    return entries.length ? entries.join(DELIMITER).length : 0
  }

  private usageString(target: MemoryTarget, entries?: string[], cwd?: string): string {
    const e = entries ?? this.entries(target, cwd)
    return `${this.used(e).toLocaleString()}/${LIMITS[target].toLocaleString()} chars`
  }

  add(target: MemoryTarget, content: string, cwd?: string): MemoryOpResult {
    const entry = content.trim()
    if (!entry) return this.fail(target, 'Entry content is empty.', undefined, cwd)
    const threat = scanEntry(entry)
    if (threat) return this.fail(target, threat, undefined, cwd)
    if (target === 'project' && !cwd) return this.fail(target, 'Project memory needs a workspace.', undefined, cwd)

    const entries = this.entries(target, cwd)
    if (entries.includes(entry)) {
      return {
        success: true,
        message: 'This exact entry already exists — no duplicate added.',
        usage: this.usageString(target, entries, cwd)
      }
    }
    const next = [...entries, entry]
    if (this.used(next) > LIMITS[target]) {
      return {
        success: false,
        message:
          `Memory at ${this.usageString(target, entries, cwd)}. Adding this entry (${entry.length} chars) would exceed the limit. ` +
          `Consolidate now: use 'replace' to merge overlapping entries into shorter ones, or 'remove' stale or less important entries (see currentEntries), then retry this add — all in this turn.`,
        usage: this.usageString(target, entries, cwd),
        currentEntries: entries
      }
    }
    this.write(target, next, cwd)
    return { success: true, message: 'Entry added.', usage: this.usageString(target, next, cwd) }
  }

  replace(target: MemoryTarget, oldText: string, content: string, cwd?: string): MemoryOpResult {
    const entry = content.trim()
    if (!entry) return this.fail(target, 'Replacement content is empty. Use remove to delete an entry.', undefined, cwd)
    const threat = scanEntry(entry)
    if (threat) return this.fail(target, threat, undefined, cwd)

    const entries = this.entries(target, cwd)
    const match = this.match(entries, oldText)
    if (typeof match === 'string') return this.fail(target, match, entries, cwd)
    const next = [...entries]
    next[match] = entry
    if (this.used(next) > LIMITS[target]) {
      return {
        success: false,
        message: `The replacement is longer than the space available (${this.usageString(target, entries, cwd)}). Shorten the new content or remove another entry first.`,
        usage: this.usageString(target, entries, cwd),
        currentEntries: entries
      }
    }
    this.write(target, next, cwd)
    return { success: true, message: 'Entry replaced.', usage: this.usageString(target, next, cwd) }
  }

  remove(target: MemoryTarget, oldText: string, cwd?: string): MemoryOpResult {
    const entries = this.entries(target, cwd)
    const match = this.match(entries, oldText)
    if (typeof match === 'string') return this.fail(target, match, entries, cwd)
    const next = entries.filter((_, i) => i !== match)
    this.write(target, next, cwd)
    return { success: true, message: 'Entry removed.', usage: this.usageString(target, next, cwd) }
  }

  /** Substring matching: old_text must identify exactly one entry. */
  private match(entries: string[], oldText: string): number | string {
    const needle = (oldText ?? '').trim()
    if (!needle) return 'old_text is required for this action.'
    const hits = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.toLowerCase().includes(needle.toLowerCase()))
    if (hits.length === 0) return `No entry contains "${needle}". See currentEntries for what exists.`
    if (hits.length > 1) return `"${needle}" matches ${hits.length} entries — use a more specific substring.`
    return hits[0].i
  }

  private fail(target: MemoryTarget, message: string, entries?: string[], cwd?: string): MemoryOpResult {
    return {
      success: false,
      message,
      usage: this.usageString(target, entries, cwd),
      currentEntries: entries ?? this.entries(target, cwd)
    }
  }

  /** Apply a memory operation (from the tool or an approved pending write). */
  apply(op: {
    action: string
    target: MemoryTarget
    content?: string
    old_text?: string
    cwd?: string
  }): MemoryOpResult {
    switch (op.action) {
      case 'add':
        return this.add(op.target, op.content ?? '', op.cwd)
      case 'replace':
        return this.replace(op.target, op.old_text ?? '', op.content ?? '', op.cwd)
      case 'remove':
        return this.remove(op.target, op.old_text ?? '', op.cwd)
      default:
        return this.fail(op.target, 'action must be add, replace, or remove', undefined, op.cwd)
    }
  }

  // ------------------------------------------------- staged (pending) writes

  private pendingFile(): string {
    return path.join(this.dir(), 'pending.json')
  }

  listPending(): PendingMemoryWrite[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pendingFile(), 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private writePending(items: PendingMemoryWrite[]): void {
    fs.mkdirSync(this.dir(), { recursive: true })
    fs.writeFileSync(this.pendingFile(), JSON.stringify(items, null, 2), 'utf8')
  }

  stage(op: Omit<PendingMemoryWrite, 'id' | 'ts'>): PendingMemoryWrite {
    const write: PendingMemoryWrite = {
      ...op,
      id: crypto.randomBytes(6).toString('hex'),
      ts: Date.now()
    }
    this.writePending([...this.listPending(), write])
    return write
  }

  /** Approve or reject one pending write (or 'all'). Returns what remains. */
  resolvePending(id: string | 'all', approve: boolean): PendingMemoryWrite[] {
    const pending = this.listPending()
    const selected = id === 'all' ? pending : pending.filter((p) => p.id === id)
    const remaining = id === 'all' ? [] : pending.filter((p) => p.id !== id)
    if (approve) {
      for (const p of selected) {
        this.apply({ action: p.action, target: p.target, content: p.content, old_text: p.old_text, cwd: p.cwd })
      }
    }
    this.writePending(remaining)
    return remaining
  }

  /** Render the stores as a frozen system-prompt block. */
  snapshot(cwd?: string): string {
    const blocks: string[] = []
    for (const target of ['memory', 'user', 'project'] as MemoryTarget[]) {
      const entries = this.entries(target, cwd)
      if (!entries.length) continue
      const limit = LIMITS[target]
      const used = this.used(entries)
      const pct = Math.round((used / limit) * 100)
      const label =
        target === 'memory'
          ? 'MEMORY (your personal notes)'
          : target === 'user'
            ? 'USER PROFILE'
            : 'PROJECT MEMORY (this workspace)'
      blocks.push(
        `══════════════════════════════════════════════\n` +
          `${label} [${pct}% — ${used.toLocaleString()}/${limit.toLocaleString()} chars]\n` +
          `══════════════════════════════════════════════\n` +
          entries.join('\n§\n')
      )
    }
    return blocks.join('\n\n')
  }
}

export const memoryStore = new MemoryStore()
