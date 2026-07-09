import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  Attachments,
  HarnessApi,
  ModelId,
  Settings,
  TermData,
  UpdateInfo
} from '@shared/types'

const api: HarnessApi = {
  auth: {
    getState: () => ipcRenderer.invoke('auth:getState'),
    loginOAuth: () => ipcRenderer.invoke('auth:loginOAuth'),
    setApiKey: (key: string) => ipcRenderer.invoke('auth:setApiKey', key),
    logout: () => ipcRenderer.invoke('auth:logout'),
    probe: () => ipcRenderer.invoke('auth:probe')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (opts) => ipcRenderer.invoke('sessions:create', opts),
    load: (id) => ipcRenderer.invoke('sessions:load', id),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
    setModel: (id, model: ModelId) => ipcRenderer.invoke('sessions:setModel', id, model),
    setEffort: (id, effort) => ipcRenderer.invoke('sessions:setEffort', id, effort),
    restoreCheckpoint: (sessionId, itemId) =>
      ipcRenderer.invoke('sessions:restoreCheckpoint', sessionId, itemId),
    fork: (sessionId, itemId) => ipcRenderer.invoke('sessions:fork', sessionId, itemId),
    export: (sessionId) => ipcRenderer.invoke('sessions:export', sessionId),
    gitStatus: (sessionId) => ipcRenderer.invoke('sessions:gitStatus', sessionId)
  },
  agent: {
    send: (sessionId, text, attachments?: Attachments) =>
      ipcRenderer.invoke('agent:send', sessionId, text, attachments),
    cancel: (sessionId) => ipcRenderer.invoke('agent:cancel', sessionId),
    queue: (sessionId, text) => ipcRenderer.invoke('agent:queue', sessionId, text),
    retry: (sessionId) => ipcRenderer.invoke('agent:retry', sessionId),
    editResend: (sessionId, itemId, text) =>
      ipcRenderer.invoke('agent:editResend', sessionId, itemId, text),
    isRunning: (sessionId) => ipcRenderer.invoke('agent:isRunning', sessionId),
    respondPermission: (requestId, allow, alwaysAllow, globalAllow) =>
      ipcRenderer.invoke('agent:respondPermission', requestId, allow, alwaysAllow, globalAllow),
    onEvent: (cb: (ev: AgentEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    }
  },
  memory: {
    entries: (cwd?: string) => ipcRenderer.invoke('memory:entries', cwd),
    removeEntry: (target, text, cwd?: string) =>
      ipcRenderer.invoke('memory:removeEntry', target, text, cwd),
    pending: () => ipcRenderer.invoke('memory:pending'),
    resolvePending: (id, approve) => ipcRenderer.invoke('memory:resolvePending', id, approve)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (name: string) => ipcRenderer.invoke('skills:get', name),
    remove: (name: string) => ipcRenderer.invoke('skills:remove', name),
    pending: () => ipcRenderer.invoke('skills:pending'),
    resolvePending: (id, approve) => ipcRenderer.invoke('skills:resolvePending', id, approve),
    installGithub: (url: string) => ipcRenderer.invoke('skills:installGithub', url),
    importFolder: () => ipcRenderer.invoke('skills:importFolder'),
    reveal: (name: string) => ipcRenderer.invoke('skills:reveal', name)
  },
  files: {
    suggest: (sessionId, query) => ipcRenderer.invoke('files:suggest', sessionId, query)
  },
  commands: {
    list: () => ipcRenderer.invoke('commands:list'),
    resolve: (name: string, args: string) => ipcRenderer.invoke('commands:resolve', name, args),
    openFolder: () => ipcRenderer.invoke('commands:openFolder')
  },
  panels: {
    listDir: (sessionId, rel) => ipcRenderer.invoke('panels:listDir', sessionId, rel),
    readFile: (sessionId, rel) => ipcRenderer.invoke('panels:readFile', sessionId, rel)
  },
  term: {
    open: (sessionId) => ipcRenderer.invoke('term:open', sessionId),
    run: (sessionId, command, opts) => ipcRenderer.invoke('term:run', sessionId, command, opts),
    createJob: (sessionId, name) => ipcRenderer.invoke('term:createJob', sessionId, name),
    write: (sessionId, data, jobId) => ipcRenderer.invoke('term:write', sessionId, data, jobId),
    resize: (sessionId, cols, rows, jobId) =>
      ipcRenderer.invoke('term:resize', sessionId, cols, rows, jobId),
    kill: (sessionId, jobId) => ipcRenderer.invoke('term:kill', sessionId, jobId),
    closeJob: (sessionId, jobId) => ipcRenderer.invoke('term:closeJob', sessionId, jobId),
    setActiveJob: (sessionId, jobId) => ipcRenderer.invoke('term:setActiveJob', sessionId, jobId),
    clear: (sessionId, jobId) => ipcRenderer.invoke('term:clear', sessionId, jobId),
    restart: (sessionId, jobId) => ipcRenderer.invoke('term:restart', sessionId, jobId),
    snapshot: (sessionId) => ipcRenderer.invoke('term:snapshot', sessionId),
    openExternal: (sessionId) => ipcRenderer.invoke('term:openExternal', sessionId),
    history: (sessionId) => ipcRenderer.invoke('term:history', sessionId),
    pin: (sessionId, command, name) => ipcRenderer.invoke('term:pin', sessionId, command, name),
    onData: (cb: (data: TermData) => void) => {
      const l = (_e: Electron.IpcRendererEvent, data: TermData): void => cb(data)
      ipcRenderer.on('term:data', l)
      return () => ipcRenderer.removeListener('term:data', l)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch)
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    reconnect: () => ipcRenderer.invoke('mcp:reconnect'),
    previewInstall: (input) => ipcRenderer.invoke('mcp:previewInstall', input),
    install: (input, opts) => ipcRenderer.invoke('mcp:install', input, opts)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onAvailable: (cb: (info: UpdateInfo) => void) => {
      const l = (_e: Electron.IpcRendererEvent, info: UpdateInfo): void => cb(info)
      ipcRenderer.on('update:available', l)
      return () => ipcRenderer.removeListener('update:available', l)
    },
    onDownloaded: (cb: (info: UpdateInfo) => void) => {
      const l = (_e: Electron.IpcRendererEvent, info: UpdateInfo): void => cb(info)
      ipcRenderer.on('update:downloaded', l)
      return () => ipcRenderer.removeListener('update:downloaded', l)
    }
  },
  onMenuAction: (cb: (action: string) => void) => {
    const l = (_e: Electron.IpcRendererEvent, action: string): void => cb(action)
    ipcRenderer.on('menu:action', l)
    return () => ipcRenderer.removeListener('menu:action', l)
  },
  /** Absolute filesystem path of a dropped/selected File (sandbox-safe) */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  platform: process.platform,
  revealLogs: () => ipcRenderer.invoke('revealLogs'),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url)
}

contextBridge.exposeInMainWorld('harness', api)
