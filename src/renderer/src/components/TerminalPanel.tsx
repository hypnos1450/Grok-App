// Full terminal panel: xterm.js rendering, multi-job tabs, command history,
// clear/copy/restart, open-in-system-terminal, and send-selection-to-chat.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { TermJobInfo, TermSnapshot } from '@shared/types'
import '@xterm/xterm/css/xterm.css'

interface Props {
  sessionId: string
  workspaceCwd: string
  /** Open a workspace-relative path in the Preview panel */
  onOpenFile?: (rel: string) => void
  /** Inject selected terminal text into the chat composer */
  onSendToChat?: (text: string) => void
  /** Ensure the terminal dock panel is open (used by pin-from-agent) */
  onRequestOpen?: () => void
}

function shortPath(p: string, max = 42): string {
  if (!p) return ''
  if (p.length <= max) return p
  return '…' + p.slice(-(max - 1))
}

export default function TerminalPanel(props: Props): JSX.Element {
  const { sessionId, workspaceCwd, onOpenFile, onSendToChat } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const activeJobRef = useRef<string>('')
  const modeRef = useRef<'pty' | 'spawn'>('spawn')
  const historyRef = useRef<string[]>([])
  const histIdxRef = useRef<number>(-1)
  const disposedRef = useRef(false)

  const [jobs, setJobs] = useState<TermJobInfo[]>([])
  const [activeJobId, setActiveJobId] = useState('')
  const [mode, setMode] = useState<'pty' | 'spawn'>('spawn')
  const [shell, setShell] = useState('')
  const [cwd, setCwd] = useState(workspaceCwd)
  const [error, setError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [spawnCmd, setSpawnCmd] = useState('')
  const [running, setRunning] = useState(false)

  const applySnapshot = useCallback((snap: TermSnapshot) => {
    setJobs(snap.jobs)
    setActiveJobId(snap.activeJobId)
    activeJobRef.current = snap.activeJobId
    setMode(snap.mode)
    modeRef.current = snap.mode
    setShell(snap.shell)
    historyRef.current = snap.history || []
    const job = snap.jobs.find((j) => j.id === snap.activeJobId)
    if (job) {
      setCwd(job.cwd || snap.workspaceCwd)
      setRunning(job.running)
    }
    const term = termRef.current
    if (term && snap.activeJobId) {
      const buf = snap.buffers[snap.activeJobId] || ''
      term.reset()
      if (buf) term.write(buf)
    }
  }, [])

  // Create xterm once per session mount.
  useEffect(() => {
    disposedRef.current = false
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: 1.35,
      theme: {
        background: '#0e0e10',
        foreground: '#e6e6ea',
        cursor: '#e6e6ea',
        selectionBackground: 'rgba(120,140,255,0.35)',
        black: '#1a1a1e',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#74c0fc',
        magenta: '#da77f2',
        cyan: '#66d9e8',
        white: '#e6e6ea',
        brightBlack: '#6c6c76',
        brightRed: '#ff8787',
        brightGreen: '#8ce99a',
        brightYellow: '#ffe066',
        brightBlue: '#a5d8ff',
        brightMagenta: '#e599f7',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff'
      },
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    const links = new WebLinksAddon((_event, uri) => {
      void window.harness.openExternal(uri)
    })
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(links)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // Path-like link provider: open workspace files in Preview.
    try {
      term.registerLinkProvider({
        provideLinks: (y, callback) => {
          const line = term.buffer.active.getLine(y - 1)
          if (!line) {
            callback(undefined)
            return
          }
          const text = line.translateToString(true)
          const re =
            /(?:^|[\s"'`])((?:\.\.?\/|\/|[A-Za-z]:\\)[^\s"'`:]+?\.[A-Za-z0-9]{1,8})(?::(\d+))?/g
          const linksOut: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }[] = []
          let m: RegExpExecArray | null
          while ((m = re.exec(text))) {
            const raw = m[1]
            const startX = (m.index ?? 0) + (m[0].startsWith(raw) ? 1 : m[0].length - raw.length) + 1
            const endX = startX + raw.length - 1
            linksOut.push({
              range: {
                start: { x: startX, y },
                end: { x: endX, y }
              },
              text: raw,
              activate: () => {
                // Prefer workspace-relative paths for Preview.
                let rel = raw.replace(/\\/g, '/')
                if (rel.startsWith(workspaceCwd.replace(/\\/g, '/'))) {
                  rel = rel.slice(workspaceCwd.replace(/\\/g, '/').length).replace(/^\//, '')
                } else if (rel.startsWith('./')) {
                  rel = rel.slice(2)
                }
                if (onOpenFile && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel)) {
                  onOpenFile(rel)
                } else {
                  void window.harness.openExternal(
                    rel.startsWith('/') || /^[A-Za-z]:/.test(raw) ? `file://${raw}` : raw
                  )
                }
              }
            })
          }
          callback(linksOut.length ? linksOut : undefined)
        }
      })
    } catch {
      // older xterm — ignore
    }

    const onData = term.onData((data) => {
      const jobId = activeJobRef.current
      if (modeRef.current === 'pty') {
        void window.harness.term.write(sessionId, data, jobId)
        return
      }
      // Spawn mode: command bar owns typing; xterm only handles Ctrl+C interrupt.
      if (data === '\u0003') {
        void window.harness.term.kill(sessionId, jobId)
        term.write('^C\r\n')
      }
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims) {
          void window.harness.term.resize(sessionId, dims.cols, dims.rows, activeJobRef.current)
        }
      } catch {
        // not yet attached
      }
    })
    ro.observe(host)

    // Open backend session + restore buffer.
    void window.harness.term.open(sessionId).then((snap) => {
      if (disposedRef.current) return
      applySnapshot(snap)
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims) void window.harness.term.resize(sessionId, dims.cols, dims.rows, snap.activeJobId)
      } catch {
        // ignore
      }
    })

    const off = window.harness.term.onData((d) => {
      if (d.sessionId !== sessionId) return
      if (d.jobs) {
        setJobs(d.jobs)
        const active = d.jobs.find((j) => j.id === (activeJobRef.current || d.jobId))
        if (active) {
          setRunning(active.running)
          setCwd(active.cwd)
        }
      }
      if (d.jobId !== activeJobRef.current) {
        // Buffer background job output only on the backend; active tab streams live.
        if (d.done) {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === d.jobId ? { ...j, running: false, exitCode: d.exitCode ?? j.exitCode } : j
            )
          )
        }
        return
      }
      if (d.chunk && termRef.current) termRef.current.write(d.chunk)
      if (d.done) setRunning(false)
    })

    return () => {
      disposedRef.current = true
      off()
      onData.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [sessionId, workspaceCwd, applySnapshot, onOpenFile])

  const switchJob = async (jobId: string): Promise<void> => {
    if (jobId === activeJobRef.current) return
    await window.harness.term.setActiveJob(sessionId, jobId)
    activeJobRef.current = jobId
    setActiveJobId(jobId)
    const snap = await window.harness.term.snapshot(sessionId)
    applySnapshot({ ...snap, activeJobId: jobId })
    const job = snap.jobs.find((j) => j.id === jobId)
    setRunning(!!job?.running)
    setCwd(job?.cwd || workspaceCwd)
  }

  const runSpawnCommand = async (asNewJob = false): Promise<void> => {
    const command = spawnCmd.trim()
    if (!command) return
    setError(null)
    const res = await window.harness.term.run(sessionId, command, {
      jobId: asNewJob ? undefined : activeJobId || undefined,
      newJob: asNewJob,
      name: asNewJob ? guessJobName(command) : undefined
    })
    if (!res.ok) {
      setError(res.error ?? 'Failed to run')
      return
    }
    setSpawnCmd('')
    setRunning(true)
    if (res.jobId) {
      activeJobRef.current = res.jobId
      setActiveJobId(res.jobId)
    }
    const snap = await window.harness.term.snapshot(sessionId)
    setJobs(snap.jobs)
    historyRef.current = snap.history
  }

  const onSpawnKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!running) void runSpawnCommand(e.metaKey || e.ctrlKey)
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const hist = historyRef.current
      if (!hist.length) return
      if (e.key === 'ArrowUp') {
        if (histIdxRef.current < 0) histIdxRef.current = hist.length - 1
        else histIdxRef.current = Math.max(0, histIdxRef.current - 1)
      } else {
        if (histIdxRef.current < 0) return
        histIdxRef.current += 1
        if (histIdxRef.current >= hist.length) {
          histIdxRef.current = -1
          setSpawnCmd('')
          return
        }
      }
      setSpawnCmd(hist[histIdxRef.current] ?? '')
    }
  }

  const copyAll = (): void => {
    const t = termRef.current
    if (!t) return
    const buf = t.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    void navigator.clipboard.writeText(lines.join('\n').replace(/\s+$/m, ''))
  }

  const copySelection = (): void => {
    const t = termRef.current
    if (!t) return
    const sel = t.getSelection()
    if (sel) void navigator.clipboard.writeText(sel)
  }

  const sendSelection = (): void => {
    const t = termRef.current
    if (!t || !onSendToChat) return
    const sel = t.getSelection()
    if (sel.trim()) onSendToChat(sel)
  }

  const activeJob = jobs.find((j) => j.id === activeJobId)

  return (
    <div className="term-wrap">
      <div className="term-toolbar">
        <div className="term-jobs">
          {jobs.map((j) => (
            <button
              key={j.id}
              className={`term-job-tab${j.id === activeJobId ? ' active' : ''}${j.running ? ' running' : ''}`}
              onClick={() => void switchJob(j.id)}
              title={j.command || j.name}
            >
              <span className="term-job-dot" />
              {j.name}
              {jobs.length > 1 && (
                <span
                  className="term-job-x"
                  title={j.running ? 'Stop and close terminal' : 'Close terminal'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.harness.term.closeJob(sessionId, j.id).then((snap) => {
                      if (snap) applySnapshot(snap)
                    })
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button
            className="term-job-tab add"
            title="New terminal"
            onClick={() => {
              const name = `job-${jobs.length + 1}`
              void window.harness.term.createJob(sessionId, name).then(async (res) => {
                if (!res.ok) {
                  setError(res.error ?? 'Could not create terminal')
                  return
                }
                setError(null)
                if (res.snapshot) applySnapshot(res.snapshot)
                if (res.jobId) await switchJob(res.jobId)
              })
            }}
          >
            +
          </button>
        </div>
        <div className="term-actions">
          <span className="term-cwd" title={cwd}>
            {shortPath(cwd)}
          </span>
          <span className="term-mode" title={mode === 'pty' ? 'Interactive PTY' : 'Spawn runner'}>
            {shell || mode}
          </span>
          <button className="icon-btn" title="Search" onClick={() => setSearchOpen((v) => !v)}>
            ⌕
          </button>
          <button className="icon-btn" title="Copy all" onClick={copyAll}>
            ⎘
          </button>
          <button className="icon-btn" title="Copy selection" onClick={copySelection}>
            ⎘sel
          </button>
          {onSendToChat && (
            <button className="icon-btn" title="Send selection to chat" onClick={sendSelection}>
              ↗
            </button>
          )}
          <button
            className="icon-btn"
            title="Clear"
            onClick={() => {
              void window.harness.term.clear(sessionId, activeJobId)
              termRef.current?.clear()
            }}
          >
            ⌫
          </button>
          <button
            className="icon-btn"
            title="Restart last command"
            onClick={() => void window.harness.term.restart(sessionId, activeJobId)}
          >
            ↻
          </button>
          <button
            className="icon-btn"
            title="Open system terminal"
            onClick={() => void window.harness.term.openExternal(sessionId)}
          >
            ⎋
          </button>
          {(running || activeJob?.running) && (
            <button
              className="mini-btn danger"
              onClick={() => void window.harness.term.kill(sessionId, activeJobId)}
            >
              stop
            </button>
          )}
        </div>
      </div>

      {searchOpen && (
        <div className="term-search">
          <input
            value={searchQ}
            placeholder="Find in terminal…"
            onChange={(e) => {
              setSearchQ(e.target.value)
              if (e.target.value) searchRef.current?.findNext(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchRef.current?.findPrevious(searchQ)
                else searchRef.current?.findNext(searchQ)
              }
              if (e.key === 'Escape') setSearchOpen(false)
            }}
          />
          <button className="mini-btn" onClick={() => searchRef.current?.findPrevious(searchQ)}>
            ↑
          </button>
          <button className="mini-btn" onClick={() => searchRef.current?.findNext(searchQ)}>
            ↓
          </button>
        </div>
      )}

      <div className="term-xterm" ref={hostRef} />

      {error && <div className="term-error">{error}</div>}

      {/* Spawn mode keeps an explicit command bar; PTY is fully interactive in xterm. */}
      {mode === 'spawn' && (
        <div className="term-input-row">
          <span className="term-prompt">{running ? '…' : '$'}</span>
          <input
            className="term-input"
            value={spawnCmd}
            placeholder={
              running
                ? 'command running — stop it or ⌘/Ctrl+Enter for a new job'
                : 'npm run dev  (↑ history · ⌘/Ctrl+Enter = new job)'
            }
            onChange={(e) => setSpawnCmd(e.target.value)}
            onKeyDown={onSpawnKey}
            disabled={false}
          />
          {running ? (
            <button className="mini-btn danger" onClick={() => void window.harness.term.kill(sessionId, activeJobId)}>
              stop
            </button>
          ) : (
            <button className="mini-btn" onClick={() => void runSpawnCommand(false)} disabled={!spawnCmd.trim()}>
              run
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function guessJobName(command: string): string {
  const c = command.trim()
  if (/\b(dev|start|serve)\b/i.test(c)) return 'dev'
  if (/\btest\b/i.test(c)) return 'test'
  if (/\bbuild\b/i.test(c)) return 'build'
  const first = c.split(/\s+/)[0] || 'job'
  return first.replace(/^.*[/\\]/, '').slice(0, 16)
}
