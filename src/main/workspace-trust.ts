// Workspace trust: first-open gate before agent tools run.
import path from 'node:path'
import fs from 'node:fs'
import { WorkspaceTrustState } from '@shared/types'

function norm(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd))
  } catch {
    return path.resolve(cwd)
  }
}

export function getTrust(cwd: string, trusted: string[]): WorkspaceTrustState {
  const abs = norm(cwd)
  const hit = trusted.some((t) => {
    const tt = norm(t)
    return abs === tt || abs.startsWith(tt + path.sep)
  })
  return { cwd: abs, level: hit ? 'trusted' : 'untrusted' }
}

export function isTrusted(cwd: string, trusted: string[], requireTrust: boolean): boolean {
  if (!requireTrust) return true
  return getTrust(cwd, trusted).level === 'trusted'
}

export function addTrust(cwd: string, trusted: string[]): string[] {
  const abs = norm(cwd)
  if (trusted.some((t) => norm(t) === abs)) return trusted
  return [...trusted, abs].slice(0, 200)
}

export function removeTrust(cwd: string, trusted: string[]): string[] {
  const abs = norm(cwd)
  return trusted.filter((t) => norm(t) !== abs)
}
