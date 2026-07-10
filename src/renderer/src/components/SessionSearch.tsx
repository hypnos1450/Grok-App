// Full-text session search modal.
import { useEffect, useState } from 'react'
import { SessionSearchHit } from '@shared/types'

export default function SessionSearch(props: {
  open: boolean
  onClose: () => void
  onOpen: (sessionId: string) => void
}): JSX.Element | null {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!props.open) return
    setQ('')
    setHits([])
  }, [props.open])

  useEffect(() => {
    if (!props.open) return
    const t = setTimeout(() => {
      const needle = q.trim()
      if (!needle) {
        setHits([])
        return
      }
      setBusy(true)
      void window.harness.sessions
        .search(needle, 40)
        .then(setHits)
        .finally(() => setBusy(false))
    }, 200)
    return () => clearTimeout(t)
  }, [q, props.open])

  if (!props.open) return null

  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette session-search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Search sessions (title, path, digest, messages)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') props.onClose()
          }}
        />
        <div className="palette-list">
          {busy && <div className="palette-empty">Searching…</div>}
          {!busy && q.trim() && hits.length === 0 && (
            <div className="palette-empty">No sessions matched</div>
          )}
          {hits.map((h) => (
            <button
              key={h.sessionId + (h.snippet ?? '')}
              type="button"
              className="palette-item"
              onClick={() => {
                props.onOpen(h.sessionId)
                props.onClose()
              }}
            >
              <span className="palette-label">{h.title}</span>
              <span className="palette-meta">
                {h.matchField}
                {h.snippet ? ` · ${h.snippet}` : ''}
              </span>
              <span className="palette-meta muted">{h.cwd}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
