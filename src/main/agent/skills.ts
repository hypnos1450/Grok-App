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
import { scanEntry } from './memory'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const MAX_SKILLS = 40
const MAX_CONTENT = 8000
const MAX_DESCRIPTION = 140

export interface SkillOpResult {
  success: boolean
  message: string
}

class SkillStore {
  private dir(): string {
    return path.join(app.getPath('userData'), 'skills')
  }

  private file(name: string): string {
    return path.join(this.dir(), `${name}.md`)
  }

  list(): SkillMeta[] {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir()).filter((f) => f.endsWith('.md'))
    } catch {
      return []
    }
    const metas: SkillMeta[] = []
    for (const f of files) {
      const parsed = this.read(f.slice(0, -3))
      if (parsed) metas.push(parsed.meta)
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name))
  }

  read(name: string): { meta: SkillMeta; content: string } | null {
    if (!NAME_RE.test(name)) return null
    let raw: string
    try {
      raw = fs.readFileSync(this.file(name), 'utf8')
    } catch {
      return null
    }
    const m = /^---\ndescription: (.*)\nupdated: (.*)\n---\n?([\s\S]*)$/.exec(raw)
    if (!m) return { meta: { name, description: '', updated: '' }, content: raw }
    return {
      meta: { name, description: m[1], updated: m[2] },
      content: m[3].trim()
    }
  }

  save(op: {
    action: 'create' | 'update' | 'delete'
    name: string
    description?: string
    content?: string
  }): SkillOpResult {
    const name = (op.name ?? '').trim().toLowerCase()
    if (!NAME_RE.test(name)) {
      return { success: false, message: 'Skill name must be a short kebab-case slug (a-z, 0-9, dashes, max 40 chars).' }
    }
    const existing = this.read(name)

    if (op.action === 'delete') {
      if (!existing) return { success: false, message: `No skill named "${name}".` }
      fs.rmSync(this.file(name), { force: true })
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
    if (content.length > MAX_CONTENT) {
      return { success: false, message: `Skill content too long (${content.length} > ${MAX_CONTENT} chars). Skills are focused playbooks, not documentation dumps.` }
    }
    const threat = scanEntry(`${description}\n${content}`)
    if (threat) return { success: false, message: threat }

    fs.mkdirSync(this.dir(), { recursive: true })
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
