import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChatItem,
  CheckpointInfo,
  GitStatus,
  MODELS,
  ModelId,
  PermissionRequest,
  SessionMeta,
  Settings,
  Usage
} from '@shared/types'
import ItemView, { DiffView } from './Items'

interface Notice {
  level: 'info' | 'warn' | 'error'
  message: string
  retryAt?: number
}

export default function Chat(props: {
  session: SessionMeta | null
  settings: Settings
  onNeedSession: (cwd?: string) => void
  onModelChange: (sessionId: string, model: ModelId) => void
  onForked: (meta: SessionMeta) => void
  registerActions: (a: { focusInput?: () => void; exportSession?: () => void }) => void
}): JSX.Element {
  const { session } = props
  const [items, setItems] = useState<ChatItem[]>([])
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([])
  const [running, setRunning] = useState(false)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [input, setInput] = useState('')
  const [model, setModel] = useState<ModelId>(session?.model ?? props.settings.defaultModel)
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [mention, setMention] = useState<{ query: string; results: string[]; active: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionSeq = useRef(0)

  const reloadSession = useCallback(() => {
    if (!session) return
    void window.harness.sessions.load(session.id).then((data) => {
      if (data) {
        setItems(data.items)
        setModel(data.meta.model)
        setCheckpoints(data.checkpoints)
      }
    })
    void window.harness.agent.isRunning(session.id).then(setRunning)
    void window.harness.sessions.gitStatus(session.id).then(setGit)
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(reloadSession, [reloadSession])

  // Register menu-driven actions (focus input, export) for this session.
  useEffect(() => {
    props.registerActions({
      focusInput: () => textareaRef.current?.focus(),
      exportSession: () => {
        if (session) void window.harness.sessions.export(session.id)
      }
    })
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return
    return window.harness.agent.onEvent((ev) => {
      if ('sessionId' in ev && ev.sessionId !== session.id) return
      switch (ev.type) {
        case 'turn-start':
          setRunning(true)
          break
        case 'turn-end':
          setRunning(false)
          setPermission(null)
          void window.harness.sessions.load(session.id).then((d) => d && setCheckpoints(d.checkpoints))
          void window.harness.sessions.gitStatus(session.id).then(setGit)
          break
        case 'item':
        case 'item-update':
          setItems((prev) => {
            const idx = prev.findIndex((i) => i.id === ev.item.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = ev.item
              return next
            }
            return [...prev, ev.item]
          })
          break
        case 'text-delta':
        case 'reasoning-delta':
          setItems((prev) => {
            const idx = prev.findIndex((i) => i.id === ev.itemId)
            if (idx >= 0) {
              const cur = prev[idx]
              if (cur.kind !== 'assistant') return prev
              const next = [...prev]
              next[idx] =
                ev.type === 'text-delta'
                  ? { ...cur, text: cur.text + ev.text }
                  : { ...cur, reasoning: (cur.reasoning ?? '') + ev.text }
              return next
            }
            const fresh: ChatItem = {
              kind: 'assistant',
              id: ev.itemId,
              ts: Date.now(),
              text: ev.type === 'text-delta' ? ev.text : '',
              reasoning: ev.type === 'reasoning-delta' ? ev.text : undefined,
              model: session.model
            }
            return [...prev, fresh]
          })
          break
        case 'permission-request':
          setPermission(ev.request)
          break
        case 'usage':
          setUsage(ev.usage)
          break
        case 'notice':
          setNotice({ level: ev.level, message: ev.message, retryAt: ev.retryAt })
          break
      }
    })
  }, [session?.id, session?.model]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [items])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // ------------------------------------------------------------ composer

  const send = useCallback(() => {
    if (!session) return
    const text = input.trim()
    if (!text && images.length === 0) return

    // While the agent runs, Enter queues a steering message instead of a new turn.
    if (running) {
      void window.harness.agent.queue(session.id, text)
      setInput('')
      return
    }
    setInput('')
    setRunning(true)
    setNotice(null)
    void window.harness.agent.send(session.id, text, {
      images: images.length ? images : undefined,
      files: files.length ? files : undefined
    })
    setImages([])
    setFiles([])
    setMention(null)
  }, [session, running, input, images, files])

  const updateMention = useCallback(
    (value: string, caret: number) => {
      if (!session) return
      const before = value.slice(0, caret)
      const m = /@([\w./~-]*)$/.exec(before)
      if (!m) {
        setMention(null)
        return
      }
      const query = m[1]
      const seq = ++mentionSeq.current
      void window.harness.files.suggest(session.id, query).then((results) => {
        if (seq !== mentionSeq.current) return
        setMention(results.length ? { query, results, active: 0 } : null)
      })
    },
    [session?.id] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const pickMention = useCallback(
    (file: string) => {
      const el = textareaRef.current
      if (!el) return
      const caret = el.selectionStart
      const before = input.slice(0, caret).replace(/@[\w./~-]*$/, `@${file} `)
      setInput(before + input.slice(caret))
      setFiles((prev) => (prev.includes(file) ? prev : [...prev, file]))
      setMention(null)
      el.focus()
    },
    [input]
  )

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) continue
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            setImages((prev) => (prev.length >= 8 ? prev : [...prev, reader.result as string]))
          }
        }
        reader.readAsDataURL(blob)
      }
    }
  }, [])

  const respondPermission = (allow: boolean, always = false, global = false): void => {
    if (!permission) return
    void window.harness.agent.respondPermission(permission.requestId, allow, always, global)
    setPermission(null)
  }

  const restore = useCallback(
    (itemId: string) => {
      if (!session || running) return
      const cp = checkpoints.find((c) => c.itemId === itemId)
      if (!cp) return
      if (!window.confirm(`Restore ${cp.fileCount} file${cp.fileCount === 1 ? '' : 's'} to their state before this message? Later edits to those files will be undone.`)) return
      void window.harness.sessions
        .restoreCheckpoint(session.id, itemId)
        .then(reloadSession)
        .catch((err) => window.alert(err instanceof Error ? err.message : String(err)))
    },
    [session, running, checkpoints, reloadSession]
  )

  const retry = useCallback(() => {
    if (!session || running) return
    setRunning(true)
    setNotice(null)
    void window.harness.agent.retry(session.id).catch(() => setRunning(false))
  }, [session, running])

  const submitEdit = useCallback(() => {
    if (!session || !editing || running) return
    const text = editing.text.trim()
    if (!text) return
    setEditing(null)
    setRunning(true)
    setNotice(null)
    void window.harness.agent.editResend(session.id, editing.id, text).catch(() => setRunning(false))
  }, [session, editing, running])

  const fork = useCallback(
    (itemId: string) => {
      if (!session) return
      void window.harness.sessions.fork(session.id, itemId).then((meta) => meta && props.onForked(meta))
    },
    [session?.id] // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (!session) {
    return (
      <>
        <div className="chat-header">
          <span className="chat-header-title">Grok Harness</span>
        </div>
        <div className="empty-state">
          <h2>Start a session</h2>
          <div>Pick a project folder and put Grok to work.</div>
          <div className="empty-hints">
            <button
              className="empty-hint"
              onClick={() =>
                void window.harness.pickFolder().then((dir) => dir && props.onNeedSession(dir))
              }
            >
              <b>Open a project…</b>
              <br />
              Choose the folder the agent works in
            </button>
            <button className="empty-hint" onClick={() => props.onNeedSession()}>
              <b>Quick session</b>
              <br />
              Start in your home folder
            </button>
          </div>
        </div>
      </>
    )
  }

  const modelInfo = MODELS.find((m) => m.id === model)
  const lastAssistantId = [...items].reverse().find((i) => i.kind === 'assistant')?.id

  return (
    <>
      <div className="chat-header">
        <span className="chat-header-title">{session.title}</span>
        <div className="chat-header-right">
          {git?.isRepo && (
            <span
              className="context-pill"
              title={`Git${git.dirty ? ` · ${git.dirty} uncommitted` : ' · clean'}`}
            >
              ⑂ {git.branch}
              {git.dirty ? '*' : ''}
            </span>
          )}
          {usage && (
            <span
              className="context-pill"
              title={`Context ${Math.round(usage.contextUsed * 100)}% · ${fmt(usage.inputTokens)} in / ${fmt(usage.outputTokens)} out · ${fmt(usage.cachedTokens)} cached`}
            >
              {Math.round(usage.contextUsed * 100)}% · {fmt(usage.inputTokens + usage.outputTokens)} tok
            </span>
          )}
          <span className="context-pill" title={session.cwd}>
            {shortPath(session.cwd)}
          </span>
        </div>
      </div>

      <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <div className="empty-state" style={{ height: '100%' }}>
            <h2>{modelInfo?.label ?? model}</h2>
            <div>{modelInfo?.blurb}</div>
          </div>
        ) : (
          <div className="message-column">
            {items.map((item) => (
              <div key={item.id} className="item-row">
                {item.kind === 'user' && (
                  <div className="msg-actions">
                    {checkpoints.some((c) => c.itemId === item.id) && (
                      <button className="msg-action" title="Restore files to before this message" onClick={() => restore(item.id)}>
                        ↺
                      </button>
                    )}
                    <button
                      className="msg-action"
                      title="Edit & resend"
                      disabled={running}
                      onClick={() => setEditing({ id: item.id, text: item.text })}
                    >
                      ✎
                    </button>
                    <button className="msg-action" title="Fork session from here" onClick={() => fork(item.id)}>
                      ⑂
                    </button>
                  </div>
                )}
                {editing?.id === item.id ? (
                  <div className="edit-box">
                    <textarea
                      value={editing.text}
                      autoFocus
                      onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          submitEdit()
                        }
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <div className="edit-actions">
                      <button className="btn primary" onClick={submitEdit}>
                        Resend
                      </button>
                      <button className="btn" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <ItemView item={item} />
                )}
                {item.kind === 'assistant' && item.id === lastAssistantId && !running && (
                  <button className="retry-link" onClick={retry}>
                    ↻ Regenerate
                  </button>
                )}
              </div>
            ))}
            {running && !permission && (
              <div className="working-indicator">
                <span className="working-dot" /> working…
              </div>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className={`notice-bar ${notice.level}`}>
          <span>{notice.message}</span>
          <button className="icon-btn" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}

      {permission && (
        <div className="permission-bar">
          <div className="permission-title">
            Grok wants to run <code>{permission.toolName}</code>
          </div>
          <div className="permission-cmd">{permission.summary}</div>
          {permission.preview && (
            <div className="permission-preview">
              <DiffView text={permission.preview} />
            </div>
          )}
          {(permission.priorApprovals ?? 0) >= 3 && (
            <div className="permission-hint">
              You&apos;ve approved this {permission.priorApprovals} times before — consider
              &ldquo;always allow&rdquo;.
            </div>
          )}
          <div className="permission-actions">
            <button className="btn primary" onClick={() => respondPermission(true)}>
              Allow
            </button>
            <button className="btn" onClick={() => respondPermission(true, true)}>
              Always (this session)
            </button>
            <button className="btn" onClick={() => respondPermission(true, false, true)}>
              Always (all sessions)
            </button>
            <button className="btn danger" onClick={() => respondPermission(false)}>
              Deny
            </button>
          </div>
        </div>
      )}

      <div className="composer-wrap">
        <div className="composer">
          {mention && (
            <div className="mention-popup">
              {mention.results.map((f, i) => (
                <button
                  key={f}
                  className={`mention-item${i === mention.active ? ' active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMention(f)
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          )}
          {(images.length > 0 || files.length > 0) && (
            <div className="attach-row">
              {images.map((src, i) => (
                <span key={i} className="attach-thumb">
                  <img src={src} alt="" />
                  <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
              {files.map((f) => (
                <span key={f} className="file-chip">
                  📄 {f.split('/').pop()}
                  <button onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={
              running
                ? 'Send a steering message — the agent will pick it up mid-task…'
                : `Message ${modelInfo?.label ?? 'Grok'} — @ to attach a file, paste images, it works in ${shortPath(session.cwd)}`
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              updateMention(e.target.value, e.target.selectionStart)
              const el = textareaRef.current
              if (el) {
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`
              }
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (mention) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setMention((m) =>
                    m
                      ? { ...m, active: (m.active + delta + m.results.length) % m.results.length }
                      : m
                  )
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(mention.results[mention.active])
                  return
                }
                if (e.key === 'Escape') {
                  setMention(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-row">
            <span className="composer-chip">
              <select
                value={model}
                onChange={(e) => {
                  const m = e.target.value as ModelId
                  setModel(m)
                  props.onModelChange(session.id, m)
                }}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
            <span className="composer-chip" title={`Permission mode: ${props.settings.permissionMode}`}>
              {props.settings.permissionMode}
            </span>
            <span className="composer-spacer" />
            {running ? (
              <>
                {input.trim() && (
                  <button className="send-btn queue" title="Queue steering message" onClick={send}>
                    ⤵
                  </button>
                )}
                <button
                  className="send-btn stop"
                  title="Stop"
                  onClick={() => void window.harness.agent.cancel(session.id)}
                >
                  ◼
                </button>
              </>
            ) : (
              <button
                className="send-btn"
                title="Send"
                disabled={!input.trim() && images.length === 0}
                onClick={send}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
