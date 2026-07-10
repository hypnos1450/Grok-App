// GitHub PR helpers via the `gh` CLI when available.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitHubPrDraft, GitHubPrInfo, GitHubRepoInfo } from '@shared/types'

const execFileAsync = promisify(execFile)

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
  })
  return stdout.trim()
}

export async function detectRepo(cwd: string): Promise<GitHubRepoInfo | null> {
  try {
    const url = await gh(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef', '-q', '.'], cwd)
    // Prefer structured JSON
    const json = await gh(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], cwd)
    const data = JSON.parse(json) as {
      nameWithOwner?: string
      url?: string
      defaultBranchRef?: { name?: string }
    }
    const [owner, name] = (data.nameWithOwner ?? '').split('/')
    if (!owner || !name) return null
    return {
      owner,
      name,
      defaultBranch: data.defaultBranchRef?.name,
      remoteUrl: data.url
    }
  } catch {
    try {
      // Fallback: parse git remote
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        timeout: 10_000
      })
      const m =
        /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i.exec(stdout.trim()) ||
        /github\.com\/([^/]+)\/([^/.]+)/i.exec(stdout.trim())
      if (!m) return null
      return { owner: m[1], name: m[2], remoteUrl: stdout.trim() }
    } catch {
      return null
    }
  }
}

export async function createPullRequest(
  cwd: string,
  draft: GitHubPrDraft
): Promise<{ ok: boolean; error?: string; pr?: GitHubPrInfo }> {
  try {
    const args = ['pr', 'create', '--title', draft.title.slice(0, 200)]
    if (draft.body) args.push('--body', draft.body.slice(0, 50_000))
    if (draft.base) args.push('--base', draft.base)
    if (draft.head) args.push('--head', draft.head)
    if (draft.draft) args.push('--draft')
    args.push('--json', 'number,url,title,state,baseRefName,headRefName')
    const out = await gh(args, cwd)
    const data = JSON.parse(out) as {
      number: number
      url: string
      title: string
      state: string
      baseRefName: string
      headRefName: string
    }
    return {
      ok: true,
      pr: {
        number: data.number,
        url: data.url,
        title: data.title,
        state: data.state,
        base: data.baseRefName,
        head: data.headRefName
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: msg.includes('gh')
        ? `GitHub CLI failed. Install/auth with \`gh auth login\`. ${msg.slice(0, 300)}`
        : msg.slice(0, 400)
    }
  }
}
