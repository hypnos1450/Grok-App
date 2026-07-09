import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthState, ModelId, SessionMeta, Settings, UpdateInfo } from '@shared/types'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import Home from './components/Home'
import SettingsModal from './components/SettingsModal'
import RightDock from './components/RightDock'
import { XIcon } from './components/Icons'

export default function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  /** Per-session activity for the sidebar: running / blocked on approval / finished unseen */
  const [sessionStatus, setSessionStatus] = useState<Record<string, 'running' | 'blocked' | 'done'>>({})
  const chatActions = useRef<{
    focusInput?: () => void
    exportSession?: () => void
    insertText?: (text: string) => void
  }>({})
  const [forceOpenTerm, setForceOpenTerm] = useState(0)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

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
      await refreshSessions()
    })()
  }, [refreshSessions])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme === 'system' ? '' : settings.theme
  }, [settings])

  // Tag the platform so CSS can enable the translucent (vibrancy) sidebar on macOS.
  useEffect(() => {
    document.documentElement.dataset.platform = window.harness.platform
  }, [])

  // Tool cards can request the terminal panel without going through IPC.
  useEffect(() => {
    const open = (): void => setForceOpenTerm((n) => n + 1)
    window.addEventListener('harness:open-terminal', open)
    return () => window.removeEventListener('harness:open-terminal', open)
  }, [])

  // Keep sidebar titles/usage and per-session activity dots in sync.
  useEffect(() => {
    return window.harness.agent.onEvent((ev) => {
      if (ev.type === 'title' || ev.type === 'turn-end') void refreshSessions()
      if (!('sessionId' in ev)) return
      const sid = ev.sessionId
      if (ev.type === 'turn-start') {
        setSessionStatus((s) => ({ ...s, [sid]: 'running' }))
      } else if (ev.type === 'permission-request') {
        setSessionStatus((s) => ({ ...s, [sid]: 'blocked' }))
      } else if (ev.type === 'item' || ev.type === 'item-update') {
        // Activity after a permission prompt means it was answered.
        setSessionStatus((s) => (s[sid] === 'blocked' ? { ...s, [sid]: 'running' } : s))
      } else if (ev.type === 'turn-end') {
        setSessionStatus((s) => {
          const next = { ...s }
          // Finished in the background → badge until the user views it.
          if (sid !== activeIdRef.current) next[sid] = 'done'
          else delete next[sid]
          return next
        })
      }
    })
  }, [refreshSessions])

  // Viewing a session clears its "finished" badge.
  useEffect(() => {
    if (!activeId) return
    setSessionStatus((s) => {
      if (s[activeId] !== 'done') return s
      const next = { ...s }
      delete next[activeId]
      return next
    })
  }, [activeId])

  // Update availability.
  useEffect(() => {
    const offA = window.harness.update.onAvailable(setUpdate)
    const offD = window.harness.update.onDownloaded(setUpdate)
    return () => {
      offA()
      offD()
    }
  }, [])

  const newSession = useCallback(
    async (cwd?: string) => {
      const meta = await window.harness.sessions.create({ cwd })
      await refreshSessions()
      setActiveId(meta.id)
    },
    [refreshSessions]
  )

  // Native menu actions.
  useEffect(() => {
    return window.harness.onMenuAction((action) => {
      if (action.startsWith('focus-session:')) {
        setActiveId(action.slice('focus-session:'.length))
        return
      }
      switch (action) {
        case 'new-session':
          void newSession()
          break
        case 'switch-session':
          setSwitcherOpen(true)
          break
        case 'settings':
          setShowSettings(true)
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
      }
    })
  }, [newSession])

  if (auth === null || settings === null) {
    return <div className="app" />
  }

  if (!auth.method) {
    return <Login onAuthed={(a) => setAuth(a)} />
  }

  const active = sessions.find((s) => s.id === activeId) ?? null

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
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="main">
        {update && (
          <div className="update-banner">
            <span>Grok Harness {update.version} is ready.</span>
            <button className="btn primary" onClick={() => void window.harness.update.install()}>
              Restart to update
            </button>
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
          />
        ) : (
          <Home
            sessions={sessions}
            email={auth.email}
            onNewProject={() =>
              void window.harness.pickFolder().then((dir) => dir && void newSession(dir))
            }
            onQuickSession={() => void newSession()}
            onOpenProject={(cwd) => void newSession(cwd)}
            onOpenSession={setActiveId}
          />
        )}
      </div>
      <RightDock
        session={active}
        forceOpenTerm={forceOpenTerm}
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
          onClose={() => setShowSettings(false)}
          onChange={(s) => setSettings(s)}
          onLogout={async () => {
            await window.harness.auth.logout()
            setAuth({ method: null })
            setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}
