// Language-server lifecycle: one client per (workspace root, server id),
// started lazily on first use, reaped when idle, all killed on app quit.
import path from 'node:path'
import { LspClient } from './client'
import { SUPPORTED_LANGUAGES, findServerCommand, specForFile } from './servers'

const IDLE_MS = 15 * 60_000

class LspManager {
  private clients = new Map<string, LspClient>()

  /**
   * Get (or start) the language server responsible for a file. Throws with an
   * actionable message when the language is unsupported or no server binary is
   * installed — the tool surfaces that text directly to the model.
   */
  async clientFor(cwd: string, absPath: string): Promise<LspClient> {
    const spec = specForFile(absPath)
    if (!spec) {
      throw new Error(
        `No language server mapping for "${path.extname(absPath) || path.basename(absPath)}" — lsp supports ${SUPPORTED_LANGUAGES}. For other checks use the diagnostics tool.`
      )
    }
    const key = `${cwd}::${spec.id}`
    this.sweepIdle(key)

    const existing = this.clients.get(key)
    if (existing?.alive) return existing
    if (existing) this.clients.delete(key)

    const invocation = findServerCommand(cwd, spec)
    if (!invocation) {
      throw new Error(
        `No ${spec.id} language server is installed (looked for: ${spec.candidates.map((c) => c.bin).join(', ')}). Install one with: ${spec.install}`
      )
    }
    const client = new LspClient(spec, invocation, cwd)
    this.clients.set(key, client)
    try {
      await client.ready()
    } catch (e) {
      this.clients.delete(key)
      client.dispose()
      const stderr = client.stderr ? `\nServer stderr: ${client.stderr.slice(-500)}` : ''
      throw new Error(
        `${spec.id} language server failed to start: ${e instanceof Error ? e.message : String(e)}${stderr}`,
        { cause: e }
      )
    }
    return client
  }

  /** One line per running server, for the tool's status action. */
  status(): string[] {
    return [...this.clients.entries()].map(([key, c]) => {
      const [root, id] = key.split('::')
      const idleMin = Math.round((Date.now() - c.lastUsed) / 60_000)
      return `${id} — ${root} (${c.alive ? 'running' : 'dead'}, ${c.openDocCount} docs open, idle ${idleMin}m)`
    })
  }

  disposeAll(): void {
    for (const c of this.clients.values()) c.dispose()
    this.clients.clear()
  }

  private sweepIdle(exceptKey: string): void {
    for (const [key, c] of this.clients) {
      if (key === exceptKey) continue
      if (!c.alive || Date.now() - c.lastUsed > IDLE_MS) {
        c.dispose()
        this.clients.delete(key)
      }
    }
  }
}

export const lspManager = new LspManager()
