import { useEffect, useMemo, useRef, useState } from 'react'
import { SessionMeta } from '@shared/types'
import { SparkLogo } from './Chat'
import { GearIcon, HomeIcon, PanelLeftIcon, PlusIcon, SearchIcon, XIcon } from './Icons'

/** Bucket sessions into Today / Yesterday / Previous 7 days / Older by updatedAt. */
function groupSessions(sessions: SessionMeta[]): { label: string; items: SessionMeta[] }[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const buckets: Record<string, SessionMeta[]> = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] }
  for (const s of sessions) {
    const t = s.updatedAt ?? s.createdAt ?? 0
    if (t >= startOfToday) buckets['Today'].push(s)
    else if (t >= startOfToday - day) buckets['Yesterday'].push(s)
    else if (t >= startOfToday - 7 * day) buckets['Previous 7 days'].push(s)
    else buckets['Older'].push(s)
  }
  return Object.entries(buckets)
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, items }))
}

export default function Sidebar(props: {
  sessions: SessionMeta[]
  activeId: string | null
  /** Per-session activity: running / blocked on approval / finished unseen */
  status?: Record<string, 'running' | 'blocked' | 'done'>
  email?: string
  forceSearchOpen?: boolean
  onSearchOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
  onNew: () => void
  onHome: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  onSearchSessions?: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0')
  }, [collapsed])

  // ⌘\ / Ctrl+\ toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘K from the menu focuses search.
  useEffect(() => {
    if (props.forceSearchOpen) {
      setSearchOpen(true)
      setTimeout(() => searchRef.current?.focus(), 0)
      props.onSearchOpenChange?.(false)
    }
  }, [props.forceSearchOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? props.sessions.filter((s) => s.title.toLowerCase().includes(q)) : props.sessions
    return groupSessions(list)
  }, [props.sessions, query])

  if (collapsed) {
    return (
      <div className="sidebar collapsed">
        <div className="sidebar-drag" />
        <button className="rail-icon-btn" title="Expand sidebar (⌘\\)" onClick={() => setCollapsed(false)}>
          <SparkLogo size={22} />
        </button>
        <button className="rail-icon-btn" title="Home" onClick={props.onHome}>
          <HomeIcon size={19} />
        </button>
        <button className="rail-icon-btn" title="New session (⌘N)" onClick={props.onNew}>
          <PlusIcon size={19} />
        </button>
        <div style={{ flex: 1 }} />
        <button className="rail-icon-btn" title="Settings (⌘,)" onClick={props.onOpenSettings}>
          <GearIcon size={19} />
        </button>
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar-drag" />
      <div className="sidebar-header">
        <button className="brand" title="Home" onClick={props.onHome}>
          <SparkLogo size={18} /> Grok Harness
        </button>
        <div className="sidebar-header-actions">
          <button
            className="icon-btn"
            title="Search sessions (⌘K / ⇧⌘F)"
            onClick={() => {
              if (props.onSearchSessions) {
                props.onSearchSessions()
                return
              }
              setSearchOpen((v) => !v)
              setTimeout(() => searchRef.current?.focus(), 0)
            }}
          >
            <SearchIcon />
          </button>
          <button className="icon-btn" title="Collapse sidebar (⌘\\)" onClick={() => setCollapsed(true)}>
            <PanelLeftIcon />
          </button>
        </div>
      </div>
      {searchOpen && (
        <input
          ref={searchRef}
          className="session-search"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('')
              setSearchOpen(false)
            }
          }}
        />
      )}
      <button className="new-chat-btn" onClick={props.onNew}>
        <PlusIcon size={15} /> New session
      </button>
      <div className="session-list">
        {groups.map((group) => (
          <div key={group.label} className="session-group">
            <div className="session-group-label">{group.label}</div>
            {group.items.map((s) => (
              <button
                key={s.id}
                className={`session-item${s.id === props.activeId ? ' active' : ''}`}
                onClick={() => props.onSelect(s.id)}
              >
                {props.status?.[s.id] && (
                  <span
                    className={`session-dot ${props.status[s.id]}`}
                    title={
                      props.status[s.id] === 'running'
                        ? 'Agent working'
                        : props.status[s.id] === 'blocked'
                          ? 'Waiting for your approval'
                          : 'Finished — click to view'
                    }
                  />
                )}
                <span className="session-title" title={s.title}>
                  {s.title}
                </span>
                <span
                  className="session-delete"
                  title="Delete session"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onDelete(s.id)
                  }}
                >
                  <XIcon size={13} />
                </span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && <div className="session-empty">No matching sessions</div>}
      </div>
      <div className="sidebar-footer">
        <span className="account-email" title={props.email}>
          {props.email ?? 'Signed in'}
        </span>
        <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
          <GearIcon />
        </button>
      </div>
    </div>
  )
}
