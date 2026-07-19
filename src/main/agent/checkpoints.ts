// File checkpoints: before the agent's file tools mutate a file for the
// first time in a run, the original is copied aside so the user can rewind
// everything a message caused. (Limitation: bash-driven mutations are not
// captured — only the file tools: apply_patch / write_file.)
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SessionRecord } from '../sessions'

export interface CheckpointFile {
  /** Absolute path that was (about to be) mutated */
  path: string
  /** Backup filename inside the checkpoint dir, or null if the file didn't exist */
  backup: string | null
}

export interface Checkpoint {
  /** Matches the id of the user message that started the run */
  id: string
  ts: number
  files: CheckpointFile[]
}

function checkpointDir(sessionId: string, checkpointId: string): string {
  return path.join(app.getPath('userData'), 'checkpoints', sessionId, checkpointId)
}

/** Record the original state of a file, once per file per checkpoint. */
export async function recordOriginal(
  session: SessionRecord,
  checkpointId: string,
  absPath: string
): Promise<void> {
  session.checkpoints ??= []
  let cp = session.checkpoints.find((c) => c.id === checkpointId)
  if (!cp) {
    cp = { id: checkpointId, ts: Date.now(), files: [] }
    session.checkpoints.push(cp)
  }
  if (cp.files.some((f) => f.path === absPath)) return

  if (fs.existsSync(absPath)) {
    const dir = checkpointDir(session.meta.id, checkpointId)
    await fsp.mkdir(dir, { recursive: true })
    const backup = `${crypto.randomBytes(6).toString('hex')}.bak`
    await fsp.copyFile(absPath, path.join(dir, backup))
    cp.files.push({ path: absPath, backup })
  } else {
    cp.files.push({ path: absPath, backup: null })
  }
}

/**
 * Restore the workspace to the state before the given checkpoint by applying
 * it and every later checkpoint, newest first. Returns files touched.
 */
export async function restoreCheckpoint(
  session: SessionRecord,
  checkpointId: string
): Promise<number> {
  const all = session.checkpoints ?? []
  const target = all.find((c) => c.id === checkpointId)
  if (!target) return 0

  const toApply = all.filter((c) => c.ts >= target.ts).sort((x, y) => y.ts - x.ts)
  const restored = new Set<string>()
  for (const cp of toApply) {
    for (const f of cp.files) {
      try {
        if (f.backup) {
          await fsp.mkdir(path.dirname(f.path), { recursive: true })
          await fsp.copyFile(path.join(checkpointDir(session.meta.id, cp.id), f.backup), f.path)
        } else {
          await fsp.rm(f.path, { force: true })
        }
        restored.add(f.path)
      } catch {
        // Keep restoring the rest even if one file fails.
      }
    }
  }
  // Applied checkpoints are consumed — the workspace no longer reflects them.
  session.checkpoints = all.filter((c) => c.ts < target.ts)
  return restored.size
}
