// Append-only security audit log under userData/audit.jsonl
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AuditEvent, AuditEventKind } from '@shared/types'

const MAX_EVENTS = 2000

function auditPath(): string {
  return path.join(app.getPath('userData'), 'audit.jsonl')
}

export function appendAudit(
  kind: AuditEventKind,
  summary: string,
  opts?: { sessionId?: string; detail?: string }
): void {
  try {
    const ev: AuditEvent = {
      id: crypto.randomBytes(8).toString('hex'),
      ts: Date.now(),
      kind,
      summary: summary.slice(0, 500),
      sessionId: opts?.sessionId,
      detail: opts?.detail?.slice(0, 2000)
    }
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true })
    fs.appendFileSync(auditPath(), JSON.stringify(ev) + '\n', 'utf8')
  } catch {
    // never break the app for logging
  }
}

export function listAudit(limit = 200): AuditEvent[] {
  try {
    const raw = fs.readFileSync(auditPath(), 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const slice = lines.slice(-Math.min(Math.max(limit, 1), MAX_EVENTS))
    const out: AuditEvent[] = []
    for (const line of slice.reverse()) {
      try {
        out.push(JSON.parse(line) as AuditEvent)
      } catch {
        /* skip */
      }
    }
    return out
  } catch {
    return []
  }
}

export function clearAudit(): void {
  try {
    fs.rmSync(auditPath(), { force: true })
  } catch {
    /* ignore */
  }
}

export function exportAuditMarkdown(): string {
  const events = listAudit(500)
  const lines = ['# Grok Harness security audit', '', `Exported: ${new Date().toISOString()}`, '']
  for (const e of events) {
    lines.push(
      `- **${new Date(e.ts).toISOString()}** · ${e.kind}${e.sessionId ? ` · session ${e.sessionId.slice(0, 8)}` : ''}: ${e.summary}`
    )
    if (e.detail) lines.push(`  - ${e.detail}`)
  }
  return lines.join('\n')
}
