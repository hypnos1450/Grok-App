// Session persistence: one JSON file per session under userData/sessions,
// plus an in-memory index built at startup.
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ChatItem, ModelId, PlanStep, SCHEMA_VERSION, SessionMeta, TeamState } from '@shared/types'
import type { Checkpoint } from './agent/checkpoints'
import { ApiMessage } from './agent/provider'

export interface SessionRecord {
  /** On-disk schema version; migrated forward on load */
  schemaVersion?: number
  meta: SessionMeta
  items: ChatItem[]
  apiMessages: ApiMessage[]
  allowlist: string[]
  lastPromptTokens?: number
  /** Memory snapshot frozen at first turn — keeps the prompt-cache prefix stable */
  memorySnapshot?: string
  /** Skills index frozen at first turn, same reason */
  skillsSnapshot?: string
  /** Repo AGENTS.md/CLAUDE.md/GROK.md contents frozen at first turn */
  projectDocSnapshot?: string
  /** Git branch frozen at first turn (for the system prompt) */
  gitSnapshot?: string
  /** Rolling summary produced by the background review — searchable */
  digest?: string
  /** Repo map frozen at first turn */
  repoMapSnapshot?: string
  /** File checkpoints, one per user message that caused mutations */
  checkpoints?: Checkpoint[]
  /** Last plan published by the agent via update_plan */
  plan?: PlanStep[]
  /** Files mutated during the latest agent turn (for review panel) */
  lastTurnChanges?: { path: string; kind: 'write' | 'edit' }[]
  /** Team task board + shared brief (set for team-project sessions) */
  teamState?: TeamState
}

/**
 * Bring an on-disk record up to the current schema. Each step is idempotent
 * so re-running the ladder never corrupts data. Add a new `if (v < N)` block
 * for each schema bump.
 */
function migrate(rec: SessionRecord): SessionRecord {
  const v = rec.schemaVersion ?? 0
  if (v < 1) {
    rec.allowlist ??= []
    rec.items ??= []
    rec.apiMessages ??= []
    rec.meta.totalInputTokens ??= 0
    rec.meta.totalOutputTokens ??= 0
    rec.meta.totalCachedTokens ??= 0
  }
  rec.schemaVersion = SCHEMA_VERSION
  return rec
}

class SessionStore {
  private dir!: string
  private cache = new Map<string, SessionRecord>()
  private metas = new Map<string, SessionMeta>()
  private saving = new Map<string, Promise<void>>()

  init(): void {
    this.dir = path.join(app.getPath('userData'), 'sessions')
    fs.mkdirSync(this.dir, { recursive: true })
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as SessionRecord
        if (rec?.meta?.id) this.metas.set(rec.meta.id, rec.meta)
      } catch {
        // Skip corrupt session files rather than failing startup.
      }
    }
  }

  list(): SessionMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  create(opts: { cwd?: string; model?: ModelId; defaultModel: ModelId }): SessionRecord {
    const now = Date.now()
    // cwd must already be validated by the IPC layer (dialog-picked or home).
    const cwd = opts.cwd ?? app.getPath('home')
    const rec: SessionRecord = {
      meta: {
        id: crypto.randomBytes(10).toString('hex'),
        title: 'New session',
        createdAt: now,
        updatedAt: now,
        model: opts.model ?? opts.defaultModel,
        cwd,
        messageCount: 0
      },
      items: [],
      apiMessages: [],
      allowlist: [],
      schemaVersion: SCHEMA_VERSION
    }
    rec.meta.totalInputTokens = 0
    rec.meta.totalOutputTokens = 0
    rec.meta.totalCachedTokens = 0
    this.cache.set(rec.meta.id, rec)
    this.metas.set(rec.meta.id, rec.meta)
    void this.save(rec)
    return rec
  }

  async load(id: string): Promise<SessionRecord | null> {
    // Reject path-traversal style ids before any filesystem join.
    if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/i.test(id)) return null
    const cached = this.cache.get(id)
    if (cached) return cached
    try {
      const rec = migrate(
        JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), 'utf8')) as SessionRecord
      )
      this.cache.set(id, rec)
      this.metas.set(id, rec.meta)
      return rec
    } catch {
      return null
    }
  }

  /** Copy a session's history up to and including itemId into a fresh session. */
  async fork(id: string, itemId: string): Promise<SessionRecord | null> {
    const src = await this.load(id)
    if (!src) return null
    const cutIndex = src.items.findIndex((i) => i.id === itemId)
    if (cutIndex < 0) return null
    const keptItems = src.items.slice(0, cutIndex + 1)

    // Rebuild apiMessages up to the same point by counting user turns.
    const userTurnsKept = keptItems.filter((i) => i.kind === 'user').length
    let seenUserTurns = 0
    let apiCut = src.apiMessages.length
    for (let i = 0; i < src.apiMessages.length; i++) {
      if (src.apiMessages[i].role === 'user') {
        seenUserTurns++
        if (seenUserTurns > userTurnsKept) {
          apiCut = i
          break
        }
      }
    }

    const now = Date.now()
    const rec: SessionRecord = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        ...src.meta,
        id: crypto.randomBytes(10).toString('hex'),
        title: `${src.meta.title} (fork)`,
        createdAt: now,
        updatedAt: now,
        messageCount: keptItems.length
      },
      items: keptItems.map((i) => ({ ...i })),
      apiMessages: src.apiMessages.slice(0, apiCut).map((m) => ({ ...m })),
      allowlist: [...src.allowlist],
      memorySnapshot: src.memorySnapshot,
      skillsSnapshot: src.skillsSnapshot,
      projectDocSnapshot: src.projectDocSnapshot,
      gitSnapshot: src.gitSnapshot,
      digest: src.digest
    }
    this.cache.set(rec.meta.id, rec)
    this.metas.set(rec.meta.id, rec.meta)
    await this.save(rec)
    return rec
  }

  /**
   * Truncate a session at a user message (exclusive) and drop the matching
   * tail of apiMessages, so a turn can be edited-and-resent or retried.
   * Returns the removed user item's text (for edit-resend), or null.
   */
  async truncateAt(id: string, itemId: string): Promise<string | null> {
    const rec = await this.load(id)
    if (!rec) return null
    const idx = rec.items.findIndex((i) => i.id === itemId)
    if (idx < 0 || rec.items[idx].kind !== 'user') return null
    const removedText = (rec.items[idx] as { text: string }).text

    const userTurnsBefore = rec.items.slice(0, idx).filter((i) => i.kind === 'user').length
    let seen = 0
    let apiCut = rec.apiMessages.length
    for (let i = 0; i < rec.apiMessages.length; i++) {
      if (rec.apiMessages[i].role === 'user') {
        if (seen === userTurnsBefore) {
          apiCut = i
          break
        }
        seen++
      }
    }
    rec.items = rec.items.slice(0, idx)
    rec.apiMessages = rec.apiMessages.slice(0, apiCut)
    rec.meta.messageCount = rec.items.length
    await this.save(rec)
    return removedText
  }

  async save(rec: SessionRecord): Promise<void> {
    this.metas.set(rec.meta.id, rec.meta)
    // Serialize writes per session; last write wins.
    const prev = this.saving.get(rec.meta.id) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const file = path.join(this.dir, `${rec.meta.id}.json`)
        const tmp = `${file}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(rec), 'utf8')
        await fsp.rename(tmp, file)
      })
    this.saving.set(rec.meta.id, next)
    return next
  }

  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/i.test(id)) return
    this.cache.delete(id)
    this.metas.delete(id)
    await fsp.rm(path.join(this.dir, `${id}.json`), { force: true })
  }
}

export const sessionStore = new SessionStore()

/** Render a session transcript as portable markdown. */
export function sessionToMarkdown(rec: SessionRecord): string {
  const lines: string[] = [
    `# ${rec.meta.title}`,
    '',
    `- Model: ${rec.meta.model}`,
    `- Workspace: ${rec.meta.cwd}`,
    `- Created: ${new Date(rec.meta.createdAt).toISOString()}`,
    ''
  ]
  for (const item of rec.items) {
    switch (item.kind) {
      case 'user':
        lines.push(`## User`, '', item.text, '')
        break
      case 'assistant':
        lines.push(`## Grok (${item.model})`, '')
        if (item.text) lines.push(item.text, '')
        if (item.citations?.length) {
          lines.push('Sources: ' + item.citations.map((c) => `<${c}>`).join(', '), '')
        }
        break
      case 'tool':
        lines.push(
          `> **${item.name}** \`${JSON.stringify(item.input).slice(0, 200)}\` — ${item.status}`,
          ''
        )
        break
      case 'note':
        lines.push(`_${item.text}_`, '')
        break
      case 'error':
        lines.push(`> ⚠️ ${item.message}`, '')
        break
    }
  }
  return lines.join('\n')
}
