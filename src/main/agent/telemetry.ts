// Lightweight local telemetry that feeds the self-evolution loop:
// - failure log → recurring patterns are fed to the background review so
//   lessons get captured even when the model wouldn't flag them itself
// - approval counts → the permission UI can show how often the user has
//   already approved a given tool key
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_FAILURES = 300
const FAILURE_WINDOW_MS = 14 * 24 * 3600 * 1000

export interface FailureEntry {
  ts: number
  /** 'error' = tool failed, 'denied' = user refused it */
  kind: 'error' | 'denied'
  tool: string
  /** Short normalized detail, e.g. first line of the error */
  detail: string
}

function dir(): string {
  return path.join(app.getPath('userData'), 'telemetry')
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(path.join(dir(), file), JSON.stringify(data), 'utf8')
}

// ------------------------------------------------------------- failures

export function recordFailure(kind: FailureEntry['kind'], tool: string, detail: string): void {
  const entries = readJson<FailureEntry[]>('failures.json', [])
  entries.push({
    ts: Date.now(),
    kind,
    tool,
    detail: detail.split('\n')[0].slice(0, 160)
  })
  writeJson('failures.json', entries.slice(-MAX_FAILURES))
}

/**
 * Summarize recurring failure patterns for the background review.
 * Returns '' when nothing recurs — one-off failures are noise, not lessons.
 */
export function recurringFailures(): string {
  const cutoff = Date.now() - FAILURE_WINDOW_MS
  const entries = readJson<FailureEntry[]>('failures.json', []).filter((e) => e.ts > cutoff)
  const groups = new Map<string, FailureEntry[]>()
  for (const e of entries) {
    // Group by tool + rough shape of the failure, not the exact text.
    const shape = `${e.kind}:${e.tool}:${e.detail.replace(/[0-9]+/g, 'N').slice(0, 60)}`
    const list = groups.get(shape) ?? []
    list.push(e)
    groups.set(shape, list)
  }
  const recurring = [...groups.values()]
    .filter((list) => list.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
  if (!recurring.length) return ''
  return recurring
    .map((list) => {
      const first = list[0]
      const verb = first.kind === 'denied' ? 'was denied by the user' : 'failed'
      return `- ${first.tool} ${verb} ${list.length}× recently, e.g.: ${first.detail}`
    })
    .join('\n')
}

// ------------------------------------------------------------- approvals

export function approvalCount(key: string): number {
  return readJson<Record<string, number>>('approvals.json', {})[key] ?? 0
}

export function bumpApproval(key: string): void {
  const counts = readJson<Record<string, number>>('approvals.json', {})
  counts[key] = (counts[key] ?? 0) + 1
  writeJson('approvals.json', counts)
}
