// Shared types across main, preload, and renderer.

export type ModelId = 'grok-4.3' | 'grok-build-0.1'

export const MODELS: { id: ModelId; label: string; blurb: string; effort?: boolean }[] = [
  {
    // id stays grok-build-0.1 so saved sessions keep resolving to this profile;
    // it runs grok-4.5 on the wire (see PROFILES).
    id: 'grok-build-0.1',
    label: 'Grok 4.5',
    blurb: 'Agentic coding · 500K context',
    effort: true
  },
  { id: 'grok-4.3', label: 'Grok 4.3', blurb: 'Flagship reasoning · 1M context' }
]

export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto' | 'plan-only'

/** Named risk profiles map to permission + feature defaults */
export type AgentProfileId = 'careful' | 'balanced' | 'yolo'

/**
 * A user-defined agent persona. Selecting one for a session injects its
 * `instructions` into the system prompt, scopes the visible skills to `skills`,
 * and applies its `model` + `permissionMode`. The main agent can also delegate
 * to one by name via spawn_agent (read-only investigation).
 */
export interface CustomAgent {
  id: string
  name: string
  /** Role/behavior instructions injected into the system prompt */
  instructions: string
  /** Skill names (from installed skills) this agent may use; [] = none */
  skills: string[]
  model: ModelId
  permissionMode: PermissionMode
}

export type UpdateChannel = 'latest' | 'beta'

export interface AuthState {
  method: 'oauth' | 'apiKey' | null
  email?: string
  /** True while an OAuth flow is waiting on the browser */
  pending?: boolean
  /** Last probe failure message (offline / auth expired) */
  lastError?: string
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
  /** System notifications when a run finishes or needs approval while unfocused */
  notifications: boolean
  /** Named profile (drives permissionMode defaults in UI) */
  agentProfile: AgentProfileId
  /** After write/edit, inject a verify/test reminder into the tool result */
  testAfterEdit: boolean
  /** Prefer a cheaper model for title/compaction/review background calls */
  multiModelRouting: boolean
  /** Inject a frozen repo map into the system prompt */
  repoMapEnabled: boolean
  /** Require explicit trust before agent tools run in a workspace */
  requireWorkspaceTrust: boolean
  /** Trusted workspace absolute paths */
  trustedWorkspaces: string[]
  /** electron-updater channel */
  updateChannel: UpdateChannel
  /** Keep a local security audit log */
  auditLogEnabled: boolean
  /** Default test/verify command hint (e.g. npm test) for test-after-edit */
  testCommand: string
  /** Reduced motion / a11y */
  reducedMotion: boolean
  /** User-defined agent personas (title, instructions, scoped skills, model, mode) */
  customAgents: CustomAgent[]
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  /** Extra environment variables for the server process */
  env?: Record<string, string>
  enabled: boolean
  /** Where this server was installed from (github URL / npm package), if known */
  source?: string
}

/** Env var the MCP installer thinks the server needs */
export interface McpEnvNeed {
  key: string
  description?: string
  required: boolean
  placeholder?: string
}

/** Preview returned before the user confirms an MCP install from GitHub/npm */
export interface McpInstallPreview {
  ok: boolean
  error?: string
  name?: string
  command?: string
  args?: string[]
  envNeeds?: McpEnvNeed[]
  notes?: string[]
  source?: string
  npmPackage?: string
}

export interface McpInstallResult {
  ok: boolean
  error?: string
  server?: McpServerConfig
  missingEnv?: string[]
  notes?: string[]
  preview?: McpInstallPreview
  /** Fresh connection status after install (when install also reconnects) */
  status?: McpServerStatus[]
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
  autoUpdate: true,
  notifications: true,
  agentProfile: 'balanced',
  testAfterEdit: true,
  multiModelRouting: true,
  repoMapEnabled: true,
  requireWorkspaceTrust: true,
  trustedWorkspaces: [],
  updateChannel: 'latest',
  auditLogEnabled: true,
  testCommand: '',
  reducedMotion: false,
  customAgents: []
}

export const AGENT_PROFILES: {
  id: AgentProfileId
  label: string
  blurb: string
  permissionMode: PermissionMode
}[] = [
  {
    id: 'careful',
    label: 'Careful',
    blurb: 'Ask before every write/command · plan-friendly',
    permissionMode: 'ask'
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Auto-edit files · ask for shell/MCP',
    permissionMode: 'auto-edit'
  },
  {
    id: 'yolo',
    label: 'YOLO',
    blurb: 'Full auto · still blocks catastrophic commands',
    permissionMode: 'full-auto'
  }
]

/** Current on-disk schema version for sessions and settings. */
export const SCHEMA_VERSION = 1

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: ModelId
  cwd: string
  messageCount: number
  /** Reasoning depth for models that support it (undefined = API default) */
  reasoningEffort?: ReasoningEffort
  /** Cumulative token usage across the session */
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCachedTokens?: number
  /** Searchable session digest from background review */
  digest?: string
  /** Plan-only mode for this session (overrides settings.permissionMode) */
  planOnly?: boolean
  /** Selected custom agent persona for this session (id into settings.customAgents) */
  agentId?: string
}

/** One step of the agent-maintained live plan (update_plan tool) */
export interface PlanStep {
  title: string
  status: 'pending' | 'active' | 'done'
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
  /**
   * Tokens currently filling the model context window (last request prompt size).
   * This is what the % meter is about — NOT lifetime session spend.
   */
  contextTokens: number
  /** Model context window (e.g. 500_000 for Grok Build / 1_000_000 for Grok 4.3) */
  contextWindow: number
  /** 0..1 fraction of the model context window currently in use */
  contextUsed: number
  /** Lifetime session totals (sum of every API call — can exceed the window) */
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCachedTokens: number
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

/** The agent pausing to ask the user a question mid-task (ask_user tool). */
export interface UserQuestion {
  requestId: string
  sessionId: string
  question: string
  /** Optional suggested answers, rendered as quick-reply buttons. */
  options?: string[]
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
  /** Optional grouping label shown in the UI (e.g. "document skills"). */
  category?: string
  /** Number of bundled resource files (scripts, references) beside SKILL.md */
  fileCount?: number
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

export interface CommandMeta {
  name: string
  description: string
  builtin: boolean
}

export interface SkillImportReport {
  installed: string[]
  errors: string[]
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
  | { type: 'user-question'; sessionId: string; request: UserQuestion }
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
  /** The agent updated its live plan (update_plan tool) */
  | { type: 'plan'; sessionId: string; steps: PlanStep[] }

export interface SessionData {
  meta: SessionMeta
  items: ChatItem[]
  checkpoints: CheckpointInfo[]
  /** Last plan the agent published via update_plan */
  plan?: PlanStep[]
  /** Latest context-window usage (restored from lastPromptTokens when available) */
  usage?: Usage
}

export interface UpdateInfo {
  version: string
  notes?: string
  /** True once the package is fully downloaded and ready to install */
  ready?: boolean
  channel?: UpdateChannel
}

// ---- workspace trust / security / search / palette / github

export type WorkspaceTrustLevel = 'untrusted' | 'trusted' | 'denied'

export interface WorkspaceTrustState {
  cwd: string
  level: WorkspaceTrustLevel
  trustedAt?: number
}

export type AuditEventKind =
  | 'permission'
  | 'tool'
  | 'settings'
  | 'auth'
  | 'mcp'
  | 'trust'
  | 'export'
  | 'agent'
  | 'terminal'

export interface AuditEvent {
  id: string
  ts: number
  kind: AuditEventKind
  sessionId?: string
  summary: string
  detail?: string
}

export interface SessionSearchHit {
  sessionId: string
  title: string
  cwd: string
  updatedAt: number
  snippet?: string
  matchField?: 'title' | 'cwd' | 'digest' | 'message'
}

export interface PaletteAction {
  id: string
  label: string
  section?: string
  shortcut?: string
  /** When set, renderer handles; otherwise main may handle via palette:run */
  enabled?: boolean
}

export interface GitHubPrDraft {
  title: string
  body?: string
  base?: string
  head?: string
  draft?: boolean
}

export interface GitHubPrInfo {
  number: number
  url: string
  title: string
  state: string
  base: string
  head: string
}

export interface GitHubRepoInfo {
  owner: string
  name: string
  defaultBranch?: string
  remoteUrl?: string
}

export interface CrashReportInfo {
  id: string
  ts: number
  path: string
  version?: string
}

export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  /** Install input for mcp:install (npm package or github url) */
  install: string
  risk: 'low' | 'medium' | 'high'
  envNeeds?: string[]
}

/** A known, one-click-installable skill (a "skill marketplace" entry). */
export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  category?: string
  /** owner/repo or github URL/subpath passed to the skill importer */
  install: string
}

/**
 * One capability the agent builder decided a new agent needs, and how it will
 * be satisfied. `status` starts as the plan; `installedNames`/`error` are filled
 * in after the user asks to resolve (install) the missing ones.
 */
export interface AgentBuildSkill {
  capability: string
  reason: string
  /** already present · install from the curated catalog · search the web for it */
  status: 'installed' | 'catalog' | 'search'
  /** installed skill name, catalog id, or search query (per status) */
  ref: string
  /** install source (owner/repo or URL) for catalog/search, once known */
  install?: string
  /** skill names actually installed for this item after resolving */
  installedNames?: string[]
  error?: string
}

/** Draft agent the AI generated from a natural-language description. */
export interface AgentBuildResult {
  name: string
  instructions: string
  model: ModelId
  permissionMode: PermissionMode
  skills: AgentBuildSkill[]
  notes?: string
}

export interface TurnChangeSummary {
  sessionId: string
  files: { path: string; kind: 'write' | 'edit' }[]
  plan?: PlanStep[]
}

export interface OfflineStatus {
  online: boolean
  authOk: boolean
  message?: string
  checkedAt: number
}

export interface McpServerStatus {
  name: string
  connected: boolean
  toolCount: number
  /** Names of the tools this server exposes (un-namespaced) */
  tools?: string[]
  error?: string
}

// ---- right dock panels

export interface FileEntry {
  name: string
  /** Path relative to the session cwd */
  rel: string
  isDir: boolean
}

export type FilePreview =
  | { kind: 'text'; content: string; truncated: boolean; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string }

/** One concurrent terminal job (dev server, test run, interactive shell, …) */
export interface TermJobInfo {
  id: string
  /** Short label shown in the job tab (e.g. "main", "dev") */
  name: string
  running: boolean
  /** Last command started in this job */
  command?: string
  exitCode?: number | null
  /** Working directory for this job */
  cwd: string
}

export interface TermSnapshot {
  sessionId: string
  /** Backend mode: real PTY when node-pty loads, else enhanced spawn */
  mode: 'pty' | 'spawn'
  jobs: TermJobInfo[]
  activeJobId: string
  /** Per-job scrollback (tail, capped) for restore */
  buffers: Record<string, string>
  /** Recent commands for ↑/↓ history (newest last) */
  history: string[]
  /** Resolved shell binary */
  shell: string
  /** Session workspace root */
  workspaceCwd: string
}

export interface TermData {
  sessionId: string
  jobId: string
  /** New output chunk (may be empty on the final event) */
  chunk: string
  /** Present when the process finished */
  done?: boolean
  exitCode?: number | null
  /** Updated job list when membership/status changes */
  jobs?: TermJobInfo[]
}

export interface TermRunOpts {
  /** Existing job to reuse; omit to use/create the active job */
  jobId?: string
  /** Label for a new background job (e.g. "dev") */
  name?: string
  /** Force a fresh job slot even if one is free */
  newJob?: boolean
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
    /** Select a custom agent persona for this session (null = default) */
    setAgent(id: string, agentId: string | null): Promise<void>
    /** Set reasoning depth for this session (null = API default) */
    setEffort(id: string, effort: ReasoningEffort | null): Promise<void>
    restoreCheckpoint(sessionId: string, itemId: string): Promise<{ restored: number }>
    /** Copy a session up to (and including) itemId into a new session */
    fork(sessionId: string, itemId: string): Promise<SessionMeta | null>
    /** Export a transcript to markdown via a save dialog. Returns saved path or null */
    export(sessionId: string): Promise<string | null>
    gitStatus(sessionId: string): Promise<GitStatus>
    /** Full-text search across session titles, digests, and recent messages */
    search(query: string, limit?: number): Promise<SessionSearchHit[]>
    /** Toggle plan-only mode for this session */
    setPlanOnly(id: string, planOnly: boolean): Promise<void>
    /** Files mutated in the latest agent turn (for review panel) */
    turnChanges(sessionId: string): Promise<TurnChangeSummary | null>
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
      globalAllow?: boolean,
      sessionId?: string
    ): Promise<void>
    /** Answer an ask_user question. Empty answer = user declined to answer. */
    respondQuestion(requestId: string, answer: string, sessionId?: string): Promise<void>
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
    get(name: string): Promise<{ meta: SkillMeta; content: string; dir: string; files: string[] } | null>
    remove(name: string): Promise<void>
    pending(): Promise<PendingSkillWrite[]>
    resolvePending(id: string | 'all', approve: boolean): Promise<PendingSkillWrite[]>
    /** Install SKILL.md skills from a GitHub repo/folder/file URL */
    installGithub(url: string): Promise<SkillImportReport>
    /** Pick a local folder and install the SKILL.md skills inside (null = cancelled) */
    importFolder(): Promise<SkillImportReport | null>
    /** Show the skill's folder in Finder/Explorer (for sharing/export) */
    reveal(name: string): Promise<void>
    /** Assign (or clear, with '') a skill's category for grouping in the UI */
    setCategory(name: string, category: string): Promise<void>
  }
  files: {
    suggest(sessionId: string, query: string): Promise<string[]>
  }
  commands: {
    /** Built-in + user-defined slash commands */
    list(): Promise<CommandMeta[]>
    /** Expand "/name args" into the full prompt (null = unknown command) */
    resolve(name: string, args: string): Promise<string | null>
    /** Open the custom-commands folder in the file manager */
    openFolder(): Promise<void>
  }
  panels: {
    /** List a directory (relative to the session cwd) for the Files panel */
    listDir(sessionId: string, rel: string): Promise<FileEntry[]>
    /** Read a workspace file for the Preview panel */
    readFile(sessionId: string, rel: string): Promise<FilePreview>
  }
  term: {
    /**
     * Ensure a live shell for the session (PTY interactive shell, or spawn
     * job slots). Returns the current snapshot.
     */
    open(sessionId: string): Promise<TermSnapshot>
    /** Run a command. In PTY mode this writes to the interactive shell. */
    run(
      sessionId: string,
      command: string,
      opts?: TermRunOpts
    ): Promise<{ ok: boolean; error?: string; jobId?: string }>
    /** Open a new empty job tab (no command). */
    createJob(
      sessionId: string,
      name?: string
    ): Promise<{ ok: boolean; error?: string; jobId?: string; snapshot?: TermSnapshot }>
    /** Write raw bytes to a job's stdin / PTY (keystrokes, Ctrl+C, …) */
    write(sessionId: string, data: string, jobId?: string): Promise<void>
    /** Resize the PTY to match the xterm.js viewport */
    resize(sessionId: string, cols: number, rows: number, jobId?: string): Promise<void>
    /** Stop a job (or the active one). Process-tree kill on Windows. */
    kill(sessionId: string, jobId?: string): Promise<void>
    /** Close a job tab (stops it if running). Keeps at least one tab. */
    closeJob(sessionId: string, jobId: string): Promise<TermSnapshot | null>
    /** Switch which job is active in the UI */
    setActiveJob(sessionId: string, jobId: string): Promise<void>
    /** Clear scrollback for a job */
    clear(sessionId: string, jobId?: string): Promise<void>
    /** Restart the last command in a job */
    restart(sessionId: string, jobId?: string): Promise<{ ok: boolean; error?: string }>
    snapshot(sessionId: string): Promise<TermSnapshot>
    /** Open the system terminal at the session cwd */
    openExternal(sessionId: string): Promise<void>
    /** Recent command history for ↑/↓ */
    history(sessionId: string): Promise<string[]>
    /** Pin a command into a named background terminal job (agent → terminal) */
    pin(
      sessionId: string,
      command: string,
      name?: string
    ): Promise<{ ok: boolean; error?: string; jobId?: string }>
    onData(cb: (data: TermData) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  mcp: {
    status(): Promise<McpServerStatus[]>
    reconnect(): Promise<McpServerStatus[]>
    /** Inspect a GitHub URL / npm package and return how we'd install it */
    previewInstall(input: string): Promise<McpInstallPreview>
    /**
     * Install from a preview (or re-run detection) with user-supplied env.
     * Adds the server to settings and reconnects MCP.
     */
    install(
      input: string,
      opts?: { name?: string; env?: Record<string, string>; extraArgs?: string[] }
    ): Promise<McpInstallResult>
  }
  update: {
    check(): Promise<{ ok: boolean; version?: string; error?: string }>
    install(): Promise<{ ok: boolean; error?: string } | void>
    getChannel(): Promise<UpdateChannel>
    setChannel(channel: UpdateChannel): Promise<UpdateChannel>
    onAvailable(cb: (info: UpdateInfo) => void): () => void
    onDownloaded(cb: (info: UpdateInfo) => void): () => void
  }
  workspace: {
    getTrust(cwd: string): Promise<WorkspaceTrustState>
    setTrust(cwd: string, level: 'trusted' | 'denied'): Promise<WorkspaceTrustState>
    listTrusted(): Promise<string[]>
  }
  audit: {
    list(limit?: number): Promise<AuditEvent[]>
    clear(): Promise<void>
    export(): Promise<string | null>
  }
  palette: {
    list(): Promise<PaletteAction[]>
  }
  github: {
    repo(sessionId: string): Promise<GitHubRepoInfo | null>
    createPr(sessionId: string, draft: GitHubPrDraft): Promise<{ ok: boolean; error?: string; pr?: GitHubPrInfo }>
    openPr(url: string): Promise<void>
  }
  crash: {
    list(): Promise<CrashReportInfo[]>
    reveal(): Promise<void>
    /** Bundle logs + version into a support zip path (or clipboard summary) */
    copyDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  mcpCatalog: {
    list(): Promise<McpCatalogEntry[]>
  }
  skillCatalog: {
    list(): Promise<SkillCatalogEntry[]>
  }
  agents: {
    /** Draft an agent (role, model, skills plan) from a natural-language brief */
    build(prompt: string): Promise<AgentBuildResult>
    /** Install the catalog / web-searched skills in a build plan; returns updated items */
    resolveSkills(items: AgentBuildSkill[]): Promise<AgentBuildSkill[]>
  }
  status: {
    /** Network + auth health for offline banner */
    get(): Promise<OfflineStatus>
    probe(): Promise<OfflineStatus>
  }
  onMenuAction(cb: (action: string) => void): () => void
  /** Host platform ('darwin' | 'win32' | 'linux') */
  platform: string
  /** Absolute filesystem path of a dropped/selected File ('' if unavailable) */
  pathForFile(file: File): string
  getVersion(): Promise<string>
  revealLogs(): Promise<void>
  pickFolder(): Promise<string | null>
  openExternal(url: string): Promise<void>
}
