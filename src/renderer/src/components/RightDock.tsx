// Right-side dock, Claude Desktop style: a slim icon rail toggles panels
// (artifact Preview, workspace Files, agent Tasks, Terminal). Preview/Files/
// Tasks stack in one column and split its height; Terminal opens as its own
// column. Panels can be expanded to fill their column or closed from their
// header. Open state persists across launches.
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { ChatItem, FileEntry, FilePreview, SessionMeta, ToolStatus } from '@shared/types'

type PanelId = 'preview' | 'files' | 'tasks' | 'term'

const STACK_ORDER: PanelId[] = ['preview', 'files', 'tasks']
const STORE_KEY = 'dock-open-panels'

const ICONS: Record<PanelId, JSX.Element> = {
  preview: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 5.5h13" />
      <circle cx="3.6" cy="4" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="5.4" cy="4" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4.2l1.2 1.2L5.5 3M2 8.7l1.2 1.2L5.5 7.5M2 13.2l1.2 1.2L5.5 12" />
      <path d="M8 4.7h6M8 9.2h6M8 13.7h6" />
    </svg>
  ),
  term: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5h3" />
    </svg>
  )
}

const TITLES: Record<PanelId, string> = {
  preview: 'Preview',
  files: 'Files',
  tasks: 'Tasks',
  term: 'Terminal'
}

// ------------------------------------------------------------------ chrome

function Panel(props: {
  id: PanelId
  expanded: boolean
  actions?: JSX.Element
  onToggleExpand: () => void
  onClose: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div className={`dock-panel${props.expanded ? ' expanded' : ''}`}>
      <div className="dock-panel-header">
        <span className="dock-panel-title">
          {ICONS[props.id]} {TITLES[props.id]}
        </span>
        <span className="dock-panel-actions">
          {props.actions}
          <button
            className="icon-btn"
            title={props.expanded ? 'Restore size' : 'Expand'}
            onClick={props.onToggleExpand}
          >
            {props.expanded ? '⤡' : '⤢'}
          </button>
          <button className="icon-btn" title="Close panel" onClick={props.onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="dock-panel-body">{props.children}</div>
    </div>
  )
}

// ------------------------------------------------------------------- files

function DirNode(props: {
  sessionId: string
  entry: FileEntry
  depth: number
  onOpenFile: (rel: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)

  const toggle = (): void => {
    setOpen(!open)
    if (!open && children === null) {
      void window.harness.panels.listDir(props.sessionId, props.entry.rel).then(setChildren)
    }
  }

  return (
    <>
      <div
        className="file-node"
        style={{ paddingLeft: 8 + props.depth * 14 }}
        onClick={toggle}
        title={props.entry.rel}
      >
        <span className={`file-arrow${open ? ' open' : ''}`}>›</span>
        <span className="file-name dir">{props.entry.name}</span>
      </div>
      {open &&
        (children ?? []).map((c) =>
          c.isDir ? (
            <DirNode key={c.rel} sessionId={props.sessionId} entry={c} depth={props.depth + 1} onOpenFile={props.onOpenFile} />
          ) : (
            <div
              key={c.rel}
              className="file-node"
              style={{ paddingLeft: 8 + (props.depth + 1) * 14 + 12 }}
              onClick={() => props.onOpenFile(c.rel)}
              title={c.rel}
            >
              <span className="file-name">{c.name}</span>
            </div>
          )
        )}
    </>
  )
}

function FilesPanel(props: {
  sessionId: string
  refreshKey: number
  onOpenFile: (rel: string) => void
}): JSX.Element {
  const [root, setRoot] = useState<FileEntry[]>([])

  useEffect(() => {
    void window.harness.panels.listDir(props.sessionId, '').then(setRoot)
  }, [props.sessionId, props.refreshKey])

  return (
    <div className="files-tree" key={props.refreshKey}>
      {root.length === 0 && <div className="dock-empty">Empty directory</div>}
      {root.map((e) =>
        e.isDir ? (
          <DirNode key={e.rel} sessionId={props.sessionId} entry={e} depth={0} onOpenFile={props.onOpenFile} />
        ) : (
          <div key={e.rel} className="file-node" style={{ paddingLeft: 20 }} onClick={() => props.onOpenFile(e.rel)} title={e.rel}>
            <span className="file-name">{e.name}</span>
          </div>
        )
      )}
    </div>
  )
}

// ----------------------------------------------------------------- preview

function highlight(code: string, ext: string): string {
  try {
    if (hljs.getLanguage(ext)) return hljs.highlight(code, { language: ext, ignoreIllegals: true }).value
    return hljs.highlightAuto(code).value
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  }
}

function PreviewPanel(props: { sessionId: string; file: string | null; version: number }): JSX.Element {
  const [data, setData] = useState<FilePreview | null>(null)

  useEffect(() => {
    if (!props.file) {
      setData(null)
      return
    }
    void window.harness.panels.readFile(props.sessionId, props.file).then(setData)
  }, [props.sessionId, props.file, props.version])

  if (!props.file) {
    return <div className="dock-empty">Select a file in Files — or let the agent write one — to preview it here.</div>
  }
  if (!data) return <div className="dock-empty">Loading…</div>

  const ext = props.file.split('.').pop()?.toLowerCase() ?? ''
  return (
    <div className="preview-wrap">
      <div className="preview-path" title={props.file}>
        {props.file}
      </div>
      {data.kind === 'error' && <div className="dock-empty">{data.message}</div>}
      {data.kind === 'binary' && <div className="dock-empty">Binary file ({Math.round(data.size / 1024)} KB)</div>}
      {data.kind === 'too-large' && (
        <div className="dock-empty">File too large to preview ({Math.round(data.size / 1024)} KB)</div>
      )}
      {data.kind === 'image' && (
        <div className="preview-scroll">
          <img className="preview-image" src={data.dataUrl} alt={props.file} />
        </div>
      )}
      {data.kind === 'text' &&
        (ext === 'html' || ext === 'htm' ? (
          <iframe className="preview-frame" sandbox="allow-scripts" srcDoc={data.content} title={props.file} />
        ) : ext === 'md' || ext === 'markdown' ? (
          <div className="preview-scroll md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.content}</ReactMarkdown>
          </div>
        ) : (
          <div className="preview-scroll">
            <pre className="preview-code">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: highlight(data.content, ext) }} />
            </pre>
            {data.truncated && <div className="dock-empty">…truncated</div>}
          </div>
        ))}
    </div>
  )
}

// ------------------------------------------------------------------- tasks

interface TaskRow {
  id: string
  name: string
  detail: string
  status: ToolStatus
  ts: number
}

function toRow(item: ChatItem): TaskRow | null {
  if (item.kind !== 'tool') return null
  const input = item.input ?? {}
  const detail = String(input['path'] ?? input['command'] ?? input['pattern'] ?? input['url'] ?? '')
  return { id: item.id, name: item.name, detail, status: item.status, ts: item.ts }
}

function TasksPanel(props: { sessionId: string }): JSX.Element {
  const [rows, setRows] = useState<TaskRow[]>([])
  const [running, setRunning] = useState(false)

  useEffect(() => {
    setRows([])
    void window.harness.sessions.load(props.sessionId).then((data) => {
      if (!data) return
      setRows(data.items.map(toRow).filter((r): r is TaskRow => r !== null).slice(-50))
    })
    void window.harness.agent.isRunning(props.sessionId).then(setRunning)
    return window.harness.agent.onEvent((ev) => {
      if (!('sessionId' in ev) || ev.sessionId !== props.sessionId) return
      if (ev.type === 'turn-start') setRunning(true)
      if (ev.type === 'turn-end') setRunning(false)
      if (ev.type === 'item' || ev.type === 'item-update') {
        const row = toRow(ev.item)
        if (!row) return
        setRows((prev) => {
          const i = prev.findIndex((r) => r.id === row.id)
          if (i >= 0) {
            const next = [...prev]
            next[i] = row
            return next
          }
          return [...prev.slice(-49), row]
        })
      }
    })
  }, [props.sessionId])

  return (
    <div className="tasks-list">
      <div className="tasks-status">
        <span className={`tool-status ${running ? 'running' : 'ok'}`} />
        {running ? 'Agent working…' : 'Idle'}
      </div>
      {rows.length === 0 && <div className="dock-empty">Tool activity for this session shows up here.</div>}
      {[...rows].reverse().map((r) => (
        <div key={r.id} className="task-row" title={r.detail}>
          <span className={`tool-status ${r.status}`} />
          <span className="task-name">{r.name}</span>
          <span className="task-detail">{r.detail}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- terminal

function TerminalPanel(props: { sessionId: string }): JSX.Element {
  const [buffer, setBuffer] = useState('')
  const [running, setRunning] = useState(false)
  const [cmd, setCmd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const outRef = useRef<HTMLPreElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => {
    setBuffer('')
    void window.harness.term.snapshot(props.sessionId).then((s) => {
      setBuffer(s.buffer)
      setRunning(s.running)
    })
    return window.harness.term.onData((d) => {
      if (d.sessionId !== props.sessionId) return
      if (d.chunk) setBuffer((b) => (b + d.chunk).slice(-200_000))
      if (d.done) setRunning(false)
    })
  }, [props.sessionId])

  useEffect(() => {
    const el = outRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [buffer])

  const run = async (): Promise<void> => {
    const command = cmd.trim()
    if (!command) return
    setError(null)
    const res = await window.harness.term.run(props.sessionId, command)
    if (!res.ok) {
      setError(res.error ?? 'Failed to run.')
      return
    }
    setRunning(true)
    setCmd('')
  }

  return (
    <div className="term-wrap">
      <pre
        ref={outRef}
        className="term-out"
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {buffer || 'Run a command in the workspace — output streams here.\n'}
      </pre>
      {error && <div className="term-error">{error}</div>}
      <div className="term-input-row">
        <span className="term-prompt">{running ? '…' : '$'}</span>
        <input
          className="term-input"
          value={cmd}
          placeholder={running ? 'command running — stop it to run another' : 'npm run dev'}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !running) void run()
          }}
        />
        {running ? (
          <button className="mini-btn danger" onClick={() => void window.harness.term.kill(props.sessionId)}>
            stop
          </button>
        ) : (
          <button className="mini-btn" onClick={() => void run()} disabled={!cmd.trim()}>
            run
          </button>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- dock

export default function RightDock({ session }: { session: SessionMeta | null }): JSX.Element | null {
  const [open, setOpen] = useState<PanelId[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.filter((p): p is PanelId => p in TITLES) : []
    } catch {
      return []
    }
  })
  const [expanded, setExpanded] = useState<PanelId | null>(null)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [filesRefresh, setFilesRefresh] = useState(0)

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(open))
  }, [open])

  // A preview path from another workspace is meaningless — clear on switch.
  useEffect(() => {
    setPreviewFile(null)
    setFilesRefresh((n) => n + 1)
  }, [session?.id])

  // Follow the agent's file writes: refresh Files, point Preview at the file.
  useEffect(() => {
    if (!session) return
    return window.harness.agent.onEvent((ev) => {
      if (ev.type !== 'item-update' && ev.type !== 'item') return
      if (!('sessionId' in ev) || ev.sessionId !== session.id) return
      const item = ev.item
      if (item.kind !== 'tool' || item.status !== 'ok') return
      if (item.name === 'write_file' || item.name === 'edit_file') {
        setFilesRefresh((n) => n + 1)
        const p = String(item.input?.['path'] ?? '')
        if (p) {
          setPreviewFile(p)
          setPreviewVersion((n) => n + 1)
        }
      }
    })
  }, [session])

  const toggle = useCallback((id: PanelId) => {
    setOpen((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
    setExpanded(null)
  }, [])

  const close = useCallback((id: PanelId) => {
    setOpen((prev) => prev.filter((p) => p !== id))
    setExpanded((e) => (e === id ? null : e))
  }, [])

  if (!session) return null

  const openFile = (rel: string): void => {
    setPreviewFile(rel)
    setPreviewVersion((n) => n + 1)
    setOpen((prev) => (prev.includes('preview') ? prev : [...prev, 'preview']))
  }

  const stack = STACK_ORDER.filter((p) => open.includes(p))
  const visibleStack = expanded && stack.includes(expanded) ? [expanded] : stack
  const termOpen = open.includes('term')

  const renderPanel = (id: PanelId): JSX.Element => (
    <Panel
      key={`${id}-${session.id}`}
      id={id}
      expanded={expanded === id}
      actions={
        id === 'files' ? (
          <button className="icon-btn" title="Refresh" onClick={() => setFilesRefresh((n) => n + 1)}>
            ↻
          </button>
        ) : undefined
      }
      onToggleExpand={() => setExpanded((e) => (e === id ? null : id))}
      onClose={() => close(id)}
    >
      {id === 'preview' ? (
        <PreviewPanel sessionId={session.id} file={previewFile} version={previewVersion} />
      ) : id === 'files' ? (
        <FilesPanel sessionId={session.id} refreshKey={filesRefresh} onOpenFile={openFile} />
      ) : id === 'tasks' ? (
        <TasksPanel sessionId={session.id} />
      ) : (
        <TerminalPanel sessionId={session.id} />
      )}
    </Panel>
  )

  return (
    <>
      {visibleStack.length > 0 && <div className="dock-col">{visibleStack.map(renderPanel)}</div>}
      {termOpen && <div className={`dock-col${expanded === 'term' ? ' wide' : ''}`}>{renderPanel('term')}</div>}
      <div className="dock-rail">
        {(['preview', 'files', 'tasks', 'term'] as PanelId[]).map((id) => (
          <button
            key={id}
            className={`rail-btn${open.includes(id) ? ' active' : ''}`}
            title={TITLES[id]}
            onClick={() => toggle(id)}
          >
            {ICONS[id]}
          </button>
        ))}
      </div>
    </>
  )
}
