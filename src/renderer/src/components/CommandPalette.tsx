// App-wide command palette (⌘⇧O). Lists actions from main and runs them via callback.
import { JSX, useEffect, useMemo, useState } from 'react'
import { PaletteAction } from '@shared/types'

export default function CommandPalette(props: {
  open: boolean
  onClose: () => void
  onAction: (id: string) => void
}): JSX.Element | null {
  const [actions, setActions] = useState<PaletteAction[]>([])
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (!props.open) return
    setQ('')
    setIdx(0)
    void window.harness.palette.list().then(setActions)
  }, [props.open])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return actions
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(needle) ||
        a.id.includes(needle) ||
        (a.section ?? '').toLowerCase().includes(needle)
    )
  }, [actions, q])

  useEffect(() => {
    setIdx(0)
  }, [q])

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const a = filtered[idx]
        if (a) {
          props.onAction(a.id)
          props.onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, filtered, idx])

  if (!props.open) return null

  return (
    <div className="palette-backdrop" onClick={props.onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matches</div>}
          {filtered.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={`palette-item${i === idx ? ' active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => {
                props.onAction(a.id)
                props.onClose()
              }}
            >
              <span className="palette-label">{a.label}</span>
              <span className="palette-meta">
                {a.section}
                {a.shortcut ? ` · ${a.shortcut}` : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
