// Typed IPC surface between the renderer and the main process.
import { BrowserWindow, IpcMainInvokeEvent, Notification, app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  AgentEvent,
  Attachments,
  DEFAULT_SETTINGS,
  ModelId,
  PermissionRequest,
  ReasoningEffort,
  Settings
} from '@shared/types'
import { authManager } from './auth/store'
import { probeAccess } from './agent/provider'
import { profileFor } from './agent/profiles'
import { AgentRun } from './agent/loop'
import { restoreCheckpoint } from './agent/checkpoints'
import { MemoryTarget, memoryStore } from './agent/memory'
import { skillStore } from './agent/skills'
import { importSkillFolder, installFromGitHub } from './agent/skill-install'
import { listDir, readFilePreview, termManager } from './panels'
import { ensureCommandsDir, listCommands, resolveCommand } from './commands'
import { mcpManager } from './agent/mcp'
import { installMcpFromInput, previewMcpInstall } from './agent/mcp-install'
import { gitStatus } from './agent/git'
import { logsDirectory } from './logger'
import { suggestFiles } from './agent/tools'
import { sessionStore, sessionToMarkdown } from './sessions'
import {
  applySettingsPatch,
  assertExistingDir,
  assertId,
  isValidId,
  isValidJobId,
  loadSettingsFromDisk,
  mergeMcpSecrets,
  readSecretsBlob,
  splitMcpSecrets,
  writeSecretsBlob
} from './security'
import { appendAudit, clearAudit, exportAuditMarkdown, listAudit } from './audit'
import { addTrust, getTrust, isTrusted, removeTrust } from './workspace-trust'
import { createPullRequest, detectRepo } from './github'
import { MCP_CATALOG } from './mcp-catalog'
import { SKILL_CATALOG } from './skill-catalog'
import { buildAgentDraft, resolveSkills } from './agent/agent-builder'
import type { AgentBuildSkill } from '@shared/types'
import { logsDirectory as logsDir } from './logger'
import type {
  GitHubPrDraft,
  OfflineStatus,
  PaletteAction,
  SessionSearchHit
} from '@shared/types'

const runs = new Map<string, AgentRun>()
const pendingPermissions = new Map<
  string,
  {
    sessionId: string
    resolve: (res: { allow: boolean; alwaysAllow: boolean; globalAllow?: boolean }) => void
  }
>()

const pendingQuestions = new Map<string, { sessionId: string; resolve: (answer: string) => void }>()

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function userDataDir(): string {
  return app.getPath('userData')
}

/** Load public settings and re-attach encrypted MCP env secrets. */
function loadSettings(): Settings {
  const base = loadSettingsFromDisk(settingsFile())
  try {
    const secrets = readSecretsBlob(userDataDir())
    base.mcpServers = mergeMcpSecrets(base.mcpServers, secrets.mcpEnv)
  } catch {
    // secrets unavailable — MCP servers run without env
  }
  return base
}

/** Persist settings with MCP env stripped into secrets.bin. */
function saveSettings(s: Settings): void {
  const { publicServers, envByName } = splitMcpSecrets(s.mcpServers)
  const publicSettings: Settings = { ...s, mcpServers: publicServers }
  fs.writeFileSync(settingsFile(), JSON.stringify(publicSettings, null, 2), 'utf8')
  try {
    const existing = readSecretsBlob(userDataDir())
    writeSecretsBlob(userDataDir(), { mcpEnv: { ...existing.mcpEnv, ...envByName } })
    // Drop env for servers that were removed
    const names = new Set(publicServers.map((x) => x.name))
    const nextEnv: Record<string, Record<string, string>> = {}
    for (const [k, v] of Object.entries({ ...existing.mcpEnv, ...envByName })) {
      if (names.has(k)) nextEnv[k] = v
    }
    writeSecretsBlob(userDataDir(), { mcpEnv: nextEnv })
  } catch {
    // If secure storage is down, public settings still save; env is lost until re-entered.
  }
}

/** Settings returned to the renderer — MCP env values redacted. */
function publicSettingsView(s: Settings): Settings {
  return {
    ...s,
    mcpServers: s.mcpServers.map((srv) => ({
      ...srv,
      env: srv.env
        ? Object.fromEntries(Object.keys(srv.env).map((k) => [k, srv.env![k] ? '••••••••' : '']))
        : undefined
    }))
  }
}

let settings = DEFAULT_SETTINGS

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  settings = loadSettings()
  // Connect any configured MCP servers in the background.
  void mcpManager.sync(settings.mcpServers).catch(() => undefined)

  const emit = (ev: AgentEvent): void => {
    getWindow()?.webContents.send('agent:event', ev)
    maybeNotify(ev)
  }

  // System notification when the agent needs the user and the app is in the
  // background; clicking focuses the window on that session.
  const maybeNotify = (ev: AgentEvent): void => {
    if (!settings.notifications || !Notification.isSupported()) return
    const win = getWindow()
    if (!win || win.isFocused()) return
    let title: string | null = null
    let body = ''
    if (ev.type === 'permission-request') {
      title = 'Conduit needs approval'
      body = `${ev.request.toolName}: ${ev.request.summary}`.slice(0, 120)
    } else if (ev.type === 'turn-end' && (ev.stopReason === 'done' || ev.stopReason === 'error')) {
      title = ev.stopReason === 'done' ? 'Conduit finished a task' : 'Conduit hit an error'
    }
    if (!title) return
    const sessionId = 'sessionId' in ev ? ev.sessionId : undefined
    void (async () => {
      if (sessionId) {
        const rec = await sessionStore.load(sessionId).catch(() => null)
        if (rec && !body) body = rec.meta.title
      }
      const n = new Notification({ title, body, silent: false })
      n.on('click', () => {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        if (sessionId) win.webContents.send('menu:action', `focus-session:${sessionId}`)
      })
      n.show()
    })()
  }

  // Reject IPC from any frame that isn't our own window (defense in depth for
  // the sandboxed renderer).
  const senderOk = (e: IpcMainInvokeEvent): boolean => {
    const win = getWindow()
    return !!win && e.sender === win.webContents
  }
  const handle = (
    channel: string,
    // Variadic dispatch registry: each handler declares its own typed args
    // (e.g. (_e, id: string)). `unknown[]` would reject those via parameter
    // contravariance, so `any[]` is the pragmatic type for the boundary — the
    // individual handlers are the ones that narrow.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!senderOk(e)) throw new Error('IPC rejected: untrusted sender')
      return fn(e, ...args)
    })
  }

  handle('app:version', () => app.getVersion())

  // ---- auth
  handle('auth:getState', () => authManager.getState())
  handle('auth:loginOAuth', async () => {
    try {
      await authManager.loginOAuth()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('auth:setApiKey', (_e, key: string) => {
    try {
      authManager.setApiKey(key)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('auth:logout', () => authManager.logout())

  // ---- sessions
  handle('sessions:list', () => sessionStore.list())
  handle('sessions:create', (_e, opts: { cwd?: string; model?: ModelId }) => {
    // Only accept cwd that exists as a directory. Free-form absolute paths from
    // the renderer are allowed only if they resolve to a real dir (pickFolder /
    // Home recent projects). Reject path traversal / non-dirs.
    let cwd: string | undefined
    if (opts?.cwd) {
      try {
        cwd = assertExistingDir(String(opts.cwd))
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : 'Invalid working directory', { cause: err })
      }
    }
    const model =
      opts?.model === 'grok-4.3' || opts?.model === 'grok-build-0.1' ? opts.model : undefined
    const rec = sessionStore.create({ cwd, model, defaultModel: settings.defaultModel })
    return rec.meta
  })
  handle('sessions:load', async (_e, sessionId: string) => {
    if (!isValidId(sessionId)) return null
    const rec = await sessionStore.load(sessionId)
    if (!rec) return null
    const checkpoints = (rec.checkpoints ?? []).map((c) => ({
      itemId: c.id,
      ts: c.ts,
      fileCount: c.files.length
    }))
    // Rebuild the context meter from the last prompt size + model window so
    // reopening a session doesn't show a blank pill (or stale lifetime totals).
    const profile = profileFor(rec.meta.model)
    const contextTokens = rec.lastPromptTokens ?? 0
    const usage =
      contextTokens > 0 || (rec.meta.totalInputTokens ?? 0) > 0
        ? {
            contextTokens,
            contextWindow: profile.contextWindow,
            contextUsed: Math.min(1, contextTokens / profile.contextWindow),
            sessionInputTokens: rec.meta.totalInputTokens ?? 0,
            sessionOutputTokens: rec.meta.totalOutputTokens ?? 0,
            sessionCachedTokens: rec.meta.totalCachedTokens ?? 0
          }
        : undefined
    return { meta: rec.meta, items: rec.items, checkpoints, plan: rec.plan, usage }
  })
  handle('sessions:restoreCheckpoint', async (_e, sessionId: string, itemId: string) => {
    assertId(sessionId, 'sessionId')
    assertId(itemId, 'itemId')
    if (runs.has(sessionId)) throw new Error('Stop the agent before restoring a checkpoint')
    const rec = await sessionStore.load(sessionId)
    if (!rec) throw new Error('Session not found')
    const restored = await restoreCheckpoint(rec, itemId)
    if (restored > 0) {
      const note = {
        kind: 'note' as const,
        id: crypto.randomBytes(8).toString('hex'),
        ts: Date.now(),
        text: `↺ Restored ${restored} file${restored === 1 ? '' : 's'} to their state before this point`
      }
      rec.items.push(note)
      emit({ type: 'item', sessionId, item: note })
    }
    await sessionStore.save(rec)
    return { restored }
  })
  handle('sessions:delete', async (_e, sessionId: string) => {
    assertId(sessionId, 'sessionId')
    runs.get(sessionId)?.cancel()
    runs.delete(sessionId)
    await sessionStore.remove(sessionId)
  })
  handle('sessions:rename', async (_e, sessionId: string, title: string) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.title = title.slice(0, 120)
      await sessionStore.save(rec)
    }
  })
  handle('sessions:setModel', async (_e, sessionId: string, model: ModelId) => {
    assertId(sessionId, 'sessionId')
    if (model !== 'grok-4.3' && model !== 'grok-build-0.1') throw new Error('Invalid model')
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.model = model
      await sessionStore.save(rec)
    }
  })
  handle('sessions:createTeam', (_e, teamId: string, cwd: string) => {
    const team = settings.teams?.find((t) => t.id === teamId)
    if (!team) throw new Error('Unknown team')
    let dir: string
    try {
      dir = assertExistingDir(String(cwd))
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Invalid working directory', { cause: err })
    }
    const orchestrator = settings.customAgents?.find((a) => a.id === team.orchestratorId)
    const rec = sessionStore.create({ cwd: dir, defaultModel: settings.defaultModel })
    rec.meta.teamId = team.id
    rec.meta.title = team.name
    if (orchestrator) {
      rec.meta.agentId = orchestrator.id
      rec.meta.model = orchestrator.model
    }
    rec.teamState = { tasks: [], brief: '' }
    void sessionStore.save(rec)
    return rec.meta
  })
  handle('sessions:setAgent', async (_e, sessionId: string, agentId: string | null) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (!rec) return
    if (!agentId) {
      rec.meta.agentId = undefined
    } else {
      // Only accept an id that resolves to a defined agent; adopt its model so
      // the session runs on the agent's preferred model.
      const agent = settings.customAgents?.find((a) => a.id === agentId)
      if (!agent) throw new Error('Unknown agent')
      rec.meta.agentId = agent.id
      rec.meta.model = agent.model
    }
    await sessionStore.save(rec)
  })
  handle('sessions:setEffort', async (_e, sessionId: string, effort: ReasoningEffort | null) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.reasoningEffort =
        effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined
      await sessionStore.save(rec)
    }
  })
  handle('sessions:fork', async (_e, sessionId: string, itemId: string) => {
    assertId(sessionId, 'sessionId')
    assertId(itemId, 'itemId')
    const rec = await sessionStore.fork(sessionId, itemId)
    return rec ? rec.meta : null
  })
  handle('sessions:export', async (_e, sessionId: string) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (!rec) return null
    const win = getWindow()
    if (!win) return null
    const safeTitle = rec.meta.title.replace(/[^a-z0-9-_ ]/gi, '').slice(0, 60) || 'session'
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${safeTitle}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, sessionToMarkdown(rec), 'utf8')
    return res.filePath
  })
  handle('sessions:gitStatus', async (_e, sessionId: string) => {
    if (!isValidId(sessionId)) return { isRepo: false }
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { isRepo: false }
    return gitStatus(rec.meta.cwd)
  })

  // ---- agent
  const bindPermission = (
    sessionId: string,
    request: PermissionRequest
  ): Promise<{ allow: boolean; alwaysAllow: boolean; globalAllow?: boolean }> =>
    new Promise((resolve) => {
      pendingPermissions.set(request.requestId, { sessionId, resolve })
      emit({ type: 'permission-request', sessionId, request })
    })

  const bindQuestion = (
    sessionId: string,
    q: { question: string; options?: string[] }
  ): Promise<string> =>
    new Promise((resolve) => {
      const requestId = crypto.randomBytes(10).toString('hex')
      pendingQuestions.set(requestId, { sessionId, resolve })
      emit({ type: 'user-question', sessionId, request: { requestId, sessionId, ...q } })
    })

  handle(
    'agent:send',
    async (_e, sessionId: string, text: string, attachments?: Attachments) => {
      assertId(sessionId, 'sessionId')
      if (typeof text !== 'string' || text.length > 500_000) throw new Error('Invalid message')
      const rec = await sessionStore.load(sessionId)
      if (!rec) throw new Error('Session not found')
      if (runs.has(sessionId)) throw new Error('Agent is already running in this session')
      if (
        !isTrusted(rec.meta.cwd, settings.trustedWorkspaces, settings.requireWorkspaceTrust)
      ) {
        throw new Error(
          'This workspace is not trusted. Trust it from the banner or Settings → Security before running the agent.'
        )
      }

      const run = new AgentRun(
        rec,
        settings,
        emit,
        (request: PermissionRequest) => bindPermission(sessionId, request),
        () => saveSettings(settings),
        (q) => bindQuestion(sessionId, q)
      )
      runs.set(sessionId, run)
      void run.run(text, attachments).finally(() => runs.delete(sessionId))
    }
  )
  handle('agent:cancel', (_e, sessionId: string) => {
    if (!isValidId(sessionId)) return
    runs.get(sessionId)?.cancel()
  })
  handle('agent:isRunning', (_e, sessionId: string) =>
    isValidId(sessionId) ? runs.has(sessionId) : false
  )
  handle('agent:queue', (_e, sessionId: string, text: string) => {
    if (!isValidId(sessionId) || typeof text !== 'string') return false
    return runs.get(sessionId)?.queueMessage(text) ?? false
  })

  // Shared launcher for a fresh run (used by send, retry, edit-resend).
  const startRun = async (
    sessionId: string,
    text: string,
    attachments?: Attachments
  ): Promise<void> => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (!rec) throw new Error('Session not found')
    if (runs.has(sessionId)) throw new Error('Agent is already running in this session')
    if (!isTrusted(rec.meta.cwd, settings.trustedWorkspaces, settings.requireWorkspaceTrust)) {
      throw new Error('This workspace is not trusted. Trust it before running the agent.')
    }
    const run = new AgentRun(
      rec,
      settings,
      emit,
      (request: PermissionRequest) => bindPermission(sessionId, request),
      () => saveSettings(settings),
      (q) => bindQuestion(sessionId, q)
    )
    runs.set(sessionId, run)
    void run.run(text, attachments).finally(() => runs.delete(sessionId))
  }

  handle('agent:retry', async (_e, sessionId: string) => {
    assertId(sessionId, 'sessionId')
    if (runs.has(sessionId)) throw new Error('Agent is already running')
    const rec = await sessionStore.load(sessionId)
    if (!rec) throw new Error('Session not found')
    const lastUser = [...rec.items].reverse().find((i) => i.kind === 'user')
    if (!lastUser) return
    const text = await sessionStore.truncateAt(sessionId, lastUser.id)
    emit({ type: 'item', sessionId, item: { kind: 'note', id: crypto.randomBytes(8).toString('hex'), ts: Date.now(), text: '↻ Regenerating…' } })
    if (text !== null) await startRun(sessionId, text)
  })
  handle('agent:editResend', async (_e, sessionId: string, itemId: string, text: string) => {
    assertId(sessionId, 'sessionId')
    assertId(itemId, 'itemId')
    if (typeof text !== 'string') throw new Error('Invalid message')
    if (runs.has(sessionId)) throw new Error('Agent is already running')
    await sessionStore.truncateAt(sessionId, itemId)
    await startRun(sessionId, text)
  })
  handle(
    'agent:respondPermission',
    (
      _e,
      requestId: string,
      allow: boolean,
      alwaysAllow?: boolean,
      globalAllow?: boolean,
      sessionId?: string
    ) => {
      if (!isValidId(requestId)) return
      const pending = pendingPermissions.get(requestId)
      if (!pending) return
      // Bind response to the session that issued the request (single-use).
      if (sessionId && pending.sessionId !== sessionId) return
      pendingPermissions.delete(requestId)
      pending.resolve({
        allow: !!allow,
        alwaysAllow: alwaysAllow ?? false,
        globalAllow: globalAllow ?? false
      })
    }
  )
  handle('agent:respondQuestion', (_e, requestId: string, answer: string, sessionId?: string) => {
    if (!isValidId(requestId)) return
    const pending = pendingQuestions.get(requestId)
    if (!pending) return
    if (sessionId && pending.sessionId !== sessionId) return
    pendingQuestions.delete(requestId)
    pending.resolve(typeof answer === 'string' ? answer.slice(0, 10_000) : '')
  })

  // ---- memory
  handle('memory:entries', (_e, cwd?: string) => ({
    memory: memoryStore.entries('memory'),
    user: memoryStore.entries('user'),
    project: memoryStore.entries('project', cwd)
  }))
  handle('memory:removeEntry', (_e, target: MemoryTarget, text: string, cwd?: string) => {
    memoryStore.remove(target, text, cwd)
  })
  handle('memory:pending', () => memoryStore.listPending())
  handle('memory:resolvePending', (_e, pid: string | 'all', approve: boolean) =>
    memoryStore.resolvePending(pid, approve)
  )

  // ---- skills
  handle('skills:list', () => skillStore.list())
  handle('skills:get', (_e, name: string) => skillStore.read(name))
  handle('skills:remove', (_e, name: string) => {
    skillStore.save({ action: 'delete', name })
  })
  handle('skills:pending', () => skillStore.listPending())
  handle('skills:resolvePending', (_e, pid: string | 'all', approve: boolean) =>
    skillStore.resolvePending(pid, approve)
  )
  handle('skills:installGithub', (_e, url: string) => installFromGitHub(String(url)))
  handle('skills:reveal', (_e, name: string) => {
    const skill = skillStore.read(String(name))
    if (skill) shell.showItemInFolder(path.join(skill.dir, 'SKILL.md'))
  })
  handle('skills:setCategory', (_e, name: string, category: string) => {
    skillStore.setCategory(String(name), String(category ?? ''))
  })
  handle('skills:importFolder', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder containing a SKILL.md',
      properties: ['openDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return importSkillFolder(res.filePaths[0])
  })

  // ---- files
  handle('files:suggest', async (_e, sessionId: string, query: string) => {
    if (!isValidId(sessionId)) return []
    const rec = await sessionStore.load(sessionId)
    if (!rec) return []
    return suggestFiles(rec.meta.cwd, String(query ?? '').slice(0, 200))
  })

  // ---- slash commands
  handle('commands:list', () => listCommands())
  handle('commands:resolve', (_e, name: string, args: string) =>
    resolveCommand(String(name ?? '').slice(0, 64), String(args ?? '').slice(0, 4000))
  )
  handle('commands:openFolder', () => shell.openPath(ensureCommandsDir()))

  // ---- right dock panels
  handle('panels:listDir', async (_e, sessionId: string, rel: string) => {
    if (!isValidId(sessionId)) return []
    const rec = await sessionStore.load(sessionId)
    return rec ? listDir(rec.meta.cwd, String(rel ?? '')) : []
  })
  handle('panels:readFile', async (_e, sessionId: string, rel: string) => {
    if (!isValidId(sessionId)) return { kind: 'error', message: 'Session not found.' }
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { kind: 'error', message: 'Session not found.' }
    return readFilePreview(rec.meta.cwd, String(rel ?? ''))
  })

  // Terminal: session must exist; job ids validated; command length capped.
  // Terminal is an intentional user shell surface (not agent-gated) — only the
  // owning session's cwd is used, never a renderer-supplied path.
  const requireSession = async (sessionId: string) => {
    if (!isValidId(sessionId)) return null
    return sessionStore.load(sessionId)
  }
  const capCmd = (command: unknown): string => String(command ?? '').slice(0, 32_000)

  handle('term:open', async (_e, sessionId: string) => {
    const rec = await requireSession(sessionId)
    if (!rec) {
      return {
        sessionId: isValidId(sessionId) ? sessionId : '',
        mode: 'spawn' as const,
        jobs: [],
        activeJobId: '',
        buffers: {},
        history: [],
        shell: '',
        workspaceCwd: ''
      }
    }
    return termManager.open(sessionId, rec.meta.cwd)
  })
  handle(
    'term:run',
    async (
      _e,
      sessionId: string,
      command: string,
      opts?: { jobId?: string; name?: string; newJob?: boolean }
    ) => {
      const rec = await requireSession(sessionId)
      if (!rec) return { ok: false, error: 'Session not found.' }
      if (opts?.jobId && !isValidJobId(opts.jobId)) return { ok: false, error: 'Invalid job.' }
      return termManager.run(sessionId, rec.meta.cwd, capCmd(command), {
        ...opts,
        name: opts?.name ? String(opts.name).slice(0, 80) : undefined
      })
    }
  )
  handle('term:createJob', async (_e, sessionId: string, name?: string) => {
    const rec = await requireSession(sessionId)
    if (!rec) return { ok: false, error: 'Session not found.' }
    return termManager.createJob(sessionId, rec.meta.cwd, name ? String(name).slice(0, 80) : undefined)
  })
  handle('term:write', (_e, sessionId: string, data: string, jobId?: string) => {
    if (!isValidId(sessionId) || (jobId && !isValidJobId(jobId))) return
    // Cap stdin chunks so a compromised renderer can't flood the PTY.
    termManager.write(sessionId, String(data ?? '').slice(0, 16_384), jobId)
  })
  handle(
    'term:resize',
    (_e, sessionId: string, cols: number, rows: number, jobId?: string) => {
      if (!isValidId(sessionId) || (jobId && !isValidJobId(jobId))) return
      termManager.resize(
        sessionId,
        Math.min(Math.max(Number(cols) || 80, 20), 500),
        Math.min(Math.max(Number(rows) || 24, 5), 200),
        jobId
      )
    }
  )
  handle('term:kill', (_e, sessionId: string, jobId?: string) => {
    if (!isValidId(sessionId) || (jobId && !isValidJobId(jobId))) return
    termManager.kill(sessionId, jobId)
  })
  handle('term:closeJob', async (_e, sessionId: string, jobId: string) => {
    const rec = await requireSession(sessionId)
    if (!rec || !isValidJobId(jobId)) return null
    return termManager.closeJob(sessionId, jobId) ?? termManager.snapshot(sessionId, rec.meta.cwd)
  })
  handle('term:setActiveJob', (_e, sessionId: string, jobId: string) => {
    if (!isValidId(sessionId) || !isValidJobId(jobId)) return
    termManager.setActiveJob(sessionId, jobId)
  })
  handle('term:clear', (_e, sessionId: string, jobId?: string) => {
    if (!isValidId(sessionId) || (jobId && !isValidJobId(jobId))) return
    termManager.clear(sessionId, jobId)
  })
  handle('term:restart', async (_e, sessionId: string, jobId?: string) => {
    const rec = await requireSession(sessionId)
    if (!rec) return { ok: false, error: 'Session not found.' }
    if (jobId && !isValidJobId(jobId)) return { ok: false, error: 'Invalid job.' }
    return termManager.restart(sessionId, rec.meta.cwd, jobId)
  })
  handle('term:snapshot', async (_e, sessionId: string) => {
    const rec = await requireSession(sessionId)
    return termManager.snapshot(sessionId, rec?.meta.cwd)
  })
  handle('term:history', (_e, sessionId: string) =>
    isValidId(sessionId) ? termManager.history(sessionId) : []
  )
  handle('term:openExternal', async (_e, sessionId: string) => {
    const rec = await requireSession(sessionId)
    if (rec) termManager.openExternal(rec.meta.cwd)
  })
  handle(
    'term:pin',
    async (_e, sessionId: string, command: string, name?: string) => {
      const rec = await requireSession(sessionId)
      if (!rec) return { ok: false, error: 'Session not found.' }
      // Pin is only for agent-originated commands the user already saw in chat.
      return termManager.pinAgentCommand(
        sessionId,
        rec.meta.cwd,
        capCmd(command),
        name ? String(name).slice(0, 80) : undefined
      )
    }
  )

  // ---- mcp
  handle('mcp:status', () => mcpManager.status())
  handle('mcp:reconnect', async () => {
    await mcpManager.sync(settings.mcpServers)
    return mcpManager.status()
  })
  handle('mcp:previewInstall', (_e, input: string) =>
    previewMcpInstall(String(input ?? '').slice(0, 2000))
  )
  handle(
    'mcp:install',
    async (
      _e,
      input: string,
      opts?: { name?: string; env?: Record<string, string>; extraArgs?: string[] }
    ) => {
      const win = getWindow()
      if (!win) return { ok: false, error: 'No window' }
      // Native confirm before downloading/spawning third-party MCP code.
      const preview = await previewMcpInstall(String(input ?? '').slice(0, 2000))
      if (!preview.ok) return preview
      const detail = [
        preview.source ? `Source: ${preview.source}` : null,
        preview.command ? `Command: ${preview.command} ${(preview.args ?? []).join(' ')}` : null,
        ...(preview.notes ?? [])
      ]
        .filter(Boolean)
        .join('\n')
      const choice = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Install', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Install MCP server?',
        message: `Install MCP server “${preview.name ?? 'unknown'}”?`,
        detail:
          detail +
          '\n\nThis will download and run third-party code with your user privileges.'
      })
      if (choice.response !== 0) return { ok: false, error: 'Install cancelled.' }

      const safeOpts = {
        name: opts?.name ? String(opts.name).slice(0, 64) : undefined,
        env:
          opts?.env && typeof opts.env === 'object'
            ? Object.fromEntries(
                Object.entries(opts.env)
                  .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === 'string')
                  .map(([k, v]) => [k, String(v).slice(0, 8192)])
                  .slice(0, 40)
              )
            : undefined,
        extraArgs: Array.isArray(opts?.extraArgs)
          ? opts!.extraArgs!.filter((a) => typeof a === 'string').map((a) => a.slice(0, 512)).slice(0, 20)
          : undefined
      }
      const result = await installMcpFromInput(String(input ?? '').slice(0, 2000), safeOpts)
      if (!result.ok || !result.server) return result
      const next = [
        ...settings.mcpServers.filter((s) => s.name !== result.server!.name),
        result.server
      ]
      settings = { ...settings, mcpServers: next }
      saveSettings(settings)
      await mcpManager.sync(settings.mcpServers).catch(() => undefined)
      return { ...result, status: mcpManager.status() }
    }
  )

  // ---- settings & misc
  handle('settings:get', () => publicSettingsView(settings))
  handle('settings:set', async (_e, patch: Partial<Settings>) => {
    // Schema-validate; unknown keys dropped. MCP command changes require confirm.
    const prevMcp = JSON.stringify(
      settings.mcpServers.map((s) => ({ name: s.name, command: s.command, args: s.args, enabled: s.enabled }))
    )
    // Restore real env values when renderer sends redacted placeholders.
    if (Array.isArray(patch?.mcpServers)) {
      patch = {
        ...patch,
        mcpServers: patch.mcpServers.map((incoming) => {
          const existing = settings.mcpServers.find((s) => s.name === incoming.name)
          if (!incoming.env || !existing?.env) return incoming
          const merged: Record<string, string> = { ...(existing.env ?? {}) }
          for (const [k, v] of Object.entries(incoming.env)) {
            if (v && v !== '••••••••') merged[k] = v
          }
          return { ...incoming, env: merged }
        })
      }
    }
    const next = applySettingsPatch(settings, patch)
    const nextMcp = JSON.stringify(
      next.mcpServers.map((s) => ({ name: s.name, command: s.command, args: s.args, enabled: s.enabled }))
    )
    if (nextMcp !== prevMcp) {
      const win = getWindow()
      if (win) {
        const choice = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Apply', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Change MCP servers?',
          message: 'Apply MCP server configuration changes?',
          detail:
            'MCP servers run as local processes with your user privileges. ' +
            'Only apply changes you initiated.'
        })
        if (choice.response !== 0) return publicSettingsView(settings)
      }
    }
    const mcpChanged = nextMcp !== prevMcp
    settings = next
    saveSettings(settings)
    if (mcpChanged) void mcpManager.sync(settings.mcpServers).catch(() => undefined)
    return publicSettingsView(settings)
  })
  handle('auth:probe', () => probeAccess())
  handle('revealLogs', () => shell.openPath(logsDirectory()))
  handle('pickFolder', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    try {
      return assertExistingDir(res.filePaths[0])
    } catch {
      return null
    }
  })
  handle('openExternal', (_e, url: string) => {
    try {
      const parsed = new URL(String(url ?? ''))
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return shell.openExternal(parsed.toString())
      }
    } catch {
      // invalid URL
    }
    return undefined
  })

  // ---- sessions: search / plan-only / turn changes
  handle('sessions:search', async (_e, query: string, limit?: number) => {
    const q = String(query ?? '').trim().toLowerCase().slice(0, 200)
    if (!q) return []
    const max = Math.min(Number(limit) || 30, 100)
    const hits: SessionSearchHit[] = []
    for (const meta of sessionStore.list()) {
      if (hits.length >= max) break
      if (meta.title.toLowerCase().includes(q)) {
        hits.push({
          sessionId: meta.id,
          title: meta.title,
          cwd: meta.cwd,
          updatedAt: meta.updatedAt,
          snippet: meta.title,
          matchField: 'title'
        })
        continue
      }
      if (meta.cwd.toLowerCase().includes(q)) {
        hits.push({
          sessionId: meta.id,
          title: meta.title,
          cwd: meta.cwd,
          updatedAt: meta.updatedAt,
          snippet: meta.cwd,
          matchField: 'cwd'
        })
        continue
      }
      if (meta.digest?.toLowerCase().includes(q)) {
        hits.push({
          sessionId: meta.id,
          title: meta.title,
          cwd: meta.cwd,
          updatedAt: meta.updatedAt,
          snippet: meta.digest.slice(0, 160),
          matchField: 'digest'
        })
        continue
      }
      // Light message scan for open/cached sessions only
      const rec = await sessionStore.load(meta.id).catch(() => null)
      if (!rec) continue
      for (const item of rec.items.slice(-40)) {
        if (item.kind === 'user' && item.text.toLowerCase().includes(q)) {
          hits.push({
            sessionId: meta.id,
            title: meta.title,
            cwd: meta.cwd,
            updatedAt: meta.updatedAt,
            snippet: item.text.slice(0, 160),
            matchField: 'message'
          })
          break
        }
      }
    }
    return hits
  })
  handle('sessions:setPlanOnly', async (_e, sessionId: string, planOnly: boolean) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (!rec) return
    rec.meta.planOnly = !!planOnly
    await sessionStore.save(rec)
  })
  handle('sessions:turnChanges', async (_e, sessionId: string) => {
    if (!isValidId(sessionId)) return null
    const rec = await sessionStore.load(sessionId)
    if (!rec?.lastTurnChanges?.length) return null
    return {
      sessionId,
      files: rec.lastTurnChanges,
      plan: rec.plan
    }
  })

  // ---- workspace trust
  handle('workspace:getTrust', (_e, cwd: string) =>
    getTrust(String(cwd ?? ''), settings.trustedWorkspaces)
  )
  handle('workspace:setTrust', (_e, cwd: string, level: 'trusted' | 'denied') => {
    const c = String(cwd ?? '')
    if (level === 'trusted') {
      settings = {
        ...settings,
        trustedWorkspaces: addTrust(c, settings.trustedWorkspaces)
      }
    } else {
      settings = {
        ...settings,
        trustedWorkspaces: removeTrust(c, settings.trustedWorkspaces)
      }
    }
    saveSettings(settings)
    if (settings.auditLogEnabled) {
      appendAudit('trust', `${level} ${c}`)
    }
    return getTrust(c, settings.trustedWorkspaces)
  })
  handle('workspace:listTrusted', () => settings.trustedWorkspaces)

  // ---- audit
  handle('audit:list', (_e, limit?: number) =>
    settings.auditLogEnabled ? listAudit(Number(limit) || 200) : []
  )
  handle('audit:clear', () => {
    clearAudit()
  })
  handle('audit:export', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showSaveDialog(win, {
      defaultPath: 'conduit-audit.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, exportAuditMarkdown(), 'utf8')
    return res.filePath
  })

  // ---- command palette catalog (renderer executes most actions)
  handle('palette:list', () => {
    const actions: PaletteAction[] = [
      { id: 'new-session', label: 'New session', section: 'Session', shortcut: '⌘N' },
      { id: 'switch-session', label: 'Switch session…', section: 'Session', shortcut: '⌘K' },
      { id: 'search-sessions', label: 'Search sessions…', section: 'Session' },
      { id: 'export-session', label: 'Export session…', section: 'Session', shortcut: '⇧⌘E' },
      { id: 'home', label: 'Go home', section: 'Session' },
      { id: 'settings', label: 'Settings…', section: 'App', shortcut: '⌘,' },
      { id: 'command-palette', label: 'Command palette', section: 'App', shortcut: '⇧⌘P' },
      { id: 'focus-input', label: 'Focus message input', section: 'Agent', shortcut: '⌘L' },
      { id: 'stop-agent', label: 'Stop agent', section: 'Agent', shortcut: '⌘.' },
      { id: 'toggle-plan-only', label: 'Toggle plan-only mode', section: 'Agent' },
      { id: 'open-terminal', label: 'Open terminal panel', section: 'Panels' },
      { id: 'open-review', label: 'Open review / diffs', section: 'Panels' },
      { id: 'check-update', label: 'Check for updates', section: 'App' },
      { id: 'reveal-logs', label: 'Reveal logs', section: 'App' },
      { id: 'copy-diagnostics', label: 'Copy diagnostics bundle', section: 'App' },
      { id: 'create-pr', label: 'Create GitHub pull request…', section: 'Git' }
    ]
    return actions
  })

  // ---- github
  handle('github:repo', async (_e, sessionId: string) => {
    if (!isValidId(sessionId)) return null
    const rec = await sessionStore.load(sessionId)
    if (!rec) return null
    return detectRepo(rec.meta.cwd)
  })
  handle('github:createPr', async (_e, sessionId: string, draft: GitHubPrDraft) => {
    assertId(sessionId, 'sessionId')
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { ok: false, error: 'Session not found' }
    const title = String(draft?.title ?? '').trim()
    if (!title) return { ok: false, error: 'Title required' }
    const result = await createPullRequest(rec.meta.cwd, {
      title,
      body: draft?.body,
      base: draft?.base,
      head: draft?.head,
      draft: draft?.draft
    })
    if (settings.auditLogEnabled) {
      appendAudit('agent', result.ok ? `PR created: ${result.pr?.url}` : `PR failed: ${result.error}`, {
        sessionId
      })
    }
    return result
  })
  handle('github:openPr', (_e, url: string) => {
    try {
      const u = new URL(String(url ?? ''))
      if (u.protocol === 'https:' && /(^|\.)github\.com$/i.test(u.hostname)) {
        return shell.openExternal(u.toString())
      }
    } catch {
      /* ignore */
    }
    return undefined
  })

  // ---- crash / diagnostics
  handle('crash:list', () => {
    const dir = path.join(app.getPath('userData'), 'Crashpad', 'completed')
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.dmp'))
        .slice(0, 50)
        .map((f) => {
          const p = path.join(dir, f)
          const st = fs.statSync(p)
          return { id: f, ts: st.mtimeMs, path: p, version: app.getVersion() }
        })
        .sort((a, b) => b.ts - a.ts)
    } catch {
      return []
    }
  })
  handle('crash:reveal', () => shell.openPath(logsDirectory()))
  handle('crash:copyDiagnostics', async () => {
    const win = getWindow()
    if (!win) return { ok: false, error: 'No window' }
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `conduit-diagnostics-${app.getVersion()}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, error: 'Cancelled' }
    const lines = [
      `# Conduit diagnostics`,
      ``,
      `- Version: ${app.getVersion()}`,
      `- Platform: ${process.platform} ${process.arch}`,
      `- Electron: ${process.versions.electron}`,
      `- Date: ${new Date().toISOString()}`,
      `- Logs: ${logsDir()}`,
      ``,
      `## Recent audit`,
      exportAuditMarkdown().split('\n').slice(0, 40).join('\n')
    ]
    fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8')
    return { ok: true, path: res.filePath }
  })

  // ---- MCP catalog
  handle('mcpCatalog:list', () => MCP_CATALOG)

  // ---- skill catalog + AI agent builder
  handle('skillCatalog:list', () => SKILL_CATALOG)
  handle('agents:build', (_e, prompt: string) => buildAgentDraft(String(prompt ?? ''), settings))
  handle('agents:resolveSkills', (_e, items: AgentBuildSkill[]) =>
    resolveSkills(Array.isArray(items) ? items : [], settings)
  )

  // ---- offline / auth status
  handle('status:get', async (): Promise<OfflineStatus> => {
    const auth = authManager.getState()
    return {
      online: true,
      authOk: !!auth.method,
      message: auth.method ? undefined : 'Not signed in',
      checkedAt: Date.now()
    }
  })
  handle('status:probe', async (): Promise<OfflineStatus> => {
    try {
      const r = await probeAccess()
      return {
        online: r.ok || r.status !== 0,
        authOk: r.ok,
        message: r.ok ? undefined : r.message,
        checkedAt: Date.now()
      }
    } catch (err) {
      return {
        online: false,
        authOk: false,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now()
      }
    }
  })
}
