// Lightweight repository map for system-prompt injection (frozen per session).
import fs from 'node:fs'
import path from 'node:path'

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.cache',
  'coverage',
  '.turbo'
])

const MAX_ENTRIES = 80
const MAX_DEPTH = 3

export function buildRepoMap(cwd: string): string {
  const root = path.resolve(cwd)
  const lines: string[] = []
  const stack: { dir: string; depth: number; rel: string }[] = [{ dir: root, depth: 0, rel: '.' }]

  while (stack.length && lines.length < MAX_ENTRIES) {
    const { dir, depth, rel } = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      if (lines.length >= MAX_ENTRIES) break
      if (e.name.startsWith('.') && e.name !== '.github') continue
      if (SKIP.has(e.name)) continue
      const childRel = rel === '.' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        lines.push(`${childRel}/`)
        if (depth + 1 < MAX_DEPTH) {
          stack.push({ dir: path.join(dir, e.name), depth: depth + 1, rel: childRel })
        }
      } else if (e.isFile()) {
        // Prefer interesting source/config files at top levels
        if (depth <= 1 || /\.(ts|tsx|js|jsx|py|go|rs|java|md|json|yml|yaml|toml)$/i.test(e.name)) {
          lines.push(childRel)
        }
      }
    }
  }

  if (!lines.length) return ''
  return `# Repository map (top-level, truncated)\n${lines.map((l) => `- ${l}`).join('\n')}`
}
