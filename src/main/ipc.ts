// Typed IPC surface between the renderer and the main process.
import { BrowserWindow, IpcMainInvokeEvent, app, dialog, ipcMain, shell } from 'electron'
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
import { AgentRun } from './agent/loop'
import { restoreCheckpoint } from './agent/checkpoints'
import { MemoryTarget, memoryStore } from './agent/memory'
import { skillStore } from './agent/skills'
import { importSkillFolder, installFromGitHub } from './agent/skill-install'
import { listDir, readFilePreview, termManager } from './panels'
import { mcpManager } from './agent/mcp'
import { gitStatus } from './agent/git'
import { logsDirectory } from './logger'
import { suggestFiles } from './agent/tools'
import { sessionStore, sessionToMarkdown } from './sessions'

const runs = new Map<string, AgentRun>()
const pendingPermissions = new Map<
  string,
  (res: { allow: boolean; alwaysAllow: boolean; globalAllow?: boolean }) => void
>()

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s: Settings): void {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8')
}

let settings = DEFAULT_SETTINGS

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  settings = loadSettings()
  // Connect any configured MCP servers in the background.
  void mcpManager.sync(settings.mcpServers).catch(() => undefined)

  const emit = (ev: AgentEvent): void => {
    getWindow()?.webContents.send('agent:event', ev)
  }

  // Reject IPC from any frame that isn't our own window (defense in depth for
  // the sandboxed renderer).
  const senderOk = (e: IpcMainInvokeEvent): boolean => {
    const win = getWindow()
    return !!win && e.sender === win.webContents
  }
  const handle = (
    channel: string,
    fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!senderOk(e)) throw new Error('IPC rejected: untrusted sender')
      return fn(e, ...args)
    })
  }

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
    const rec = sessionStore.create({ ...opts, defaultModel: settings.defaultModel })
    return rec.meta
  })
  handle('sessions:load', async (_e, sessionId: string) => {
    const rec = await sessionStore.load(sessionId)
    if (!rec) return null
    const checkpoints = (rec.checkpoints ?? []).map((c) => ({
      itemId: c.id,
      ts: c.ts,
      fileCount: c.files.length
    }))
    return { meta: rec.meta, items: rec.items, checkpoints, plan: rec.plan }
  })
  handle('sessions:restoreCheckpoint', async (_e, sessionId: string, itemId: string) => {
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
    runs.get(sessionId)?.cancel()
    runs.delete(sessionId)
    await sessionStore.remove(sessionId)
  })
  handle('sessions:rename', async (_e, sessionId: string, title: string) => {
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.title = title.slice(0, 120)
      await sessionStore.save(rec)
    }
  })
  handle('sessions:setModel', async (_e, sessionId: string, model: ModelId) => {
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.model = model
      await sessionStore.save(rec)
    }
  })
  handle('sessions:setEffort', async (_e, sessionId: string, effort: ReasoningEffort | null) => {
    const rec = await sessionStore.load(sessionId)
    if (rec) {
      rec.meta.reasoningEffort =
        effort === 'low' || effort === 'medium' || effort === 'high' ? effort : undefined
      await sessionStore.save(rec)
    }
  })
  handle('sessions:fork', async (_e, sessionId: string, itemId: string) => {
    const rec = await sessionStore.fork(sessionId, itemId)
    return rec ? rec.meta : null
  })
  handle('sessions:export', async (_e, sessionId: string) => {
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
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { isRepo: false }
    return gitStatus(rec.meta.cwd)
  })

  // ---- agent
  handle(
    'agent:send',
    async (_e, sessionId: string, text: string, attachments?: Attachments) => {
      const rec = await sessionStore.load(sessionId)
      if (!rec) throw new Error('Session not found')
      if (runs.has(sessionId)) throw new Error('Agent is already running in this session')

      const run = new AgentRun(
        rec,
        settings,
        emit,
        (request: PermissionRequest) => {
          return new Promise((resolve) => {
            pendingPermissions.set(request.requestId, resolve)
            emit({ type: 'permission-request', sessionId, request })
          })
        },
        () => saveSettings(settings)
      )
      runs.set(sessionId, run)
      void run.run(text, attachments).finally(() => runs.delete(sessionId))
    }
  )
  handle('agent:cancel', (_e, sessionId: string) => {
    runs.get(sessionId)?.cancel()
  })
  handle('agent:isRunning', (_e, sessionId: string) => runs.has(sessionId))
  handle('agent:queue', (_e, sessionId: string, text: string) => {
    return runs.get(sessionId)?.queueMessage(text) ?? false
  })

  // Shared launcher for a fresh run (used by send, retry, edit-resend).
  const startRun = async (
    sessionId: string,
    text: string,
    attachments?: Attachments
  ): Promise<void> => {
    const rec = await sessionStore.load(sessionId)
    if (!rec) throw new Error('Session not found')
    if (runs.has(sessionId)) throw new Error('Agent is already running in this session')
    const run = new AgentRun(
      rec,
      settings,
      emit,
      (request: PermissionRequest) =>
        new Promise((resolve) => {
          pendingPermissions.set(request.requestId, resolve)
          emit({ type: 'permission-request', sessionId, request })
        }),
      () => saveSettings(settings)
    )
    runs.set(sessionId, run)
    void run.run(text, attachments).finally(() => runs.delete(sessionId))
  }

  handle('agent:retry', async (_e, sessionId: string) => {
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
    if (runs.has(sessionId)) throw new Error('Agent is already running')
    await sessionStore.truncateAt(sessionId, itemId)
    await startRun(sessionId, text)
  })
  handle(
    'agent:respondPermission',
    (_e, requestId: string, allow: boolean, alwaysAllow?: boolean, globalAllow?: boolean) => {
      const resolve = pendingPermissions.get(requestId)
      pendingPermissions.delete(requestId)
      resolve?.({ allow, alwaysAllow: alwaysAllow ?? false, globalAllow: globalAllow ?? false })
    }
  )

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
    const rec = await sessionStore.load(sessionId)
    if (!rec) return []
    return suggestFiles(rec.meta.cwd, query)
  })

  // ---- right dock panels
  handle('panels:listDir', async (_e, sessionId: string, rel: string) => {
    const rec = await sessionStore.load(sessionId)
    return rec ? listDir(rec.meta.cwd, String(rel ?? '')) : []
  })
  handle('panels:readFile', async (_e, sessionId: string, rel: string) => {
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { kind: 'error', message: 'Session not found.' }
    return readFilePreview(rec.meta.cwd, String(rel ?? ''))
  })
  handle('term:run', async (_e, sessionId: string, command: string) => {
    const rec = await sessionStore.load(sessionId)
    if (!rec) return { ok: false, error: 'Session not found.' }
    return termManager.run(sessionId, rec.meta.cwd, String(command ?? ''))
  })
  handle('term:kill', (_e, sessionId: string) => termManager.kill(sessionId))
  handle('term:snapshot', (_e, sessionId: string) => termManager.snapshot(sessionId))

  // ---- mcp
  handle('mcp:status', () => mcpManager.status())
  handle('mcp:reconnect', async () => {
    await mcpManager.sync(settings.mcpServers)
    return mcpManager.status()
  })

  // ---- settings & misc
  handle('settings:get', () => settings)
  handle('settings:set', (_e, patch: Partial<Settings>) => {
    const mcpChanged =
      patch.mcpServers !== undefined &&
      JSON.stringify(patch.mcpServers) !== JSON.stringify(settings.mcpServers)
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (mcpChanged) void mcpManager.sync(settings.mcpServers).catch(() => undefined)
    return settings
  })
  handle('auth:probe', () => probeAccess())
  handle('revealLogs', () => shell.openPath(logsDirectory()))
  handle('pickFolder', async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  handle('openExternal', (_e, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return shell.openExternal(url)
    }
    return undefined
  })
}
