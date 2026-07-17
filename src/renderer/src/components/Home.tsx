// Home dashboard — shown when no session is open. Greets the user, surfaces
// usage statistics aggregated from session metadata, and gets them back to
// work fast: recent projects (sessions grouped by working folder), recent
// sessions, and new-project / quick-session actions.
import { JSX, useMemo } from 'react'
import { SessionMeta } from '@shared/types'
import { SparkLogo, fmt, greeting } from './Chat'
import {
  ArrowRightIcon,
  BoltIcon,
  CalendarIcon,
  ClockIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageIcon,
  PlusIcon
} from './Icons'

const DAY = 86_400_000

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h ago`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

interface Project {
  cwd: string
  name: string
  lastUsed: number
  sessionCount: number
}

export default function Home(props: {
  sessions: SessionMeta[]
  email?: string
  onNewProject: () => void
  onQuickSession: () => void
  onOpenProject: (cwd: string) => void
  onOpenSession: (id: string) => void
  onSearchSessions?: () => void
}): JSX.Element {
  const { sessions } = props

  const stats = useMemo(() => {
    const now = Date.now()
    let messages = 0
    let tokens = 0
    let week = 0
    for (const s of sessions) {
      messages += s.messageCount ?? 0
      tokens += (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)
      if (now - (s.updatedAt ?? s.createdAt) < 7 * DAY) week++
    }
    return { sessions: sessions.length, messages, tokens, week }
  }, [sessions])

  const projects = useMemo<Project[]>(() => {
    const byCwd = new Map<string, Project>()
    for (const s of sessions) {
      const t = s.updatedAt ?? s.createdAt
      const cur = byCwd.get(s.cwd)
      if (cur) {
        cur.sessionCount++
        if (t > cur.lastUsed) cur.lastUsed = t
      } else {
        byCwd.set(s.cwd, { cwd: s.cwd, name: baseName(s.cwd), lastUsed: t, sessionCount: 1 })
      }
    }
    return [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 6)
  }, [sessions])

  const recent = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .slice(0, 5),
    [sessions]
  )

  const dateLine = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  return (
    <>
      <div className="chat-header">
        <span className="chat-header-title">Home</span>
      </div>
      <div className="home-scroll">
        <div className="home">
          <div className="home-hero">
            <div className="home-hero-logo">
              <SparkLogo size={34} />
            </div>
            <div className="home-hero-text">
              <h1 className="home-title">{greeting()}</h1>
              <div className="home-sub">
                {dateLine}
                {props.email ? ` · ${props.email}` : ''}
              </div>
            </div>
          </div>

          <div className="home-actions">
            <button className="home-action accent" onClick={props.onNewProject}>
              <span className="home-action-icon">
                <FolderPlusIcon size={19} />
              </span>
              <span className="home-action-text">
                <b>New project</b>
                <span>Choose a folder for Grok to work in</span>
              </span>
              <span className="home-action-arrow">
                <ArrowRightIcon size={15} />
              </span>
            </button>
            <button className="home-action" onClick={props.onQuickSession}>
              <span className="home-action-icon">
                <PlusIcon size={19} />
              </span>
              <span className="home-action-text">
                <b>Quick session</b>
                <span>Start in your home folder</span>
              </span>
              <span className="home-action-arrow">
                <ArrowRightIcon size={15} />
              </span>
            </button>
            {props.onSearchSessions && (
              <button className="home-action" onClick={props.onSearchSessions}>
                <span className="home-action-icon">
                  <MessageIcon size={19} />
                </span>
                <span className="home-action-text">
                  <b>Search sessions</b>
                  <span>Find past work by title, path, or digest</span>
                </span>
                <span className="home-action-arrow">
                  <ArrowRightIcon size={15} />
                </span>
              </button>
            )}
          </div>

          <div className="home-stats">
            <div className="home-stat">
              <span className="home-stat-icon">
                <MessageIcon size={15} />
              </span>
              <span className="home-stat-value">{fmt(stats.sessions)}</span>
              <span className="home-stat-label">sessions</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-icon">
                <ClockIcon size={15} />
              </span>
              <span className="home-stat-value">{fmt(stats.messages)}</span>
              <span className="home-stat-label">messages</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-icon">
                <BoltIcon size={15} />
              </span>
              <span className="home-stat-value">{fmt(stats.tokens)}</span>
              <span className="home-stat-label">tokens used</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-icon">
                <CalendarIcon size={15} />
              </span>
              <span className="home-stat-value">{fmt(stats.week)}</span>
              <span className="home-stat-label">this week</span>
            </div>
          </div>

          {projects.length > 0 && (
            <>
              <div className="home-section-title">Recent projects</div>
              <div className="home-projects">
                {projects.map((p) => (
                  <button
                    key={p.cwd}
                    className="home-project"
                    title={p.cwd}
                    onClick={() => props.onOpenProject(p.cwd)}
                  >
                    <span className="home-project-icon">
                      <FolderIcon size={17} />
                    </span>
                    <span className="home-project-text">
                      <span className="home-project-name">{p.name}</span>
                      <span className="home-project-meta">
                        {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} ·{' '}
                        {relTime(p.lastUsed)}
                      </span>
                    </span>
                    <span className="home-project-arrow">
                      <ArrowRightIcon size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {recent.length > 0 && (
            <>
              <div className="home-section-title">Recent sessions</div>
              <div className="home-sessions">
                {recent.map((s) => (
                  <button
                    key={s.id}
                    className="home-session"
                    onClick={() => props.onOpenSession(s.id)}
                  >
                    <span className="home-session-title">{s.title}</span>
                    <span className="home-session-project" title={s.cwd}>
                      {baseName(s.cwd)}
                    </span>
                    <span className="home-session-time">
                      {relTime(s.updatedAt ?? s.createdAt)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {sessions.length === 0 && (
            <div className="home-empty">
              No sessions yet — pick a project above and put Grok to work.
            </div>
          )}
        </div>
      </div>
    </>
  )
}
