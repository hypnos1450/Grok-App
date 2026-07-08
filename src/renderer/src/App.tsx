import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthState, ModelId, SessionMeta, Settings, UpdateInfo } from '@shared/types'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import Chat from './components/Chat'
import SettingsModal from './components/SettingsModal'

export default function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const chatActions = useRef<{ focusInput?: () => void; exportSession?: () => void }>({})

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

  // Keep sidebar titles/usage in sync.
  useEffect(() => {
    return window.harness.agent.onEvent((ev) => {
      if (ev.type === 'title' || ev.type === 'turn-end') void refreshSessions()
    })
  }, [refreshSessions])

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
        email={auth.email}
        forceSearchOpen={switcherOpen}
        onSearchOpenChange={setSwitcherOpen}
        onSelect={setActiveId}
        onNew={() => void newSession()}
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
            <button className="icon-btn" onClick={() => setUpdate(null)}>
              ✕
            </button>
          </div>
        )}
        <Chat
          key={active?.id ?? 'none'}
          session={active}
          settings={settings}
          registerActions={(a) => (chatActions.current = a)}
          onForked={async (meta) => {
            await refreshSessions()
            setActiveId(meta.id)
          }}
          onNeedSession={(cwd) => void newSession(cwd)}
          onModelChange={async (sid: string, model: ModelId) => {
            await window.harness.sessions.setModel(sid, model)
            await refreshSessions()
          }}
        />
      </div>
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
