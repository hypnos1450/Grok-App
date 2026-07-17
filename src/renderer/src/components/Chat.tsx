import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import {
  ChatItem,
  CheckpointInfo,
  CommandMeta,
  GitStatus,
  MODELS,
  ModelId,
  PermissionRequest,
  ReasoningEffort,
  SessionMeta,
  Settings,
  Usage
} from '@shared/types'
import ItemView, { DiffView } from './Items'
import {
  BookIcon,
  BugIcon,
  CompassIcon,
  FlaskIcon,
  ForkIcon,
  PencilIcon,
  QueueIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  UndoIcon,
  WarnIcon,
  XIcon
} from './Icons'

interface Notice {
  level: 'info' | 'warn' | 'error'
  message: string
  retryAt?: number
}

/** The app's spark mark, matching the icon. */
export function SparkLogo({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <radialGradient id="spark-g" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill="url(#spark-g)" />
      <path
        d="M16 2 L18 13 L29 16 L18 19 L16 30 L14 19 L3 16 L14 13 Z"
        fill="var(--accent)"
      />
      <path d="M16 7 L17 14.5 L24 16 L17 17.5 L16 25 L15 17.5 L8 16 L15 14.5 Z" fill="#fff" />
    </svg>
  )
}

const STARTERS: { label: string; desc: string; icon: JSX.Element; prompt: string }[] = [
  {
    icon: <CompassIcon size={17} />,
    label: 'Map this codebase',
    desc: 'A guided tour of the project and how its pieces fit',
    prompt: 'Give me a high-level tour of this codebase: what it does, the main directories, and how the pieces fit together.'
  },
  {
    icon: <BugIcon size={17} />,
    label: 'Find & fix a bug',
    desc: 'Hunt down a likely bug and propose a fix',
    prompt: 'Look through this project for a likely bug or correctness issue, explain it, and propose a fix.'
  },
  {
    icon: <BookIcon size={17} />,
    label: 'Set up a project guide',
    desc: 'Write a GROK.md the agent reads every session',
    prompt: '/init'
  },
  {
    icon: <FlaskIcon size={17} />,
    label: 'Add tests',
    desc: 'Cover untested code with meaningful tests',
    prompt: 'Find code in this project that lacks test coverage and add meaningful tests for it.'
  }
]

/** Time-of-day greeting for the welcome/home screens. */
export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Up late?'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function Chat(props: {
  session: SessionMeta
  settings: Settings
  onModelChange: (sessionId: string, model: ModelId) => void
  onForked: (meta: SessionMeta) => void
  onSessionMeta?: () => void
  trusted?: boolean
  registerActions: (a: {
    focusInput?: () => void
    exportSession?: () => void
    insertText?: (text: string) => void
    togglePlanOnly?: () => void
    createPr?: () => void
  }) => void
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
  const [effort, setEffort] = useState<ReasoningEffort | ''>(session?.reasoningEffort ?? '')
  const [planOnly, setPlanOnly] = useState(!!session?.planOnly)
  const [images, setImages] = useState<string[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [mention, setMention] = useState<{ query: string; results: string[]; active: number } | null>(null)
  const [slash, setSlash] = useState<{ results: CommandMeta[]; active: number } | null>(null)
  const allCommands = useRef<CommandMeta[] | null>(null)
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
        setEffort(data.meta.reasoningEffort ?? '')
        setCheckpoints(data.checkpoints)
        setUsage(data.usage ?? null)
      }
    })
    void window.harness.agent.isRunning(session.id).then(setRunning)
    void window.harness.sessions.gitStatus(session.id).then(setGit)
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(reloadSession, [reloadSession])

  // Register menu-driven actions (focus input, export, plan-only, PR) for this session.
  useEffect(() => {
    props.registerActions({
      focusInput: () => textareaRef.current?.focus(),
      exportSession: () => {
        if (session) void window.harness.sessions.export(session.id)
      },
      insertText: (text: string) => {
        setInput((prev) => {
          if (!prev) return text
          const needsNl = !prev.endsWith('\n') && !prev.endsWith('\n\n')
          return prev + (needsNl ? '\n' : '') + text
        })
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (!el) return
          el.focus()
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 200) + 'px'
        })
      },
      togglePlanOnly: () => {
        if (!session) return
        const next = !planOnly
        setPlanOnly(next)
        void window.harness.sessions.setPlanOnly(session.id, next).then(() => props.onSessionMeta?.())
      },
      createPr: () => {
        if (!session) return
        const title = window.prompt('Pull request title', session.title || 'Update')
        if (!title) return
        void window.harness.github.createPr(session.id, { title, draft: true }).then((r) => {
          if (r.ok && r.pr) {
            if (window.confirm(`PR #${r.pr.number} created. Open in browser?`)) {
              void window.harness.github.openPr(r.pr.url)
            }
          } else {
            alert(r.error ?? 'Failed to create PR (is `gh` installed and authenticated?)')
          }
        })
      }
    })
  }, [session?.id, planOnly]) // eslint-disable-line react-hooks/exhaustive-deps

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
    if (props.trusted === false) {
      setNotice({
        level: 'warn',
        message: 'Trust this workspace before running the agent (banner above).'
      })
      return
    }
    setInput('')
    setRunning(true)
    setNotice(null)
    void (async () => {
      // Expand a leading slash command (/init, custom templates) into its prompt.
      let finalText = text
      const cmd = /^\/([a-z0-9-]+)\s?([\s\S]*)$/.exec(text)
      if (cmd) {
        const expanded = await window.harness.commands.resolve(cmd[1], cmd[2])
        if (expanded) finalText = expanded
      }
      try {
        await window.harness.agent.send(session.id, finalText, {
          images: images.length ? images : undefined,
          files: files.length ? files : undefined
        })
      } catch (err) {
        setRunning(false)
        setNotice({
          level: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    })()
    setImages([])
    setFiles([])
    setMention(null)
    setSlash(null)
  }, [session, running, input, images, files, props.trusted])

  const updateSlash = useCallback((value: string) => {
    const m = /^\/([a-z0-9-]*)$/.exec(value)
    if (!m) {
      setSlash(null)
      return
    }
    const apply = (cmds: CommandMeta[]): void => {
      const results = cmds.filter((c) => c.name.startsWith(m[1]))
      setSlash(results.length ? { results, active: 0 } : null)
    }
    if (allCommands.current) apply(allCommands.current)
    else
      void window.harness.commands.list().then((cmds) => {
        allCommands.current = cmds
        apply(cmds)
      })
  }, [])

  const pickSlash = useCallback((name: string) => {
    setInput(`/${name} `)
    setSlash(null)
    textareaRef.current?.focus()
  }, [])

  // Welcome-screen starter: drop text into the composer for the user to review/send.
  const startWith = useCallback((text: string) => {
    setInput(text)
    const el = textareaRef.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => {
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
        el.setSelectionRange(text.length, text.length)
      })
    }
  }, [])

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

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (!session) return
      for (const file of Array.from(e.dataTransfer.files)) {
        if (file.type.startsWith('image/')) {
          const reader = new FileReader()
          reader.onload = () => {
            if (typeof reader.result === 'string') {
              setImages((prev) => (prev.length >= 8 ? prev : [...prev, reader.result as string]))
            }
          }
          reader.readAsDataURL(file)
          continue
        }
        const abs = window.harness.pathForFile(file)
        if (!abs) continue
        const cwd = session.cwd.endsWith('/') ? session.cwd : `${session.cwd}/`
        if (abs.startsWith(cwd)) {
          const rel = abs.slice(cwd.length)
          setFiles((prev) => (prev.includes(rel) ? prev : [...prev, rel]))
        } else {
          setNotice({
            level: 'info',
            message: `"${file.name}" is outside this workspace — only workspace files can be attached.`
          })
        }
      }
    },
    [session]
  )

  const respondPermission = (allow: boolean, always = false, global = false): void => {
    if (!permission) return
    void window.harness.agent.respondPermission(
      permission.requestId,
      allow,
      always,
      global,
      session?.id ?? permission.sessionId
    )
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
              title={[
                `Context window: ${fmt(usage.contextTokens)} / ${fmt(usage.contextWindow)} (${Math.round(usage.contextUsed * 100)}%)`,
                `Session totals (all API calls): ${fmt(usage.sessionInputTokens)} in · ${fmt(usage.sessionOutputTokens)} out · ${fmt(usage.sessionCachedTokens)} cached`
              ].join('\n')}
            >
              {Math.round(usage.contextUsed * 100)}% · {fmt(usage.contextTokens)}
              <span className="context-pill-dim"> / {fmt(usage.contextWindow)}</span>
            </span>
          )}
          <span className="context-pill" title={session.cwd}>
            {shortPath(session.cwd)}
          </span>
        </div>
      </div>

      <div
        className="message-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {items.length === 0 ? (
          <div className="welcome">
            <div className="welcome-halo" aria-hidden />
            <div className="welcome-inner">
              <div className="welcome-logo">
                <SparkLogo size={34} />
              </div>
              <h1 className="welcome-title">What should we build?</h1>
              <div className="welcome-chips">
                <span className="welcome-chip accent">
                  <SparkLogo size={12} />
                  <span className="welcome-chip-text">{modelInfo?.label ?? model}</span>
                </span>
                {git?.branch && (
                  <span className="welcome-chip" title={`Git branch: ${git.branch}`}>
                    <ForkIcon size={12} />
                    <span className="welcome-chip-text">
                      {git.branch}
                      {git.dirty ? '*' : ''}
                    </span>
                  </span>
                )}
                <span className="welcome-chip" title={session.cwd}>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                    <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" />
                  </svg>
                  <span className="welcome-chip-text">{shortPath(session.cwd)}</span>
                </span>
              </div>
              <div className="welcome-pills">
                {STARTERS.map((s, i) => (
                  <button
                    key={s.label}
                    className="welcome-pill"
                    title={s.desc}
                    style={{ animationDelay: `${0.06 + i * 0.05}s` }}
                    onClick={() => startWith(s.prompt)}
                  >
                    {s.icon}
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="welcome-hints">
                <span className="welcome-hint">
                  <kbd>/</kbd> commands
                </span>
                <span className="welcome-hint">
                  <kbd>@</kbd> attach files
                </span>
                <span className="welcome-hint">drag &amp; drop anywhere</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="message-column">
            {items.map((item) => (
              <div key={item.id} className="item-row">
                {item.kind === 'user' && (
                  <div className="msg-actions">
                    {checkpoints.some((c) => c.itemId === item.id) && (
                      <button className="msg-action" title="Restore files to before this message" onClick={() => restore(item.id)}>
                        <UndoIcon size={14} />
                      </button>
                    )}
                    <button
                      className="msg-action"
                      title="Edit & resend"
                      disabled={running}
                      onClick={() => setEditing({ id: item.id, text: item.text })}
                    >
                      <PencilIcon size={14} />
                    </button>
                    <button className="msg-action" title="Fork session from here" onClick={() => fork(item.id)}>
                      <ForkIcon size={14} />
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
                  <ItemView
                  item={item}
                  sessionId={session.id}
                  onPinnedToTerm={() => {
                    // Ask App to open the terminal dock via menu action channel.
                    window.dispatchEvent(new CustomEvent('harness:open-terminal'))
                  }}
                />
                )}
                {item.kind === 'assistant' && item.id === lastAssistantId && !running && (
                  <button className="retry-link" onClick={retry}>
                    <RefreshIcon size={13} /> Regenerate
                  </button>
                )}
              </div>
            ))}
            {running && !permission && (
              <div className="working-indicator">
                <span className="working-dots">
                  <span />
                  <span />
                  <span />
                </span>
                working…
              </div>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className={`notice-bar ${notice.level}`}>
          <span>{notice.message}</span>
          <button className="icon-btn" title="Dismiss notice" onClick={() => setNotice(null)}>
            <XIcon size={14} />
          </button>
        </div>
      )}

      {permission && (
        <div className="permission-bar">
          <div className="permission-title">
            <span className="permission-icon">
              <WarnIcon size={16} />
            </span>
            <span>
              Grok wants to run <code>{permission.toolName}</code>
            </span>
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

      <div className="composer-wrap" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
          {slash && (
            <div className="mention-popup">
              {slash.results.map((c, i) => (
                <button
                  key={c.name}
                  className={`mention-item${i === slash.active ? ' active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSlash(c.name)
                  }}
                >
                  /{c.name}
                  <span style={{ opacity: 0.6, marginLeft: 8 }}>{c.description}</span>
                </button>
              ))}
            </div>
          )}
          {(images.length > 0 || files.length > 0) && (
            <div className="attach-row">
              {images.map((src, i) => (
                <span key={i} className="attach-thumb">
                  <img src={src} alt="" />
                  <button title="Remove image" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                    <XIcon size={11} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
              {files.map((f) => (
                <span key={f} className="file-chip">
                  📄 {f.split('/').pop()}
                  <button title={`Remove ${f.split('/').pop()}`} onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>
                    <XIcon size={11} strokeWidth={2.2} />
                  </button>
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
              updateSlash(e.target.value)
              const el = textareaRef.current
              if (el) {
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`
              }
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (slash) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const delta = e.key === 'ArrowDown' ? 1 : -1
                  setSlash((s) =>
                    s ? { ...s, active: (s.active + delta + s.results.length) % s.results.length } : s
                  )
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickSlash(slash.results[slash.active].name)
                  return
                }
                if (e.key === 'Escape') {
                  setSlash(null)
                  return
                }
              }
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
            {MODELS.find((m) => m.id === model)?.effort && (
              <span className="composer-chip" title="Reasoning depth (Grok 4.5)">
                <select
                  value={effort}
                  onChange={(e) => {
                    const v = e.target.value as ReasoningEffort | ''
                    setEffort(v)
                    void window.harness.sessions.setEffort(session.id, v || null)
                  }}
                >
                  <option value="">reasoning: default</option>
                  <option value="low">reasoning: low</option>
                  <option value="medium">reasoning: medium</option>
                  <option value="high">reasoning: high</option>
                </select>
              </span>
            )}
            <button
              type="button"
              className={`composer-chip plan-toggle${planOnly ? ' on' : ''}`}
              title="Plan-only: agent can read and plan, not write or run shell"
              onClick={() => {
                const next = !planOnly
                setPlanOnly(next)
                void window.harness.sessions.setPlanOnly(session.id, next).then(() => props.onSessionMeta?.())
              }}
            >
              {planOnly ? 'plan-only' : props.settings.permissionMode}
            </button>
            <button
              type="button"
              className="composer-chip"
              title="Create a GitHub pull request (requires gh CLI)"
              onClick={() => {
                const title = window.prompt('Pull request title', session.title || 'Update')
                if (!title) return
                void window.harness.github.createPr(session.id, { title, draft: true }).then((r) => {
                  if (r.ok && r.pr) {
                    if (window.confirm(`PR #${r.pr.number} created. Open in browser?`)) {
                      void window.harness.github.openPr(r.pr.url)
                    }
                  } else {
                    alert(r.error ?? 'Failed to create PR (is `gh` installed and authenticated?)')
                  }
                })
              }}
            >
              PR
            </button>
            <span className="composer-spacer" />
            {running ? (
              <>
                {input.trim() && (
                  <button className="send-btn queue" title="Queue steering message" onClick={send}>
                    <QueueIcon size={16} />
                  </button>
                )}
                <button
                  className="send-btn stop"
                  title="Stop"
                  onClick={() => void window.harness.agent.cancel(session.id)}
                >
                  <StopIcon size={16} />
                </button>
              </>
            ) : (
              <button
                className="send-btn"
                title="Send"
                disabled={!input.trim() && images.length === 0}
                onClick={send}
              >
                <SendIcon size={16} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
