import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  applyTextEdits,
  normalizeWorkspaceEdit,
  applyWorkspaceEdit
} from '../src/main/agent/lsp/edit'
import type { LspTextEdit, LspWorkspaceEdit } from '../src/main/agent/lsp/client'

const edit = (sl: number, sc: number, el: number, ec: number, newText: string): LspTextEdit => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText
})

describe('applyTextEdits', () => {
  it('replaces a single-line span using 0-based UTF-16 positions', () => {
    // "const foo = 1" → rename foo (chars 6..9) to "bar"
    expect(applyTextEdits('const foo = 1', [edit(0, 6, 0, 9, 'bar')])).toBe('const bar = 1')
  })

  it('applies multiple edits on one line without offset drift', () => {
    // Two replacements; the later one must not shift the earlier one.
    const out = applyTextEdits('aaa bbb ccc', [edit(0, 0, 0, 3, 'X'), edit(0, 8, 0, 11, 'Y')])
    expect(out).toBe('X bbb Y')
  })

  it('handles edits across multiple lines and CRLF newlines', () => {
    const text = 'let a = 1\r\nlet b = 2\r\n'
    // rename `a` (line 0, 4..5) and `b` (line 1, 4..5)
    const out = applyTextEdits(text, [edit(0, 4, 0, 5, 'x'), edit(1, 4, 1, 5, 'y')])
    expect(out).toBe('let x = 1\r\nlet y = 2\r\n')
  })

  it('supports pure insertions (zero-width range)', () => {
    expect(applyTextEdits('import x\n', [edit(0, 0, 0, 0, 'import y\n')])).toBe('import y\nimport x\n')
  })

  it('clamps a past-end-of-line character to the line boundary', () => {
    // character 99 on a 3-char line should not spill into the next line
    expect(applyTextEdits('ab\ncd', [edit(0, 0, 0, 99, 'X')])).toBe('X\ncd')
  })
})

describe('normalizeWorkspaceEdit', () => {
  it('reads the `changes` map form', () => {
    const e: LspWorkspaceEdit = { changes: { 'file:///a.ts': [edit(0, 0, 0, 1, 'x')] } }
    const { files, resourceOps } = normalizeWorkspaceEdit(e)
    expect(files).toHaveLength(1)
    expect(files[0].uri).toBe('file:///a.ts')
    expect(resourceOps).toEqual([])
  })

  it('reads the `documentChanges` form and flags resource operations', () => {
    const e: LspWorkspaceEdit = {
      documentChanges: [
        { textDocument: { uri: 'file:///a.ts' }, edits: [edit(0, 0, 0, 1, 'x')] },
        { kind: 'rename' }
      ]
    }
    const { files, resourceOps } = normalizeWorkspaceEdit(e)
    expect(files).toHaveLength(1)
    expect(resourceOps).toEqual(['rename'])
  })
})

describe('applyWorkspaceEdit (disk + jail)', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-edit-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const uri = (rel: string): string => pathToFileURL(path.join(root, rel)).href

  it('applies a multi-file rename and reports before/after per file', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const foo = 1\n')
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'sub', 'b.ts'), 'import { foo } from "../a"\n')

    const wsEdit: LspWorkspaceEdit = {
      changes: {
        [uri('a.ts')]: [edit(0, 13, 0, 16, 'bar')],
        [uri('sub/b.ts')]: [edit(0, 9, 0, 12, 'bar')]
      }
    }
    const mutated: string[] = []
    const res = await applyWorkspaceEdit(root, wsEdit, async (p) => {
      mutated.push(p)
    })

    expect(res.outOfWorkspace).toEqual([])
    expect(res.files.map((f) => f.rel).sort()).toEqual(['a.ts', path.join('sub', 'b.ts')])
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('export const bar = 1\n')
    expect(fs.readFileSync(path.join(root, 'sub', 'b.ts'), 'utf8')).toBe('import { bar } from "../a"\n')
    // checkpoint hook fired once per changed file
    expect(mutated).toHaveLength(2)
  })

  it('refuses the whole edit (writes nothing) if any target escapes the workspace', async () => {
    const inside = path.join(root, 'a.ts')
    fs.writeFileSync(inside, 'const foo = 1\n')
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    const outside = path.join(outsideDir, 'evil.ts')
    fs.writeFileSync(outside, 'const x = 1\n')

    const wsEdit: LspWorkspaceEdit = {
      changes: {
        [uri('a.ts')]: [edit(0, 6, 0, 9, 'bar')],
        [pathToFileURL(outside).href]: [edit(0, 6, 0, 7, 'ZZ')]
      }
    }
    const res = await applyWorkspaceEdit(root, wsEdit)
    expect(res.outOfWorkspace).toHaveLength(1)
    expect(res.files).toEqual([])
    // Neither file touched — all-or-nothing.
    expect(fs.readFileSync(inside, 'utf8')).toBe('const foo = 1\n')
    expect(fs.readFileSync(outside, 'utf8')).toBe('const x = 1\n')
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('skips files whose edits produce no change', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'const foo = 1\n')
    const wsEdit: LspWorkspaceEdit = { changes: { [uri('a.ts')]: [edit(0, 6, 0, 9, 'foo')] } }
    const res = await applyWorkspaceEdit(root, wsEdit)
    expect(res.files).toEqual([]) // identical text → not written
  })
})
