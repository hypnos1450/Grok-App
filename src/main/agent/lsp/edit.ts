// Apply an LSP WorkspaceEdit (from rename / code actions) to files on disk,
// jailed to the workspace and routed through the checkpoint hook. The text
// manipulation is split into pure functions so it can be unit-tested without a
// language server or the filesystem.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInWorkspace } from '../../security'
import { LspPosition, LspTextEdit, LspWorkspaceEdit } from './client'

export interface NormalizedFileEdit {
  uri: string
  edits: LspTextEdit[]
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Flatten a WorkspaceEdit's `changes` / `documentChanges` encodings into a flat
 * list of per-file edits. `resourceOps` collects any create/rename/delete-file
 * operations, which we surface but never apply (renaming files is out of scope
 * and risky to do silently).
 */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): {
  files: NormalizedFileEdit[]
  resourceOps: string[]
} {
  const files: NormalizedFileEdit[] = []
  const resourceOps: string[] = []
  if (edit.documentChanges?.length) {
    for (const dc of edit.documentChanges) {
      if (dc && 'kind' in dc && typeof dc.kind === 'string') {
        resourceOps.push(dc.kind)
        continue
      }
      const tde = dc as { textDocument?: { uri?: string }; edits?: LspTextEdit[] }
      if (tde.textDocument?.uri && Array.isArray(tde.edits)) {
        files.push({ uri: tde.textDocument.uri, edits: tde.edits })
      }
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (Array.isArray(edits)) files.push({ uri, edits })
    }
  }
  return { files, resourceOps }
}

/**
 * Per-line offsets, honoring \n, \r\n, and lone \r. `starts[i]` is where line i
 * begins; `contentEnds[i]` is where its text ends (i.e. before the terminator).
 */
function lineIndex(text: string): { starts: number[]; contentEnds: number[] } {
  const starts = [0]
  const contentEnds: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) {
      contentEnds.push(i)
      starts.push(i + 1)
    } else if (c === 13) {
      contentEnds.push(i)
      if (text.charCodeAt(i + 1) === 10) {
        starts.push(i + 2)
        i++
      } else starts.push(i + 1)
    }
  }
  contentEnds.push(text.length) // final line has no terminator
  return { starts, contentEnds }
}

/**
 * Apply LSP TextEdits to a string. LSP positions are 0-based (line, UTF-16
 * character) — the same code-unit indexing JS strings use. Edits within one
 * file are non-overlapping per spec; we apply them end-first so earlier offsets
 * stay valid as we splice.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const { starts, contentEnds } = lineIndex(text)
  const offset = (p: LspPosition): number => {
    const lineStart = starts[p.line] ?? text.length
    const contentEnd = contentEnds[p.line] ?? text.length
    // A character past the line's content clamps to its end (never into the
    // terminator or the next line); an exact cross-line range uses line+1 so it
    // resolves precisely and isn't affected by this clamp.
    return Math.min(lineStart + Math.max(0, p.character), contentEnd)
  }
  const resolved = edits
    .map((e) => ({ start: offset(e.range.start), end: offset(e.range.end), newText: e.newText }))
    .sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const e of resolved) out = out.slice(0, e.start) + e.newText + out.slice(Math.max(e.start, e.end))
  return out
}

export interface AppliedFile {
  abs: string
  rel: string
  before: string
  after: string
}

export interface ApplyResult {
  files: AppliedFile[]
  resourceOps: string[]
  /** file:// targets that resolved outside the workspace — edit was refused. */
  outOfWorkspace: string[]
}

/**
 * Apply a WorkspaceEdit to disk. All targets are validated against the
 * workspace jail *before* any write; if any escapes, nothing is written (a
 * rename must not land half-applied). Each changed file goes through
 * `onBeforeMutate` first so checkpoints/rewind capture the original.
 */
export async function applyWorkspaceEdit(
  cwd: string,
  edit: LspWorkspaceEdit,
  onBeforeMutate?: (absPath: string) => Promise<void>
): Promise<ApplyResult> {
  const { files, resourceOps } = normalizeWorkspaceEdit(edit)
  const outOfWorkspace: string[] = []
  const planned: { abs: string; rel: string; edits: LspTextEdit[] }[] = []
  // resolveInWorkspace canonicalizes (realpath) the result; compute display
  // paths against the canonical root so `rel` isn't polluted by symlinks like
  // macOS's /var → /private/var.
  const realCwd = safeRealpath(cwd)

  for (const f of files) {
    let abs: string
    try {
      abs = fileURLToPath(f.uri)
    } catch {
      outOfWorkspace.push(f.uri)
      continue
    }
    try {
      // Re-resolve through the jail (containment + symlink checks).
      const jailed = resolveInWorkspace(cwd, path.relative(realCwd, abs))
      planned.push({ abs: jailed, rel: path.relative(realCwd, jailed), edits: f.edits })
    } catch {
      outOfWorkspace.push(f.uri)
    }
  }
  // All-or-nothing: refuse the whole edit if any target escaped the workspace.
  if (outOfWorkspace.length) return { files: [], resourceOps, outOfWorkspace }

  const applied: AppliedFile[] = []
  for (const p of planned) {
    const before = await fsp.readFile(p.abs, 'utf8')
    const after = applyTextEdits(before, p.edits)
    if (after === before) continue
    await onBeforeMutate?.(p.abs)
    await fsp.writeFile(p.abs, after, 'utf8')
    applied.push({ abs: p.abs, rel: p.rel, before, after })
  }
  return { files: applied, resourceOps, outOfWorkspace }
}
