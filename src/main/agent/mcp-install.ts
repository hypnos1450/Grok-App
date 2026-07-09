// MCP server installer — paste a GitHub URL (or npm package) and we figure out
// how to run it as a stdio MCP server, which env secrets it needs, and return a
// draft config for the Settings UI to confirm / fill in.
//
// Detection strategy (in order):
// 1. Known popular packages (hardcoded recipes)
// 2. Repo files: package.json mcp/bin, smithery.yaml, mcp.json, README env hints
// 3. Fallback: npx -y github:owner/repo  (works for many modern MCP servers)
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { McpServerConfig } from '@shared/types'
import { logger } from '../logger'
import { parseGitHubUrl } from './skill-install'

const execFileP = promisify(execFile)
const log = logger('mcp-install')

const MAX_TARBALL_BYTES = 80 * 1024 * 1024

export interface McpEnvNeed {
  key: string
  /** Human hint shown next to the input */
  description?: string
  required: boolean
  /** Placeholder / example value (never a real secret) */
  placeholder?: string
}

export interface McpInstallPreview {
  ok: boolean
  error?: string
  /** Suggested unique server name */
  name?: string
  /** How we plan to launch it */
  command?: string
  args?: string[]
  /** Env keys the user should fill in before enabling */
  envNeeds?: McpEnvNeed[]
  /** Optional notes (runtime, install method, caveats) */
  notes?: string[]
  /** Source label for the UI */
  source?: string
  /** True when this is a pure npm package (no GitHub clone needed) */
  npmPackage?: string
}

export interface McpInstallResult {
  ok: boolean
  error?: string
  server?: McpServerConfig
  /** Env keys still empty after install (user should fill them) */
  missingEnv?: string[]
  notes?: string[]
}

// ---------------------------------------------------------------- known recipes

interface Recipe {
  /** Match GitHub owner/repo (lowercase) or npm package name */
  match: (owner: string, repo: string) => boolean
  name: string
  command: string
  args: string[]
  envNeeds: McpEnvNeed[]
  notes?: string[]
  /** Prefer npm package over github: for npx */
  npm?: string
}

const RECIPES: Recipe[] = [
  {
    match: (_o, r) => r === 'server-github' || r === 'github-mcp-server' || r.includes('github-mcp'),
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envNeeds: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'GitHub personal access token (repo scope for private repos)',
        required: true,
        placeholder: 'ghp_…'
      }
    ],
    notes: [
      'Official GitHub MCP server via npx.',
      'For the modelcontextprotocol/servers monorepo, install a specific package name instead (e.g. @modelcontextprotocol/server-github).'
    ],
    npm: '@modelcontextprotocol/server-github'
  },
  {
    match: (o, r) => r === 'server-filesystem' || r.includes('filesystem-mcp'),
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${WORKSPACE}'],
    envNeeds: [],
    notes: ['Pass one or more allowed directories as args. Default uses the active workspace when available.'],
    npm: '@modelcontextprotocol/server-filesystem'
  },
  {
    match: (o, r) => r === 'server-postgres' || r.includes('postgres-mcp'),
    name: 'postgres',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envNeeds: [
      {
        key: 'POSTGRES_CONNECTION_STRING',
        description: 'Postgres connection URI',
        required: true,
        placeholder: 'postgresql://user:pass@localhost:5432/db'
      }
    ],
    npm: '@modelcontextprotocol/server-postgres'
  },
  {
    match: (o, r) => r === 'server-brave-search' || r.includes('brave-search'),
    name: 'brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envNeeds: [
      {
        key: 'BRAVE_API_KEY',
        description: 'Brave Search API key',
        required: true,
        placeholder: 'BSA…'
      }
    ],
    npm: '@modelcontextprotocol/server-brave-search'
  },
  {
    match: (o, r) => r === 'server-slack' || r.includes('slack-mcp'),
    name: 'slack',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envNeeds: [
      { key: 'SLACK_BOT_TOKEN', description: 'Slack bot token (xoxb-…)', required: true },
      { key: 'SLACK_TEAM_ID', description: 'Slack team / workspace ID', required: true }
    ],
    npm: '@modelcontextprotocol/server-slack'
  },
  {
    match: (o, r) => r === 'server-google-maps' || r.includes('google-maps'),
    name: 'google-maps',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    envNeeds: [
      { key: 'GOOGLE_MAPS_API_KEY', description: 'Google Maps API key', required: true }
    ],
    npm: '@modelcontextprotocol/server-google-maps'
  },
  {
    match: (o, r) => r.includes('puppeteer') && (o === 'modelcontextprotocol' || r.includes('mcp')),
    name: 'puppeteer',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envNeeds: [],
    notes: ['Launches a headless browser. First run may download Chromium.'],
    npm: '@modelcontextprotocol/server-puppeteer'
  },
  {
    match: (o, r) => r.includes('sqlite') && o === 'modelcontextprotocol',
    name: 'sqlite',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '${DB_PATH}'],
    envNeeds: [],
    notes: ['Pass the path to a .sqlite / .db file as the last arg.'],
    npm: '@modelcontextprotocol/server-sqlite'
  },
  {
    match: (o, r) => r.includes('memory') && o === 'modelcontextprotocol',
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envNeeds: [],
    npm: '@modelcontextprotocol/server-memory'
  },
  {
    match: (o, r) => r.includes('sequential-thinking') || r.includes('sequentialthinking'),
    name: 'sequential-thinking',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envNeeds: [],
    npm: '@modelcontextprotocol/server-sequential-thinking'
  },
  {
    match: (_o, r) => r.includes('firecrawl'),
    name: 'firecrawl',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    envNeeds: [
      { key: 'FIRECRAWL_API_KEY', description: 'Firecrawl API key', required: true }
    ],
    npm: 'firecrawl-mcp'
  },
  {
    match: (_o, r) => r.includes('browserbase') || r.includes('stagehand'),
    name: 'browserbase',
    command: 'npx',
    args: ['-y', '@browserbasehq/mcp-server-browserbase'],
    envNeeds: [
      { key: 'BROWSERBASE_API_KEY', required: true },
      { key: 'BROWSERBASE_PROJECT_ID', required: true }
    ]
  },
  {
    match: (_o, r) => r.includes('supabase') && r.includes('mcp'),
    name: 'supabase',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase'],
    envNeeds: [
      {
        key: 'SUPABASE_ACCESS_TOKEN',
        description: 'Supabase personal access token',
        required: true
      }
    ]
  },
  {
    match: (_o, r) => r.includes('notion') && (r.includes('mcp') || r.includes('server')),
    name: 'notion',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envNeeds: [
      { key: 'NOTION_TOKEN', description: 'Notion integration token', required: true, placeholder: 'ntn_…' }
    ]
  },
  {
    match: (_o, r) => r.includes('linear') && r.includes('mcp'),
    name: 'linear',
    command: 'npx',
    args: ['-y', 'linear-mcp-server'],
    envNeeds: [{ key: 'LINEAR_API_KEY', required: true }]
  },
  {
    match: (_o, r) => r.includes('sentry') && r.includes('mcp'),
    name: 'sentry',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    envNeeds: [{ key: 'SENTRY_ACCESS_TOKEN', required: true }]
  }
]

// ---------------------------------------------------------------- helpers

function slugName(s: string): string {
  return s
    .toLowerCase()
    .replace(/@/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(server|mcp)-/, '')
    .slice(0, 40) || 'mcp-server'
}

/** Scan text for likely env var names (API keys, tokens, secrets). */
function extractEnvNeeds(text: string): McpEnvNeed[] {
  const found = new Map<string, McpEnvNeed>()
  // Explicit env documentation patterns
  const patterns = [
    // KEY= or export KEY= or process.env.KEY or $KEY
    /\b([A-Z][A-Z0-9_]{2,})\s*=\s*["']?(?:your|xxx|changeme|<|\$\{)?/g,
    /\b(?:export|env|ENV)\s+([A-Z][A-Z0-9_]{2,})\b/g,
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g,
    /(?:required|set|needs?|provide)\s+(?:the\s+)?`?([A-Z][A-Z0-9_]{2,})`?/gi,
    /env(?:ironment)?\s+var(?:iable)?s?[^\n]{0,40}\b([A-Z][A-Z0-9_]{2,})\b/gi
  ]
  const skip = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_ENV',
    'PWD',
    'LANG',
    'TERM',
    'OS',
    'HOSTNAME',
    'HTTP',
    'HTTPS',
    'URL',
    'URI',
    'JSON',
    'TRUE',
    'FALSE',
    'NULL',
    'TODO',
    'NOTE',
    'README',
    'LICENSE',
    'UTF',
    'ASCII',
    'MCP',
    'STDIO',
    'SSE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'NODE_OPTIONS',
    'DEBUG',
    'LOG_LEVEL',
    'PORT',
    'HOST',
    'VERSION',
    'NAME',
    'TYPE',
    'ARGS',
    'CMD',
    'COMMAND'
  ])
  const secretHint = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|BEARER)/i

  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const key = m[1]
      if (!key || skip.has(key) || key.length < 4) continue
      // Prefer secrets; also keep clearly named config like DATABASE_URL
      const looksSecret = secretHint.test(key)
      const looksConfig = /(?:URL|URI|DSN|ENDPOINT|HOST|DATABASE|PROJECT|ORG|TEAM|WORKSPACE|BUCKET|REGION|ID)$/i.test(
        key
      )
      if (!looksSecret && !looksConfig) continue
      if (!found.has(key)) {
        found.set(key, {
          key,
          required: looksSecret || /DATABASE|CONNECTION/i.test(key),
          description: looksSecret ? 'Secret required by this server' : 'Configuration value'
        })
      }
    }
  }
  return [...found.values()].slice(0, 12)
}

async function downloadTarball(
  owner: string,
  repo: string,
  ref: string | undefined,
  dest: string
): Promise<void> {
  const r = ref ?? 'HEAD'
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(r)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'grok-harness' } })
  if (res.status === 404) {
    throw new Error('Repository or branch not found — check the URL (private repos need a token-based install).')
  }
  if (!res.ok) throw new Error(`GitHub download failed (HTTP ${res.status}).`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('Empty response from GitHub.')
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_TARBALL_BYTES) {
      await reader.cancel()
      throw new Error('Repository archive too large.')
    }
    chunks.push(Buffer.from(value))
  }
  fs.writeFileSync(dest, Buffer.concat(chunks))
}

function readIfExists(p: string, max = 200_000): string {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > max) return ''
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function findReadme(dir: string): string {
  for (const name of ['README.md', 'readme.md', 'README', 'Readme.md']) {
    const t = readIfExists(path.join(dir, name), 400_000)
    if (t) return t
  }
  return ''
}

interface Detected {
  name: string
  command: string
  args: string[]
  envNeeds: McpEnvNeed[]
  notes: string[]
  source: string
  npmPackage?: string
}

function detectFromPackageJson(
  pkgRaw: string,
  owner: string,
  repo: string
): Partial<Detected> | null {
  try {
    const pkg = JSON.parse(pkgRaw) as {
      name?: string
      bin?: string | Record<string, string>
      scripts?: Record<string, string>
      mcpName?: string
      main?: string
    }
    const notes: string[] = []
    const npmName = pkg.name
    // Prefer published package name for npx
    if (npmName && !npmName.startsWith('file:')) {
      return {
        name: slugName(npmName.replace(/^@[^/]+\//, '')),
        command: 'npx',
        args: ['-y', npmName],
        notes: [`Detected npm package \`${npmName}\` — will run via npx.`],
        source: `npm:${npmName}`,
        npmPackage: npmName
      }
    }
    // Local bin entry
    if (pkg.bin) {
      const binPath = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]
      if (binPath) {
        notes.push('Package has a bin entry; using npx against the GitHub repo.')
        return {
          name: slugName(repo),
          command: 'npx',
          args: ['-y', `github:${owner}/${repo}`],
          notes,
          source: `github:${owner}/${repo}`
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

function detectFromSmithery(raw: string): Partial<Detected> | null {
  // Very light YAML scrape — we only need startCommand / command / env
  const notes: string[] = ['Found smithery.yaml']
  const cmd =
    /(?:command|cmd):\s*["']?([^\n"']+)/i.exec(raw)?.[1]?.trim() ||
    /npx[^\n]+/i.exec(raw)?.[0]?.trim()
  if (!cmd) return null
  const parts = cmd.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  return {
    command: parts[0],
    args: parts.slice(1),
    notes
  }
}

function detectFromMcpJson(raw: string): Partial<Detected> | null {
  try {
    const j = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
      command?: string
      args?: string[]
      env?: Record<string, string>
    }
    // Cursor/Claude-style multi-server file — take the first entry
    if (j.mcpServers) {
      const [name, cfg] = Object.entries(j.mcpServers)[0] ?? []
      if (name && cfg?.command) {
        const envNeeds = Object.keys(cfg.env ?? {}).map((key) => ({
          key,
          required: true,
          description: 'From mcp.json'
        }))
        return {
          name: slugName(name),
          command: cfg.command,
          args: cfg.args ?? [],
          envNeeds,
          notes: ['Detected mcp.json server definition.'],
          source: 'mcp.json'
        }
      }
    }
    if (j.command) {
      return {
        command: j.command,
        args: j.args ?? [],
        envNeeds: Object.keys(j.env ?? {}).map((key) => ({
          key,
          required: true
        })),
        notes: ['Detected mcp.json'],
        source: 'mcp.json'
      }
    }
  } catch {
    // ignore
  }
  return null
}

// ---------------------------------------------------------------- public API

/**
 * Inspect a GitHub URL / owner/repo / npm package and return a preview the UI
 * can show before the user commits (and fills secrets).
 */
export async function previewMcpInstall(input: string): Promise<McpInstallPreview> {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'Paste a GitHub URL, owner/repo, or npm package name.' }

  // Scoped npm package without a full URL: @scope/name
  if (/^@[\w.-]+\/[\w.-]+$/.test(raw)) {
    const name = slugName(raw.replace(/^@[^/]+\//, ''))
    return {
      ok: true,
      name,
      command: 'npx',
      args: ['-y', raw],
      envNeeds: [],
      notes: [
        `Will run \`npx -y ${raw}\` as a stdio MCP server.`,
        'If the package needs API keys, add them after install.'
      ],
      source: `npm:${raw}`,
      npmPackage: raw
    }
  }

  // npm: prefix
  if (raw.startsWith('npm:')) {
    const pkg = raw.slice(4).trim()
    if (!pkg) return { ok: false, error: 'npm: package name is empty.' }
    return {
      ok: true,
      name: slugName(pkg.replace(/^@[^/]+\//, '')),
      command: 'npx',
      args: ['-y', pkg],
      envNeeds: [],
      notes: [`Will run \`npx -y ${pkg}\`.`],
      source: `npm:${pkg}`,
      npmPackage: pkg
    }
  }

  const gh = parseGitHubUrl(raw)
  // Also accept plain npm names without scope when they look like mcp packages
  if (!gh) {
    if (/^(mcp-|.*-mcp)[\w-]*$/i.test(raw) || raw.startsWith('@')) {
      return {
        ok: true,
        name: slugName(raw.replace(/^@[^/]+\//, '')),
        command: 'npx',
        args: ['-y', raw],
        envNeeds: [],
        notes: [`Treating as npm package: npx -y ${raw}`],
        source: `npm:${raw}`,
        npmPackage: raw
      }
    }
    return {
      ok: false,
      error: 'Enter a GitHub URL (or owner/repo), or an npm package (e.g. @modelcontextprotocol/server-github).'
    }
  }

  const owner = gh.owner.toLowerCase()
  const repo = gh.repo.replace(/\.git$/, '').toLowerCase()

  // Known recipes first (fast path, no download)
  for (const recipe of RECIPES) {
    if (!recipe.match(owner, repo)) continue
    return {
      ok: true,
      name: recipe.name,
      command: recipe.command,
      args: recipe.args.filter((a) => a !== '${WORKSPACE}' && a !== '${DB_PATH}'),
      envNeeds: recipe.envNeeds,
      notes: recipe.notes ?? [`Matched known server recipe for ${owner}/${repo}.`],
      source: recipe.npm ? `npm:${recipe.npm}` : `github:${owner}/${repo}`,
      npmPackage: recipe.npm
    }
  }

  // Download and inspect the repo
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mcp-'))
  try {
    const tarPath = path.join(tmp, 'repo.tgz')
    await downloadTarball(gh.owner, gh.repo, gh.ref, tarPath)
    const extractDir = path.join(tmp, 'x')
    fs.mkdirSync(extractDir)
    await execFileP('tar', ['-xzf', tarPath, '-C', extractDir])
    const top = fs.readdirSync(extractDir)[0]
    if (!top) throw new Error('Downloaded archive was empty.')
    const sub = gh.path && !gh.isFile ? gh.path : ''
    const rootDir = path.join(extractDir, top, sub)
    if (!fs.existsSync(rootDir)) {
      return { ok: false, error: `Path "${sub}" not found in the repository.` }
    }

    const pkgRaw = readIfExists(path.join(rootDir, 'package.json'))
    const smithery = readIfExists(path.join(rootDir, 'smithery.yaml'))
    const mcpJson =
      readIfExists(path.join(rootDir, 'mcp.json')) ||
      readIfExists(path.join(rootDir, '.mcp.json')) ||
      readIfExists(path.join(rootDir, 'mcp-server.json'))
    const readme = findReadme(rootDir)

    let detected: Detected = {
      name: slugName(repo),
      command: 'npx',
      args: ['-y', `github:${gh.owner}/${gh.repo}`],
      envNeeds: [],
      notes: [],
      source: `github:${gh.owner}/${gh.repo}`
    }

    const fromMcp = mcpJson ? detectFromMcpJson(mcpJson) : null
    const fromPkg = pkgRaw ? detectFromPackageJson(pkgRaw, gh.owner, gh.repo) : null
    const fromSmithery = smithery ? detectFromSmithery(smithery) : null

    const pick = fromMcp ?? fromPkg ?? fromSmithery
    if (pick) {
      detected = {
        ...detected,
        ...pick,
        envNeeds: pick.envNeeds ?? detected.envNeeds,
        notes: [...(pick.notes ?? []), ...detected.notes]
      }
    } else if (!pkgRaw) {
      // Python / other
      const pyproject = readIfExists(path.join(rootDir, 'pyproject.toml'))
      const requirements = readIfExists(path.join(rootDir, 'requirements.txt'))
      if (pyproject || requirements) {
        detected = {
          name: slugName(repo),
          command: 'uvx',
          args: [`--from`, `git+https://github.com/${gh.owner}/${gh.repo}`, slugName(repo)],
          envNeeds: [],
          notes: [
            'Looks like a Python project. Trying `uvx` (install uv if missing).',
            'You may need to adjust the command after install — check the README.'
          ],
          source: `github:${gh.owner}/${gh.repo}`
        }
      } else {
        detected.notes.push(
          'Could not auto-detect a start command; defaulting to `npx -y github:owner/repo`.',
          'Edit the command if the README specifies something else.'
        )
      }
    }

    // Merge env needs from README + package text
    const blob = [readme, pkgRaw, smithery, mcpJson].join('\n')
    const fromText = extractEnvNeeds(blob)
    const byKey = new Map<string, McpEnvNeed>()
    for (const e of [...(detected.envNeeds ?? []), ...fromText]) {
      if (!byKey.has(e.key)) byKey.set(e.key, e)
    }
    detected.envNeeds = [...byKey.values()]

    if (detected.envNeeds.length) {
      detected.notes.push(
        `This server looks like it needs: ${detected.envNeeds.map((e) => e.key).join(', ')}.`
      )
    }

    return {
      ok: true,
      name: detected.name,
      command: detected.command,
      args: detected.args,
      envNeeds: detected.envNeeds,
      notes: detected.notes,
      source: detected.source,
      npmPackage: detected.npmPackage
    }
  } catch (err) {
    log.warn(`preview failed for ${raw}: ${err instanceof Error ? err.message : err}`)
    // Soft fallback — still offer github: npx install
    return {
      ok: true,
      name: slugName(repo),
      command: 'npx',
      args: ['-y', `github:${gh.owner}/${gh.repo}`],
      envNeeds: [],
      notes: [
        `Could not fully inspect the repo (${err instanceof Error ? err.message : err}).`,
        'Defaulting to `npx -y github:owner/repo` — edit if needed after install.'
      ],
      source: `github:${gh.owner}/${gh.repo}`
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Finalize install: merge user-provided env into a McpServerConfig.
 * Does not connect — caller adds to settings and triggers mcpManager.sync.
 */
export function finalizeMcpInstall(
  preview: McpInstallPreview,
  opts: {
    name?: string
    env?: Record<string, string>
    /** Extra args appended (e.g. filesystem paths) */
    extraArgs?: string[]
  } = {}
): McpInstallResult {
  if (!preview.ok || !preview.command) {
    return { ok: false, error: preview.error ?? 'Nothing to install.' }
  }
  const name = slugName(opts.name || preview.name || 'mcp-server')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v.trim()) env[k] = v.trim()
  }
  const missingEnv = (preview.envNeeds ?? [])
    .filter((e) => e.required && !env[e.key])
    .map((e) => e.key)

  const args = [...(preview.args ?? []), ...(opts.extraArgs ?? [])]
  const server: McpServerConfig = {
    name,
    command: preview.command,
    args,
    ...(Object.keys(env).length ? { env } : {}),
    ...(preview.source ? { source: preview.source } : {}),
    // Enable even if secrets missing — connection will fail with a clear error
    // until the user fills them; keeps the row visible in Settings.
    enabled: true
  }

  const notes = [...(preview.notes ?? [])]
  if (missingEnv.length) {
    notes.push(
      `Still need: ${missingEnv.join(', ')}. Add them under this server's env and reconnect.`
    )
  }

  return {
    ok: true,
    server,
    missingEnv: missingEnv.length ? missingEnv : undefined,
    notes
  }
}

/** One-shot: preview + finalize for simple cases (no interactive secrets). */
export async function installMcpFromInput(
  input: string,
  opts: { name?: string; env?: Record<string, string>; extraArgs?: string[] } = {}
): Promise<McpInstallResult & { preview?: McpInstallPreview }> {
  const preview = await previewMcpInstall(input)
  if (!preview.ok) return { ok: false, error: preview.error, preview }
  const result = finalizeMcpInstall(preview, opts)
  return { ...result, preview }
}
