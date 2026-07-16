// GUI-launched apps on macOS/Linux inherit launchd's (or the desktop session's)
// minimal PATH — typically /usr/bin:/bin:/usr/sbin:/sbin — not the PATH the user
// sees in a terminal. Anything installed via Homebrew, nvm, asdf, or ~/.local/bin
// is therefore invisible to child processes we spawn directly, which is why stdio
// MCP servers die with `spawn npx ENOENT` in a packaged build but work in dev
// (where npm start inherits the terminal's environment).
//
// The bash tool is unaffected: it goes through `zsh -lc`, so the shell builds its
// own PATH. Only direct spawns (MCP) need this.
//
// Fix: ask the user's login shell what PATH actually is, once, at startup.
import { execFile } from 'node:child_process'
import { logger } from './logger'

const log = logger('shell-path')
const DELIM = '__CONDUIT_PATH_DELIM__'
const TIMEOUT_MS = 5_000

/**
 * Resolve the user's interactive login-shell PATH. Returns undefined on Windows
 * (where GUI processes get the real environment) or if the shell can't be asked.
 */
export function resolveShellPath(): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined)
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    // -i so PATH set in .zshrc/.bashrc (interactive-only for most users) is seen.
    // The delimiter lets us ignore anything the rc files print on startup.
    execFile(
      shell,
      ['-ilc', `printf '%s%s' '${DELIM}' "$PATH"`],
      {
        timeout: TIMEOUT_MS,
        // Keep noisy rc integrations from stalling or polluting a login shell
        // that has no tty attached.
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', CI: '1' }
      },
      (err, stdout) => {
        if (err) {
          log.warn(`could not read PATH from ${shell}: ${err.message}`)
          resolve(undefined)
          return
        }
        const i = stdout.lastIndexOf(DELIM)
        if (i === -1) {
          resolve(undefined)
          return
        }
        const p = stdout.slice(i + DELIM.length).trim()
        resolve(p || undefined)
      }
    )
  })
}

/**
 * Point process.env.PATH at the login shell's PATH so directly-spawned children
 * (MCP servers) can find user-installed binaries. No-op if the shell can't be
 * read or already agrees with what we have.
 */
export async function fixPath(): Promise<void> {
  const shellPath = await resolveShellPath()
  if (!shellPath || shellPath === process.env.PATH) return
  const before = process.env.PATH ?? ''
  // Union, shell first: the shell's PATH is what the user expects to win, but
  // keep any entry Electron relies on rather than dropping it.
  const seen = new Set<string>()
  const merged = [...shellPath.split(':'), ...before.split(':')]
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(':')
  process.env.PATH = merged
  log.info(`PATH resolved from ${process.env.SHELL || 'shell'} (${before.split(':').length} -> ${merged.split(':').length} entries)`)
}
