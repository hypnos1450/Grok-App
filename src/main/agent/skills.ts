// Agent-authored skills: procedural memory. Where the memory stores hold
// facts, skills hold reusable multi-step procedures the agent has worked out
// ("how to deploy this app", "how this repo's codegen works"). Stored as
// SKILL.md-style files; an index (name + description) lives in the system
// prompt and the agent reads full bodies on demand via the `skill` tool.
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PendingSkillWrite, SkillMeta } from '@shared/types'
import { scanEntry, scanSkillBody } from './memory'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const MAX_SKILLS = 40
const MAX_CONTENT = 8000
// Imported skills (GitHub / folder) are written by humans for humans and can
// be far longer than agent-authored playbooks; bodies are only read on demand
// (~32K tokens at the cap, well within either model's window).
const MAX_IMPORT_CONTENT = 128_000
const MAX_DESCRIPTION = 140

export interface SkillOpResult {
  success: boolean
  message: string
}

class SkillStore {
  private dir(): string {
    return path.join(app.getPath('userData'), 'skills')
  }

  /** Each skill is a directory: SKILL.md plus optional bundled resources. */
  dirFor(name: string): string {
    return path.join(this.dir(), name)
  }

  private file(name: string): string {
    return path.join(this.dirFor(name), 'SKILL.md')
  }

  /** Move legacy flat `<name>.md` files into `<name>/SKILL.md` (store v1 → v2). */
  private migrateLegacy(): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.dir(), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const name = e.name.slice(0, -3)
      if (!NAME_RE.test(name)) continue
      try {
        fs.mkdirSync(this.dirFor(name), { recursive: true })
        fs.renameSync(path.join(this.dir(), e.name), this.file(name))
      } catch {
        // leave the flat file in place; we'll retry next call
      }
    }
  }

  list(): SkillMeta[] {
    this.migrateLegacy()
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(this.dir(), { withFileTypes: true })
    } catch {
      return []
    }
    const metas: SkillMeta[] = []
    for (const e of entries) {
      if (!e.isDirectory() || !NAME_RE.test(e.name)) continue
      const parsed = this.read(e.name)
      if (parsed) metas.push(parsed.meta)
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name))
  }

  read(name: string): { meta: SkillMeta; content: string; dir: string; files: string[] } | null {
    if (!NAME_RE.test(name)) return null
    this.migrateLegacy()
    let raw: string
    try {
      raw = fs.readFileSync(this.file(name), 'utf8')
    } catch {
      return null
    }
    const files = this.listResources(name)
    const dir = this.dirFor(name)
    const m = /^---\ndescription: (.*)\nupdated: (.*)\n---\n?([\s\S]*)$/.exec(raw)
    if (!m) {
      return { meta: { name, description: '', updated: '', fileCount: files.length }, content: raw, dir, files }
    }
    return {
      meta: { name, description: m[1], updated: m[2], fileCount: files.length },
      content: m[3].trim(),
      dir,
      files
    }
  }

  /** Relative paths of bundled resources (everything except SKILL.md). */
  private listResources(name: string): string[] {
    const out: string[] = []
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= 200) return
        if (!rel && e.name === 'SKILL.md') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(dir, e.name), r)
        else if (e.isFile()) out.push(r)
      }
    }
    walk(this.dirFor(name), '')
    return out.sort()
  }

  save(
    op: {
      action: 'create' | 'update' | 'delete'
      name: string
      description?: string
      content?: string
    },
    opts?: { contentLimit?: number }
  ): SkillOpResult {
    const contentLimit = opts?.contentLimit ?? MAX_CONTENT
    const name = (op.name ?? '').trim().toLowerCase()
    if (!NAME_RE.test(name)) {
      return { success: false, message: 'Skill name must be a short kebab-case slug (a-z, 0-9, dashes, max 40 chars).' }
    }
    const existing = this.read(name)

    if (op.action === 'delete') {
      if (!existing) return { success: false, message: `No skill named "${name}".` }
      fs.rmSync(this.dirFor(name), { recursive: true, force: true })
      return { success: true, message: `Skill "${name}" deleted.` }
    }

    if (op.action === 'create' && existing) {
      return { success: false, message: `Skill "${name}" already exists — use action "update" to revise it.` }
    }
    if (op.action === 'update' && !existing) {
      return { success: false, message: `No skill named "${name}" — use action "create".` }
    }
    if (op.action === 'create' && this.list().length >= MAX_SKILLS) {
      return { success: false, message: `Skill limit reached (${MAX_SKILLS}). Delete or consolidate an existing skill first.` }
    }

    const description = (op.description ?? existing?.meta.description ?? '').trim()
    const content = (op.content ?? existing?.content ?? '').trim()
    if (!description) return { success: false, message: 'A one-line description is required (used to decide when the skill is relevant).' }
    if (description.length > MAX_DESCRIPTION) {
      return { success: false, message: `Description too long (${description.length} > ${MAX_DESCRIPTION} chars).` }
    }
    if (!content) return { success: false, message: 'Skill content is empty.' }
    if (content.length > contentLimit) {
      return { success: false, message: `Skill content too long (${content.length} > ${contentLimit} chars). Skills are focused playbooks, not documentation dumps.` }
    }
    // Descriptions land in the system prompt (skills index) — scan strictly.
    // Bodies are read on demand, so only block instruction hijacking there.
    const threat = scanEntry(description) ?? scanSkillBody(content)
    if (threat) return { success: false, message: threat }

    fs.mkdirSync(this.dirFor(name), { recursive: true })
    const updated = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(
      this.file(name),
      `---\ndescription: ${description}\nupdated: ${updated}\n---\n${content}\n`,
      'utf8'
    )
    return { success: true, message: `Skill "${name}" ${op.action === 'create' ? 'created' : 'updated'}.` }
  }

  /** Compact index for the system prompt. */
  index(): string {
    const metas = this.list()
    if (!metas.length) return ''
    return (
      `# Skills index\nYou have ${metas.length} saved skill${metas.length === 1 ? '' : 's'} (read one with the skill tool before doing the workflow it covers):\n` +
      metas.map((m) => `- ${m.name}: ${m.description}`).join('\n')
    )
  }

  // ------------------------------------------------- staged (pending) writes

  private pendingFile(): string {
    return path.join(this.dir(), 'pending.json')
  }

  listPending(): PendingSkillWrite[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pendingFile(), 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private writePending(items: PendingSkillWrite[]): void {
    fs.mkdirSync(this.dir(), { recursive: true })
    fs.writeFileSync(this.pendingFile(), JSON.stringify(items, null, 2), 'utf8')
  }

  stage(op: Omit<PendingSkillWrite, 'id' | 'ts'>): PendingSkillWrite {
    const write: PendingSkillWrite = {
      ...op,
      id: crypto.randomBytes(6).toString('hex'),
      ts: Date.now()
    }
    this.writePending([...this.listPending(), write])
    return write
  }

  /** Create-or-update used by the skill importer (GitHub / folder). */
  install(op: { name: string; description: string; content: string }): SkillOpResult {
    const action = this.read(op.name) ? 'update' : 'create'
    return this.save({ action, ...op }, { contentLimit: MAX_IMPORT_CONTENT })
  }

  resolvePending(id: string | 'all', approve: boolean): PendingSkillWrite[] {
    const pending = this.listPending()
    const selected = id === 'all' ? pending : pending.filter((p) => p.id === id)
    const remaining = id === 'all' ? [] : pending.filter((p) => p.id !== id)
    if (approve) {
      for (const p of selected) {
        this.save({ action: p.action, name: p.name, description: p.description, content: p.content })
      }
    }
    this.writePending(remaining)
    return remaining
  }
}

export const skillStore = new SkillStore()
