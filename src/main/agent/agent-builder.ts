// AI agent builder: turn a natural-language brief ("an agent that reviews my
// Rust for concurrency bugs") into a ready-to-save custom agent — a name, role
// instructions, a model + permission mode, and a plan of the skills it needs.
// Skills the user already has are matched to the role; gaps are filled from the
// curated skill catalog or, when nothing fits, by searching the web for an
// installable SKILL.md. Skill installs reuse installFromGitHub, so they get the
// same validation and prompt-injection scanning as any other import.
import {
  AgentBuildResult,
  AgentBuildSkill,
  ModelId,
  PermissionMode,
  Settings
} from '@shared/types'
import { logger } from '../logger'
import { findCatalogSkill, SKILL_CATALOG } from '../skill-catalog'
import { profileFor } from './profiles'
import { streamCompletion } from './provider'
import { installFromGitHub } from './skill-install'
import { skillStore } from './skills'

const log = logger('agent-builder')

const MODEL_IDS: ModelId[] = ['grok-build-0.1', 'grok-4.3']
const PERMISSION_MODES: PermissionMode[] = ['ask', 'auto-edit', 'full-auto', 'plan-only']
const MAX_REQUIRED = 8
const MAX_SUGGESTED = 6

// ------------------------------------------------------------- design phase

const DESIGN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    instructions: { type: 'string' },
    model: { type: 'string', enum: MODEL_IDS },
    permissionMode: { type: 'string', enum: PERMISSION_MODES },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          capability: { type: 'string' },
          reason: { type: 'string' },
          // true = a domain/stack suggestion the user opts into; false = needed.
          optional: { type: 'boolean' },
          // Exactly one of these should be non-null (installed > catalog > search).
          installedSkill: { type: ['string', 'null'] },
          catalogId: { type: ['string', 'null'] },
          searchQuery: { type: ['string', 'null'] }
        },
        required: ['capability', 'reason', 'optional', 'installedSkill', 'catalogId', 'searchQuery'],
        additionalProperties: false
      }
    }
  },
  required: ['name', 'instructions', 'model', 'permissionMode', 'skills'],
  additionalProperties: false
}

export interface DesignSkill {
  capability: string
  reason: string
  optional: boolean
  installedSkill: string | null
  catalogId: string | null
  searchQuery: string | null
}

function designPrompt(installed: { name: string; description: string }[]): string {
  const installedList = installed.length
    ? installed.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : '(none installed yet)'
  const catalogList = SKILL_CATALOG.map((c) => `- ${c.id}: ${c.name} — ${c.description}`).join('\n')
  return `You design a specialized agent persona for a coding assistant from the user's brief. Return JSON matching the schema.

- name: a short title (2-4 words), e.g. "Rust Concurrency Reviewer".
- instructions: the agent's role and behavior, written as a direct system-prompt directive to the agent (second person: "You review…"). Cover what it focuses on, how it should work, and what to prioritize or avoid. 2-6 sentences, concrete, no preamble.
- model: "grok-build-0.1" (Grok 4.5, agentic coding, faster — the default) unless the brief is dominated by deep reasoning/architecture, then "grok-4.3".
- permissionMode: "ask" (default), "auto-edit" (auto-approve edits, ask for commands), "full-auto", or "plan-only" (read/plan, never mutate — good for reviewers/auditors).
- skills: capabilities relevant to THIS agent, in two tiers via the "optional" flag:
  - REQUIRED (optional=false): a specialized capability the agent genuinely needs beyond ordinary coding — document formats, a niche framework workflow, a domain procedure. Ordinary reading/editing/running/reviewing code needs NO required skill, so this list is often empty.
  - SUGGESTED (optional=true): up to ${MAX_SUGGESTED} skills that would plausibly HELP an agent with this brief's domain, stack, or languages, even if not strictly required — e.g. language/framework best-practice, review, testing, security, or workflow skills for the technologies named (Rust, Go, Electron, React, Terraform, …). ALWAYS propose several suggested skills whenever the brief names any technology, language, framework, or domain, EVEN IF there are zero required skills. These are opt-in — the user decides which to install. Do not suggest a skill for plain general-purpose coding with no named stack.
  For EACH skill set "optional" (true=suggested, false=required) and exactly ONE of:
  - installedSkill: the exact name of an already-installed skill that covers it (prefer this when one fits),
  - catalogId: the id of a catalog skill that covers it,
  - searchQuery: a short web-search query to find an installable skill (e.g. "rust concurrency best practices agent skill", "electron security skill"), when neither of the above fits — this is the usual case for suggested stack skills.
  Leave the other two null. Do not invent installed-skill names or catalog ids.

Installed skills:
${installedList}

Catalog skills:
${catalogList}`
}

/** Draft an agent from a natural-language brief. Throws on API/parse failure. */
export async function buildAgentDraft(prompt: string, settings: Settings): Promise<AgentBuildResult> {
  const brief = String(prompt ?? '').trim().slice(0, 4000)
  if (!brief) throw new Error('Describe the agent you want first.')
  const installed = skillStore.list().map((s) => ({ name: s.name, description: s.description }))
  // Design quality matters more than latency here; use the user's default model.
  const profile = profileFor(settings.defaultModel)
  const result = await streamCompletion({
    model: profile.apiModel,
    reasoningEffort: profile.supportsReasoningEffort ? 'low' : undefined,
    jsonSchema: { name: 'agent_design', schema: DESIGN_SCHEMA },
    messages: [
      { role: 'system', content: designPrompt(installed) },
      { role: 'user', content: brief }
    ],
    maxOutputTokens: 2048,
    temperature: 0.4
  })
  let parsed: {
    name: string
    instructions: string
    model: string
    permissionMode: string
    skills: DesignSkill[]
  }
  try {
    parsed = JSON.parse(result.content)
  } catch {
    throw new Error('The model returned an unreadable design — try rephrasing the brief.')
  }

  const installedNames = new Set(installed.map((s) => s.name))
  const raw = parsed.skills ?? []
  // Required first, then suggested — each capped independently, deduped by ref so
  // the same skill can't appear in both tiers.
  const skills: AgentBuildSkill[] = []
  const seen = new Set<string>()
  const take = (want: boolean, cap: number): void => {
    let n = 0
    for (const s of raw) {
      if (n >= cap) break
      if (!!s.optional !== want) continue
      const item = classifySkill(s, installedNames)
      if (!item) continue
      const key = `${item.status}:${item.ref.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(item)
      n++
    }
  }
  take(false, MAX_REQUIRED)
  take(true, MAX_SUGGESTED)

  return {
    name: (parsed.name || 'New agent').trim().slice(0, 60),
    instructions: (parsed.instructions || '').trim().slice(0, 8000),
    model: MODEL_IDS.includes(parsed.model as ModelId)
      ? (parsed.model as ModelId)
      : settings.defaultModel,
    permissionMode: PERMISSION_MODES.includes(parsed.permissionMode as PermissionMode)
      ? (parsed.permissionMode as PermissionMode)
      : 'ask',
    skills
  }
}

/** Turn a raw design skill into a plan item, dropping ones we can't satisfy. */
export function classifySkill(s: DesignSkill, installedNames: Set<string>): AgentBuildSkill | null {
  const capability = String(s.capability ?? '').trim().slice(0, 80)
  const reason = String(s.reason ?? '').trim().slice(0, 200)
  const optional = !!s.optional
  if (!capability) return null
  if (s.installedSkill && installedNames.has(s.installedSkill)) {
    return { capability, reason, optional, status: 'installed', ref: s.installedSkill }
  }
  if (s.catalogId) {
    const entry = findCatalogSkill(s.catalogId)
    if (entry) {
      return { capability, reason, optional, status: 'catalog', ref: entry.id, install: entry.install }
    }
  }
  if (s.searchQuery && s.searchQuery.trim()) {
    return { capability, reason, optional, status: 'search', ref: s.searchQuery.trim().slice(0, 120) }
  }
  return null
}

// ---------------------------------------------------- resolve (install) phase

const SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: ['string', 'null'] }
  },
  required: ['url'],
  additionalProperties: false
}

/** Skill-name tokens the importer put in ImportReport.installed ("pdf (+3 files) [docs]"). */
export function namesFromReport(installed: string[]): string[] {
  return installed
    .map((e) => /^([a-z0-9][a-z0-9-]*)/.exec(e)?.[1])
    .filter((n): n is string => !!n)
}

/** Ask the model (with web search) for a GitHub URL of an installable skill. */
async function findSkillUrl(query: string, settings: Settings): Promise<string | null> {
  const profile = profileFor(settings.defaultModel)
  try {
    const res = await streamCompletion({
      model: profile.apiModel,
      reasoningEffort: profile.supportsReasoningEffort ? 'low' : undefined,
      serverTools: true,
      jsonSchema: { name: 'skill_source', schema: SEARCH_SCHEMA },
      messages: [
        {
          role: 'system',
          content:
            'Find a public GitHub repository or folder that contains an installable Claude/Agent skill (a SKILL.md file) for the requested capability. Use web search. Return JSON with "url" set to the github.com repo or tree/blob URL of the skill (a folder containing SKILL.md, or a repo whose skills live under it), or null if you cannot find a real one. Never invent a URL — only return one you found.'
        },
        { role: 'user', content: query.slice(0, 200) }
      ],
      maxOutputTokens: 1024,
      temperature: 0
    })
    const parsed = JSON.parse(res.content) as { url: string | null }
    const url = parsed.url?.trim()
    if (!url) return null
    return /^https?:\/\/(www\.)?github\.com\//i.test(url) ? url : null
  } catch (err) {
    log.info(`skill search failed for "${query}": ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/**
 * Install the catalog / web-searched skills in a build plan. `installed` items
 * pass through untouched. Returns the same items annotated with installedNames
 * (skills now available) or an error.
 */
export async function resolveSkills(
  items: AgentBuildSkill[],
  settings: Settings
): Promise<AgentBuildSkill[]> {
  const out: AgentBuildSkill[] = []
  for (const item of items ?? []) {
    if (item.status === 'installed') {
      out.push({ ...item, installedNames: [item.ref] })
      continue
    }
    // Determine the install source: catalog items carry it; search items resolve now.
    let source = item.install
    if (item.status === 'search' && !source) {
      source = (await findSkillUrl(item.ref, settings)) ?? undefined
      if (!source) {
        out.push({ ...item, error: 'No installable skill found for this capability.' })
        continue
      }
    }
    if (!source) {
      out.push({ ...item, error: 'No install source.' })
      continue
    }
    try {
      const report = await installFromGitHub(source)
      const names = namesFromReport(report.installed)
      if (names.length) {
        out.push({ ...item, install: source, installedNames: names })
      } else {
        out.push({
          ...item,
          install: source,
          error: report.errors[0] ?? 'Nothing was installed from that source.'
        })
      }
    } catch (err) {
      out.push({ ...item, install: source, error: err instanceof Error ? err.message : String(err) })
    }
  }
  log.info(`resolveSkills: ${out.filter((i) => i.installedNames?.length).length}/${out.length} satisfied`)
  return out
}
