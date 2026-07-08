// Lightweight git awareness: branch, dirty count, ahead/behind. Shells out to
// the system git; degrades silently to { isRepo: false } when git is absent
// or the directory isn't a repo.
import { execFile } from 'node:child_process'
import { GitStatus } from '@shared/types'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
    })
  })
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') return { isRepo: false }

  const [branch, porcelain, counts] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  ])

  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
  let ahead: number | undefined
  let behind: number | undefined
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
    if (Number.isFinite(b)) behind = b
    if (Number.isFinite(a)) ahead = a
  }
  return { isRepo: true, branch: branch || 'HEAD', dirty, ahead, behind }
}

/** One-line summary for the system prompt, or '' outside a repo. */
export async function gitSummary(cwd: string): Promise<string> {
  const s = await gitStatus(cwd)
  if (!s.isRepo) return ''
  const bits = [`branch ${s.branch}`]
  if (s.dirty) bits.push(`${s.dirty} uncommitted file${s.dirty === 1 ? '' : 's'}`)
  if (s.ahead) bits.push(`${s.ahead} ahead`)
  if (s.behind) bits.push(`${s.behind} behind`)
  return bits.join(', ')
}
