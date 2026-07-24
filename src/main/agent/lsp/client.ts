// One running language server: spawn, initialize handshake, document sync
// (full-text), diagnostics capture, and the read requests the lsp tool exposes.
import { ChildProcess, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { scrubCredentials } from '../env'
import { JsonRpcConnection } from './rpc'
import { ServerSpec, languageIdFor } from './servers'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export interface LspDocumentSymbol {
  name: string
  kind: number
  range?: LspRange
  selectionRange?: LspRange
  children?: LspDocumentSymbol[]
  // SymbolInformation (flat, older servers)
  location?: LspLocation
  containerName?: string
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

/** A rename/code-action result: per-file edits, in either LSP encoding. */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: Array<
    | { textDocument?: { uri?: string }; edits?: LspTextEdit[] }
    | { kind: string } // resource op (create/rename/delete file) — not applied
  >
}

/** A quick-fix / refactor offered by the server for a diagnostic or range. */
export interface LspCodeAction {
  title: string
  kind?: string
  diagnostics?: LspDiagnostic[]
  edit?: LspWorkspaceEdit
  command?: { command: string; title?: string; arguments?: unknown[] }
  disabled?: { reason: string }
}

interface OpenDoc {
  version: number
  text: string
}

const INIT_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const DIAGNOSTICS_WAIT_MS = 5_000

export class LspClient {
  private child: ChildProcess
  private conn: JsonRpcConnection
  private docs = new Map<string, OpenDoc>()
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private diagWaiters = new Map<string, Array<() => void>>()
  private stderrTail = ''
  private initPromise: Promise<void>
  private serverCapabilities: Record<string, unknown> = {}
  lastUsed = Date.now()

  constructor(
    readonly spec: ServerSpec,
    invocation: { command: string; args: string[] },
    readonly root: string
  ) {
    this.child = spawn(invocation.command, invocation.args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Never hand the app's/user's API tokens to a (possibly workspace-
      // provided) language server — same scrub the shell tools apply.
      env: scrubCredentials(process.env),
      // npm shims on Windows are .cmd scripts and need a shell to execute.
      shell: /\.(cmd|bat)$/i.test(invocation.command)
    })
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-2000)
    })
    this.conn = new JsonRpcConnection(this.child)

    this.conn.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri?: string; diagnostics?: LspDiagnostic[] }
      if (!p?.uri) return
      this.diagnostics.set(p.uri, p.diagnostics ?? [])
      const waiters = this.diagWaiters.get(p.uri)
      if (waiters) {
        this.diagWaiters.delete(p.uri)
        for (const w of waiters) w()
      }
    })
    // Server→client requests that stall some servers (pyright, gopls) when
    // left unanswered.
    this.conn.onRequest('workspace/configuration', (params) => {
      const items = (params as { items?: unknown[] })?.items ?? []
      return items.map(() => null)
    })
    this.conn.onRequest('client/registerCapability', () => null)
    this.conn.onRequest('client/unregisterCapability', () => null)
    this.conn.onRequest('window/workDoneProgress/create', () => null)
    this.conn.onRequest('window/showMessageRequest', () => null)
    this.conn.onRequest('workspace/workspaceFolders', () => [
      { uri: pathToFileURL(this.root).href, name: 'workspace' }
    ])

    this.initPromise = this.initialize()
  }

  get alive(): boolean {
    return !this.conn.isClosed && this.child.exitCode === null && !this.child.killed
  }

  ready(): Promise<void> {
    return this.initPromise
  }

  /** Last stderr output — appended to errors so failures are diagnosable. */
  get stderr(): string {
    return this.stderrTail.trim()
  }

  get openDocCount(): number {
    return this.docs.size
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href
    const result = (await this.conn.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            publishDiagnostics: { relatedInformation: false },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false },
            codeAction: {
              // Ask for CodeAction *objects* (with their edits), not bare Commands.
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] }
              }
            }
          },
          workspace: { configuration: true, workspaceFolders: true }
        }
      },
      INIT_TIMEOUT_MS
    )) as { capabilities?: Record<string, unknown> } | null
    this.serverCapabilities = result?.capabilities ?? {}
    this.conn.notify('initialized', {})
  }

  /** Whether the server advertised a capability (true or an options object). */
  private hasCapability(name: string): boolean {
    const v = this.serverCapabilities[name]
    return v === true || (typeof v === 'object' && v !== null)
  }

  get canRename(): boolean {
    return this.hasCapability('renameProvider')
  }

  get canCodeAction(): boolean {
    return this.hasCapability('codeActionProvider')
  }

  /**
   * Sync a file from disk into the server (didOpen on first touch, full-text
   * didChange when it differs). Returns the doc URI and, when the sync sent
   * anything, a promise that resolves on the next publishDiagnostics for it —
   * created BEFORE the notify goes out so the publish can't be missed.
   */
  async syncFile(absPath: string): Promise<{ uri: string; diagnosticsSettled: Promise<void> | null }> {
    this.lastUsed = Date.now()
    const text = await fsp.readFile(absPath, 'utf8')
    const uri = pathToFileURL(absPath).href
    const doc = this.docs.get(uri)
    if (doc && doc.text === text) return { uri, diagnosticsSettled: null }

    const settled = new Promise<void>((resolve) => {
      const list = this.diagWaiters.get(uri) ?? []
      list.push(resolve)
      this.diagWaiters.set(uri, list)
      const timer = setTimeout(() => {
        const current = this.diagWaiters.get(uri)
        if (current) {
          const i = current.indexOf(resolve)
          if (i >= 0) current.splice(i, 1)
          if (current.length === 0) this.diagWaiters.delete(uri)
        }
        resolve()
      }, DIAGNOSTICS_WAIT_MS)
      timer.unref?.()
    })
    if (!doc) {
      this.docs.set(uri, { version: 1, text })
      this.conn.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(absPath), version: 1, text }
      })
    } else {
      doc.version++
      doc.text = text
      this.conn.notify('textDocument/didChange', {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }]
      })
    }
    return { uri, diagnosticsSettled: settled }
  }

  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.diagnostics.get(uri) ?? []
  }

  async hover(uri: string, position: LspPosition): Promise<unknown> {
    this.lastUsed = Date.now()
    return this.conn.request(
      'textDocument/hover',
      { textDocument: { uri }, position },
      REQUEST_TIMEOUT_MS
    )
  }

  async definition(uri: string, position: LspPosition): Promise<unknown> {
    this.lastUsed = Date.now()
    return this.conn.request(
      'textDocument/definition',
      { textDocument: { uri }, position },
      REQUEST_TIMEOUT_MS
    )
  }

  async references(uri: string, position: LspPosition): Promise<unknown> {
    this.lastUsed = Date.now()
    return this.conn.request(
      'textDocument/references',
      { textDocument: { uri }, position, context: { includeDeclaration: true } },
      REQUEST_TIMEOUT_MS
    )
  }

  async documentSymbols(uri: string): Promise<unknown> {
    this.lastUsed = Date.now()
    return this.conn.request(
      'textDocument/documentSymbol',
      { textDocument: { uri } },
      REQUEST_TIMEOUT_MS
    )
  }

  /** Rename the symbol at `position` to `newName`. Returns a WorkspaceEdit
   *  spanning every file that references it, or null if the server declines. */
  async rename(uri: string, position: LspPosition, newName: string): Promise<LspWorkspaceEdit | null> {
    this.lastUsed = Date.now()
    return (await this.conn.request(
      'textDocument/rename',
      { textDocument: { uri }, position, newName },
      REQUEST_TIMEOUT_MS
    )) as LspWorkspaceEdit | null
  }

  /** Quick-fixes/refactors the server offers for `range`, given the diagnostics
   *  in play there. Returns a mix of CodeAction objects and bare Commands. */
  async codeActions(
    uri: string,
    range: LspRange,
    diagnostics: LspDiagnostic[]
  ): Promise<LspCodeAction[]> {
    this.lastUsed = Date.now()
    const res = await this.conn.request(
      'textDocument/codeAction',
      { textDocument: { uri }, range, context: { diagnostics } },
      REQUEST_TIMEOUT_MS
    )
    return Array.isArray(res) ? (res as LspCodeAction[]) : []
  }

  /** Polite shutdown with a hard kill backstop. */
  dispose(): void {
    if (this.conn.isClosed) return
    const finish = (): void => {
      this.conn.notify('exit', null)
      this.conn.close('client disposed')
      const timer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill('SIGKILL')
      }, 1_000)
      timer.unref?.()
    }
    void this.conn.request('shutdown', null, 2_000).then(finish, finish)
  }
}
