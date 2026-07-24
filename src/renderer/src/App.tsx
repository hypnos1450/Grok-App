import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import {
  AuthState,
  ModelId,
  OfflineStatus,
  SessionMeta,
  Settings,
  UpdateInfo,
  WorkspaceTrustState
} from '@shared/types'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Home from './components/Home'
import SettingsModal from './components/SettingsModal'
import RightDock from './components/RightDock'
import CommandPalette from './components/CommandPalette'
import SessionSearch from './components/SessionSearch'
import { XIcon } from './components/Icons'

export default function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [teamPickerOpen, setTeamPickerOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [offline, setOffline] = useState<OfflineStatus | null>(null)
  const [trust, setTrust] = useState<WorkspaceTrustState | null>(null)
  const [forceOpenTerm, setForceOpenTerm] = useState(0)
  const [forceOpenReview, setForceOpenReview] = useState(0)
  /** Per-session activity for the sidebar: running / blocked on approval / finished unseen */
  const [sessionStatus, setSessionStatus] = useState<Record<string, 'running' | 'blocked' | 'done'>>({})
  const chatActions = useRef<{
    focusInput?: () => void
    exportSession?: () => void
    insertText?: (text: string) => void
    togglePlanOnly?: () => void
    createPr?: () => void
  }>({})
  // Mirror the latest activeId into a ref so the long-lived agent event
  // handler (set up once) can read it without re-subscribing. Written in an
  // effect, not during render — the handler only reads it on async events.
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const refreshSessions = useCallback(async () => {
    setSessions(await window.harness.sessions.list())
  }, [])

  useEffect(() => {
    void (async () => {
      const [a, s] = await Promise.all([
        window.harness.auth.getState(),
        window.harness.settings.get()
      ])
      setAuth(a)
      setSettings(s)
      document.documentElement.dataset.reducedMotion = s.reducedMotion ? '1' : '0'
      await refreshSessions()
    })()
  }, [refreshSessions])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme === 'system' ? '' : settings.theme
    document.documentElement.dataset.reducedMotion = settings.reducedMotion ? '1' : '0'
  }, [settings])

  useEffect(() => {
    document.documentElement.dataset.platform = window.harness.platform
  }, [])

  // Workspace trust for active session
  useEffect(() => {
    const active = sessions.find((s) => s.id === activeId)
    if (!active || !settings?.requireWorkspaceTrust) {
      setTrust(null)
      return
    }
    void window.harness.workspace.getTrust(active.cwd).then(setTrust)
  }, [activeId, sessions, settings?.requireWorkspaceTrust, settings?.trustedWorkspaces])

  useEffect(() => {
    const open = (): void => setForceOpenTerm((n) => n + 1)
    window.addEventListener('harness:open-terminal', open)
    return () => window.removeEventListener('harness:open-terminal', open)
  }, [])

  useEffect(() => {
    return window.harness.agent.onEvent((ev) => {
      if (ev.type === 'title' || ev.type === 'turn-end') void refreshSessions()
      if (ev.type === 'notice' && (ev.level === 'error' || ev.level === 'warn')) {
        if (/sign in|session expired|network|offline|401|403/i.test(ev.message)) {
          void window.harness.status.probe().then(setOffline)
        }
      }
      if (!('sessionId' in ev)) return
      const sid = ev.sessionId
      if (ev.type === 'turn-start') {
        setSessionStatus((s) => ({ ...s, [sid]: 'running' }))
      } else if (ev.type === 'permission-request') {
        setSessionStatus((s) => ({ ...s, [sid]: 'blocked' }))
      } else if (ev.type === 'item' || ev.type === 'item-update') {
        setSessionStatus((s) => (s[sid] === 'blocked' ? { ...s, [sid]: 'running' } : s))
      } else if (ev.type === 'turn-end') {
        setSessionStatus((s) => {
          const next = { ...s }
          if (sid !== activeIdRef.current) next[sid] = 'done'
          else delete next[sid]
          return next
        })
        if (sid === activeIdRef.current) setForceOpenReview((n) => n + 1)
      }
    })
  }, [refreshSessions])

  useEffect(() => {
    if (!activeId) return
    setSessionStatus((s) => {
      if (s[activeId] !== 'done') return s
      const next = { ...s }
      delete next[activeId]
      return next
    })
  }, [activeId])

  useEffect(() => {
    const offA = window.harness.update.onAvailable(setUpdate)
    const offD = window.harness.update.onDownloaded(setUpdate)
    return () => {
      offA()
      offD()
    }
  }, [])

  // Health probe, scoped to a signed-in credential: probing while signed out only
  // ever reports "sign in again", which would outlive the login it complains about.
  useEffect(() => {
    if (!auth?.method) {
      setOffline(null)
      return
    }
    void window.harness.status.probe().then(setOffline)
    const t = setInterval(() => {
      void window.harness.status.probe().then(setOffline)
    }, 120_000)
    return () => clearInterval(t)
  }, [auth?.method])

  const newSession = useCallback(
    async (cwd?: string) => {
      const meta = await window.harness.sessions.create({ cwd })
      await refreshSessions()
      setActiveId(meta.id)
    },
    [refreshSessions]
  )

  const startTeamProject = useCallback(
    async (teamId: string) => {
      const dir = await window.harness.pickFolder()
      if (!dir) return
      const meta = await window.harness.sessions.createTeam(teamId, dir)
      await refreshSessions()
      setActiveId(meta.id)
    },
    [refreshSessions]
  )

  const runPaletteAction = useCallback(
    (id: string) => {
      switch (id) {
        case 'new-session':
          void newSession()
          break
        case 'switch-session':
          setSwitcherOpen(true)
          break
        case 'search-sessions':
          setSessionSearchOpen(true)
          break
        case 'settings':
          setSettingsTab(undefined)
          setShowSettings(true)
          break
        case 'home':
          setActiveId(null)
          break
        case 'focus-input':
          chatActions.current.focusInput?.()
          break
        case 'export-session':
          chatActions.current.exportSession?.()
          break
        case 'open-terminal':
          setForceOpenTerm((n) => n + 1)
          break
        case 'open-review':
          setForceOpenReview((n) => n + 1)
          break
        case 'toggle-plan-only':
          chatActions.current.togglePlanOnly?.()
          break
        case 'create-pr':
          chatActions.current.createPr?.()
          break
        case 'stop-agent':
          if (activeIdRef.current) void window.harness.agent.cancel(activeIdRef.current)
          break
        case 'check-update':
          void window.harness.update.check().then((r) => {
            if (r.ok && r.version) setUpdate({ version: r.version, ready: false })
            else if (!r.ok) alert(r.error ?? 'Update check failed')
            else alert('You are up to date.')
          })
          break
        case 'reveal-logs':
          void window.harness.revealLogs()
          break
        case 'copy-diagnostics':
          void window.harness.crash.copyDiagnostics().then((r) => {
            if (r.ok && r.path) alert(`Diagnostics saved to:\n${r.path}`)
            else if (r.error) alert(r.error)
          })
          break
        case 'command-palette':
          setPaletteOpen(true)
          break
        default:
          break
      }
    },
    [newSession]
  )

  useEffect(() => {
    return window.harness.onMenuAction((action) => {
      if (action.startsWith('focus-session:')) {
        setActiveId(action.slice('focus-session:'.length))
        return
      }
      if (action === 'command-palette') {
        setPaletteOpen(true)
        return
      }
      runPaletteAction(action)
    })
  }, [runPaletteAction])

  if (auth === null || settings === null) {
    return <div className="app" />
  }

  if (!auth.method) {
    return <Login onAuthed={(a) => setAuth(a)} />
  }

  const active = sessions.find((s) => s.id === activeId) ?? null
  const showOffline =
    offline && (!offline.online || !offline.authOk) && offline.message
  const showTrust =
    active &&
    settings.requireWorkspaceTrust &&
    trust &&
    trust.level !== 'trusted'

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        status={sessionStatus}
        email={auth.email}
        forceSearchOpen={switcherOpen}
        onSearchOpenChange={setSwitcherOpen}
        onSelect={setActiveId}
        onNew={() => void newSession()}
        onHome={() => setActiveId(null)}
        onDelete={async (sid) => {
          await window.harness.sessions.delete(sid)
          if (activeId === sid) setActiveId(null)
          await refreshSessions()
        }}
        onOpenSettings={() => {
          setSettingsTab(undefined)
          setShowSettings(true)
        }}
        onSearchSessions={() => setSessionSearchOpen(true)}
      />
      <div className="main">
        {showOffline && (
          <div className="status-banner warn">
            <span>{offline!.message}</span>
            <button
              className="btn"
              onClick={() => void window.harness.status.probe().then(setOffline)}
            >
              Retry
            </button>
            {!offline!.authOk && (
              <button
                className="btn primary"
                onClick={() => {
                  setSettingsTab('About')
                  setShowSettings(true)
                }}
              >
                Re-authenticate
              </button>
            )}
          </div>
        )}
        {showTrust && (
          <div className="status-banner trust">
            <span>
              Trust this workspace to let the agent use tools here?
              <br />
              <code>{active!.cwd}</code>
            </span>
            <button
              className="btn primary"
              onClick={() =>
                void window.harness.workspace.setTrust(active!.cwd, 'trusted').then((t) => {
                  setTrust(t)
                  void window.harness.settings.get().then(setSettings)
                })
              }
            >
              Trust workspace
            </button>
            <button
              className="btn"
              onClick={() =>
                void window.harness.workspace.setTrust(active!.cwd, 'denied').then(setTrust)
              }
            >
              Not now
            </button>
          </div>
        )}
        {update && (
          <div className="update-banner">
            <span>
              {update.ready
                ? `Conduit ${update.version} is ready.`
                : `Downloading Conduit ${update.version}…`}
            </span>
            {update.ready && (
              <button
                className="btn primary"
                onClick={() => {
                  void window.harness.update.install().then((res) => {
                    if (res && 'ok' in res && !res.ok) {
                      console.warn('update install:', res.error)
                    }
                  })
                }}
              >
                Restart to update
              </button>
            )}
            <button className="icon-btn" title="Dismiss update notice" onClick={() => setUpdate(null)}>
              <XIcon size={14} />
            </button>
          </div>
        )}
        {active ? (
          <Chat
            key={active.id}
            session={active}
            settings={settings}
            registerActions={(a) => (chatActions.current = a)}
            onForked={async (meta) => {
              await refreshSessions()
              setActiveId(meta.id)
            }}
            onModelChange={async (sid: string, model: ModelId) => {
              await window.harness.sessions.setModel(sid, model)
              await refreshSessions()
            }}
            onSessionMeta={async () => {
              await refreshSessions()
            }}
            trusted={!showTrust}
          />
        ) : (
          <Home
            sessions={sessions}
            email={auth.email}
            onNewProject={() =>
              void window.harness.pickFolder().then((dir) => dir && void newSession(dir))
            }
            onQuickSession={() => void newSession()}
            onNewTeamProject={() => {
              if (!settings.teams?.length) {
                setSettingsTab('Teams')
                setShowSettings(true)
              } else if (settings.teams.length === 1) {
                void startTeamProject(settings.teams[0].id)
              } else {
                setTeamPickerOpen(true)
              }
            }}
            onOpenProject={(cwd) => void newSession(cwd)}
            onOpenSession={setActiveId}
            onSearchSessions={() => setSessionSearchOpen(true)}
          />
        )}
      </div>
      <RightDock
        session={active}
        forceOpenTerm={forceOpenTerm}
        forceOpenReview={forceOpenReview}
        onSendToChat={(text) => {
          const block = text.trim()
          if (!block) return
          chatActions.current.insertText?.(`\`\`\`terminal\n${block}\n\`\`\`\n`)
          chatActions.current.focusInput?.()
        }}
      />
      {showSettings && (
        <SettingsModal
          settings={settings}
          email={auth.email}
          activeCwd={active?.cwd}
          initialTab={settingsTab}
          onClose={() => setShowSettings(false)}
          onChange={(s) => setSettings(s)}
          onLogout={async () => {
            await window.harness.auth.logout()
            setAuth({ method: null })
            setShowSettings(false)
          }}
        />
      )}
      {teamPickerOpen && (
        <div className="palette-backdrop" onClick={() => setTeamPickerOpen(false)}>
          <div className="palette team-picker" onClick={(e) => e.stopPropagation()} style={{ padding: 16 }}>
            <div className="setting-label" style={{ marginBottom: 8 }}>
              Choose a team for this project
            </div>
            <div className="agent-list">
              {(settings.teams ?? []).map((t) => (
                <button
                  key={t.id}
                  className="agent-card team-pick"
                  onClick={() => {
                    setTeamPickerOpen(false)
                    void startTeamProject(t.id)
                  }}
                >
                  <div className="agent-card-main">
                    <div className="agent-card-name">{t.name}</div>
                    <div className="agent-card-desc">{t.description}</div>
                  </div>
                </button>
              ))}
            </div>
            <button className="mini-btn" style={{ marginTop: 10 }} onClick={() => setTeamPickerOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAction={runPaletteAction}
      />
      <SessionSearch
        open={sessionSearchOpen}
        onClose={() => setSessionSearchOpen(false)}
        onOpen={setActiveId}
      />
    </div>
  )
}
