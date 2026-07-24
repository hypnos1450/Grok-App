import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addWorktree,
  applyDiff,
  filesInDiff,
  isGitRepo,
  removeWorktree,
  worktreeDiff
} from '../src/main/agent/builders'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('filesInDiff', () => {
  it('extracts added, modified, and deleted file paths', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/new.txt b/new.txt',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null'
    ].join('\n')
    expect(filesInDiff(diff).sort()).toEqual(['gone.txt', 'new.txt', 'src/a.ts'])
  })

  it('returns nothing for an empty diff', () => {
    expect(filesInDiff('')).toEqual([])
  })
})

describe.skipIf(!hasGit())('git worktree round-trip', () => {
  let repo: string
  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-builders-')))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(repo, 'base.txt'), 'hello\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'baseline'])
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  it('detects the repo', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(os.tmpdir())).toBe(false)
  })

  it('builds in an isolated worktree, diffs it, and applies the diff to main', async () => {
    const wt = await addWorktree(repo, 'testbuild')
    expect(fs.existsSync(wt.path)).toBe(true)

    // Simulate a builder's work inside the worktree.
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'built by role\n')
    fs.writeFileSync(path.join(wt.path, 'base.txt'), 'hello\nextended\n')

    const diff = await worktreeDiff(wt)
    expect(filesInDiff(diff).sort()).toEqual(['base.txt', 'feature.txt'])

    await removeWorktree(repo, wt)
    expect(fs.existsSync(wt.path)).toBe(false)
    // The main tree is untouched until we apply — isolation held.
    expect(fs.existsSync(path.join(repo, 'feature.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'base.txt'), 'utf8')).toBe('hello\n')

    const applied = await applyDiff(repo, diff)
    expect(applied.ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('built by role\n')
    expect(fs.readFileSync(path.join(repo, 'base.txt'), 'utf8')).toBe('hello\nextended\n')
  }, 20_000)

  it('applies two disjoint builds cleanly (parallel-safe merge)', async () => {
    const a = await addWorktree(repo, 'a')
    const b = await addWorktree(repo, 'b')
    fs.writeFileSync(path.join(a.path, 'a.txt'), 'A\n')
    fs.writeFileSync(path.join(b.path, 'b.txt'), 'B\n')
    const da = await worktreeDiff(a)
    const db = await worktreeDiff(b)
    await removeWorktree(repo, a)
    await removeWorktree(repo, b)
    expect((await applyDiff(repo, da)).ok).toBe(true)
    expect((await applyDiff(repo, db)).ok).toBe(true)
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('A\n')
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('B\n')
  }, 20_000)

  it('reports a conflict instead of applying a bad diff', async () => {
    const bogus =
      'diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1 @@\n-nonexistent line\n+replacement\n'
    const r = await applyDiff(repo, bogus)
    expect(r.ok).toBe(false)
    expect(r.err.length).toBeGreaterThan(0)
  }, 20_000)
})
