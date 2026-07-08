// Shared types across main, preload, and renderer.

export type ModelId = 'grok-4.3' | 'grok-build-0.1'

export const MODELS: { id: ModelId; label: string; blurb: string }[] = [
  { id: 'grok-build-0.1', label: 'Grok Build', blurb: 'Fast agentic coding · 256K context' },
  { id: 'grok-4.3', label: 'Grok 4.3', blurb: 'Flagship reasoning · 1M context' }
]

export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto'

export interface AuthState {
  method: 'oauth' | 'apiKey' | null
  email?: string
  /** True while an OAuth flow is waiting on the browser */
  pending?: boolean
}

export interface Settings {
  defaultModel: ModelId
  permissionMode: PermissionMode
  theme: 'dark' | 'light' | 'system'
  /** Extra instructions appended to the system prompt */
  customInstructions: string
  /** Let Grok use xAI's server-side web_search / x_search tools */
  enableWebSearch: boolean
  /** Persistent agent-curated memory (Hermes-style MEMORY/USER stores) */
  memoryEnabled: boolean
  /** Require approval before memory/skill writes are applied */
  memoryWriteApproval: boolean
  /** Tool keys (e.g. "bash:npm", "write_file") allowed in every session */
  globalAllowlist: string[]
  /** Allow Grok to spawn parallel read-only subagents */
  enableSubagents: boolean
  /** External MCP servers to connect (stdio) */
  mcpServers: McpServerConfig[]
  /** Opt in to automatic update checks */
  autoUpdate: boolean
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  /** Extra environment variables for the server process */
  env?: Record<string, string>
  enabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: 'grok-build-0.1',
  permissionMode: 'ask',
  theme: 'dark',
  customInstructions: '',
  enableWebSearch: true,
  memoryEnabled: true,
  memoryWriteApproval: false,
  globalAllowlist: [],
  enableSubagents: true,
  mcpServers: [],
  autoUpdate: true
}

/** Current on-disk schema version for sessions and settings. */
export const SCHEMA_VERSION = 1

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: ModelId
  cwd: string
  messageCount: number
  /** Cumulative token usage across the session */
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCachedTokens?: number
}

export interface GitStatus {
  isRepo: boolean
  branch?: string
  /** Number of files with uncommitted changes */
  dirty?: number
  ahead?: number
  behind?: number
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

export type ChatItem =
  | {
      kind: 'user'
      id: string
      ts: number
      text: string
      /** Pasted images as data URLs */
      images?: string[]
      /** @-mentioned file paths attached to this message */
      files?: string[]
    }
  | {
      kind: 'assistant'
      id: string
      ts: number
      text: string
      reasoning?: string
      citations?: string[]
      model: string
    }
  | {
      kind: 'tool'
      id: string
      ts: number
      callId: string
      name: string
      input: Record<string, unknown>
      status: ToolStatus
      output?: string
      /** Diff or content preview shown in the card / permission prompt */
      preview?: string
      durationMs?: number
    }
  | { kind: 'compaction'; id: string; ts: number; summary: string }
  | { kind: 'error'; id: string; ts: number; message: string }
  /** Small system line: memory updates, checkpoint restores, etc. */
  | { kind: 'note'; id: string; ts: number; text: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** 0..1 fraction of the model context window currently in use */
  contextUsed: number
}

export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  /** Human-readable one-liner, e.g. the bash command or file path */
  summary: string
  input: Record<string, unknown>
  /** Diff or content preview (file edits, memory writes) */
  preview?: string
  /** How many times the user has previously approved this exact tool key */
  priorApprovals?: number
}

export interface PendingMemoryWrite {
  id: string
  ts: number
  action: 'add' | 'replace' | 'remove'
  target: 'memory' | 'user' | 'project'
  content?: string
  old_text?: string
  /** Workspace the write applies to (project target only) */
  cwd?: string
  /** 'auto' = background self-review, 'agent' = foreground tool call */
  source: 'auto' | 'agent'
}

export interface SkillMeta {
  name: string
  description: string
  /** ISO date of last update */
  updated: string
}

export interface PendingSkillWrite {
  id: string
  ts: number
  action: 'create' | 'update' | 'delete'
  name: string
  description?: string
  content?: string
  source: 'auto' | 'agent'
}

export interface CheckpointInfo {
  /** id of the user message the checkpoint belongs to */
  itemId: string
  ts: number
  fileCount: number
}

/** Events streamed from main → renderer on the `agent:event` channel */
export type AgentEvent =
  | { type: 'turn-start'; sessionId: string }
  | { type: 'text-delta'; sessionId: string; itemId: string; text: string }
  | { type: 'reasoning-delta'; sessionId: string; itemId: string; text: string }
  | { type: 'item'; sessionId: string; item: ChatItem }
  | { type: 'item-update'; sessionId: string; item: ChatItem }
  | { type: 'permission-request'; sessionId: string; request: PermissionRequest }
  | { type: 'usage'; sessionId: string; usage: Usage }
  | { type: 'turn-end'; sessionId: string; stopReason: 'done' | 'cancelled' | 'error' | 'max-turns' }
  | { type: 'title'; sessionId: string; title: string }
  /** Transient banner: rate limits, quota, degraded auth */
  | {
      type: 'notice'
      sessionId: string
      level: 'info' | 'warn' | 'error'
      message: string
      /** epoch ms when a rate limit resets, if known */
      retryAt?: number
    }
  /** A steering message was accepted while the agent was running */
  | { type: 'queued'; sessionId: string; text: string }

export interface SessionData {
  meta: SessionMeta
  items: ChatItem[]
  checkpoints: CheckpointInfo[]
}

export interface UpdateInfo {
  version: string
  notes?: string
}

export interface McpServerStatus {
  name: string
  connected: boolean
  toolCount: number
  error?: string
}

export interface Attachments {
  /** Pasted images as data URLs */
  images?: string[]
  /** Workspace-relative file paths to attach */
  files?: string[]
}

/** The API surface exposed to the renderer via contextBridge */
export interface HarnessApi {
  auth: {
    getState(): Promise<AuthState>
    loginOAuth(): Promise<{ ok: boolean; error?: string }>
    setApiKey(key: string): Promise<{ ok: boolean; error?: string }>
    logout(): Promise<void>
    /** Verify the credential can reach the API (catches OAuth-allowlist 403) */
    probe(): Promise<{ ok: boolean; status?: number; message?: string }>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    create(opts: { cwd?: string; model?: ModelId }): Promise<SessionMeta>
    load(id: string): Promise<SessionData | null>
    delete(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    setModel(id: string, model: ModelId): Promise<void>
    restoreCheckpoint(sessionId: string, itemId: string): Promise<{ restored: number }>
    /** Copy a session up to (and including) itemId into a new session */
    fork(sessionId: string, itemId: string): Promise<SessionMeta | null>
    /** Export a transcript to markdown via a save dialog. Returns saved path or null */
    export(sessionId: string): Promise<string | null>
    gitStatus(sessionId: string): Promise<GitStatus>
  }
  agent: {
    send(sessionId: string, text: string, attachments?: Attachments): Promise<void>
    cancel(sessionId: string): Promise<void>
    /** Queue a steering message to inject after the current tool round */
    queue(sessionId: string, text: string): Promise<boolean>
    /** Regenerate the last assistant response */
    retry(sessionId: string): Promise<void>
    /** Truncate at a user message, replace its text, and re-run */
    editResend(sessionId: string, itemId: string, text: string): Promise<void>
    isRunning(sessionId: string): Promise<boolean>
    respondPermission(
      requestId: string,
      allow: boolean,
      alwaysAllow?: boolean,
      globalAllow?: boolean
    ): Promise<void>
    onEvent(cb: (ev: AgentEvent) => void): () => void
  }
  memory: {
    entries(cwd?: string): Promise<{ memory: string[]; user: string[]; project: string[] }>
    removeEntry(target: 'memory' | 'user' | 'project', text: string, cwd?: string): Promise<void>
    pending(): Promise<PendingMemoryWrite[]>
    resolvePending(id: string | 'all', approve: boolean): Promise<PendingMemoryWrite[]>
  }
  skills: {
    list(): Promise<SkillMeta[]>
    get(name: string): Promise<{ meta: SkillMeta; content: string } | null>
    remove(name: string): Promise<void>
    pending(): Promise<PendingSkillWrite[]>
    resolvePending(id: string | 'all', approve: boolean): Promise<PendingSkillWrite[]>
  }
  files: {
    suggest(sessionId: string, query: string): Promise<string[]>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  mcp: {
    status(): Promise<McpServerStatus[]>
    reconnect(): Promise<McpServerStatus[]>
  }
  update: {
    check(): Promise<{ ok: boolean; version?: string; error?: string }>
    install(): Promise<void>
    onAvailable(cb: (info: UpdateInfo) => void): () => void
    onDownloaded(cb: (info: UpdateInfo) => void): () => void
  }
  onMenuAction(cb: (action: string) => void): () => void
  revealLogs(): Promise<void>
  pickFolder(): Promise<string | null>
  openExternal(url: string): Promise<void>
}
