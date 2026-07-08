import { useEffect, useMemo, useRef, useState } from 'react'
import { SessionMeta } from '@shared/types'

export default function Sidebar(props: {
  sessions: SessionMeta[]
  activeId: string | null
  email?: string
  forceSearchOpen?: boolean
  onSearchOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K from the menu focuses search.
  useEffect(() => {
    if (props.forceSearchOpen) {
      setSearchOpen(true)
      setTimeout(() => searchRef.current?.focus(), 0)
      props.onSearchOpenChange?.(false)
    }
  }, [props.forceSearchOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return props.sessions
    return props.sessions.filter((s) => s.title.toLowerCase().includes(q))
  }, [props.sessions, query])

  return (
    <div className="sidebar">
      <div className="sidebar-drag" />
      <div className="sidebar-header">
        <div className="brand">Grok Harness</div>
        <button
          className="icon-btn"
          title="Search sessions (⌘K)"
          onClick={() => {
            setSearchOpen((v) => !v)
            setTimeout(() => searchRef.current?.focus(), 0)
          }}
        >
          ⌕
        </button>
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
        <span>＋</span> New session
      </button>
      <div className="session-list">
        {filtered.map((s) => (
          <button
            key={s.id}
            className={`session-item${s.id === props.activeId ? ' active' : ''}`}
            onClick={() => props.onSelect(s.id)}
          >
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
              ✕
            </span>
          </button>
        ))}
        {filtered.length === 0 && <div className="session-empty">No matching sessions</div>}
      </div>
      <div className="sidebar-footer">
        <span className="account-email" title={props.email}>
          {props.email ?? 'Signed in'}
        </span>
        <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
          ⚙
        </button>
      </div>
    </div>
  )
}
