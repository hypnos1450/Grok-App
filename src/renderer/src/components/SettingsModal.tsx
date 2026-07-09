import { useCallback, useEffect, useState } from 'react'
import {
  McpServerConfig,
  McpServerStatus,
  MODELS,
  ModelId,
  PendingMemoryWrite,
  PendingSkillWrite,
  PermissionMode,
  Settings,
  SkillImportReport,
  SkillMeta
} from '@shared/types'

const TABS = ['General', 'Agent', 'Memory', 'Skills', 'MCP', 'About'] as const
type Tab = (typeof TABS)[number]

function MemorySection({ cwd }: { cwd?: string }): JSX.Element {
  const [entries, setEntries] = useState<{ memory: string[]; user: string[]; project: string[] }>({
    memory: [],
    user: [],
    project: []
  })
  const [pending, setPending] = useState<PendingMemoryWrite[]>([])

  const refresh = useCallback(() => {
    void window.harness.memory.entries(cwd).then(setEntries)
    void window.harness.memory.pending().then(setPending)
  }, [cwd])

  useEffect(refresh, [refresh])

  const resolve = (id: string | 'all', approve: boolean): void => {
    void window.harness.memory.resolvePending(id, approve).then((rest) => {
      setPending(rest)
      void window.harness.memory.entries(cwd).then(setEntries)
    })
  }

  return (
    <div className="memory-section">
      {pending.length > 0 && (
        <>
          <div className="memory-header">
            <span>Pending memory writes ({pending.length})</span>
            <span>
              <button className="mini-btn" onClick={() => resolve('all', true)}>
                approve all
              </button>
              <button className="mini-btn danger" onClick={() => resolve('all', false)}>
                reject all
              </button>
            </span>
          </div>
          {pending.map((p) => (
            <div key={p.id} className="memory-entry pending">
              <span className="memory-entry-text">
                <b>
                  {p.action} → {p.target}
                  {p.source === 'auto' ? ' [auto]' : ''}:
                </b>{' '}
                {p.content ?? ''}
                {p.old_text ? ` (replacing: …${p.old_text}…)` : ''}
              </span>
              <span>
                <button className="mini-btn" onClick={() => resolve(p.id, true)}>
                  ✓
                </button>
                <button className="mini-btn danger" onClick={() => resolve(p.id, false)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
        </>
      )}
      {(['memory', 'user', 'project'] as const).map((target) => {
        if (target === 'project' && !cwd) return null
        const label =
          target === 'memory' ? 'Agent notes' : target === 'user' ? 'User profile' : 'Project memory (current workspace)'
        return (
          <div key={target}>
            <div className="memory-header">
              <span>{label} ({entries[target].length})</span>
            </div>
            {entries[target].length === 0 && <div className="memory-empty">empty</div>}
            {entries[target].map((e) => (
              <div key={e} className="memory-entry">
                <span className="memory-entry-text">{e}</span>
                <button
                  className="mini-btn danger"
                  title="Delete this memory"
                  onClick={() => void window.harness.memory.removeEntry(target, e, cwd).then(refresh)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function SkillInstall({ onInstalled }: { onInstalled: () => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<SkillImportReport | null>(null)

  const finish = (r: SkillImportReport | null): void => {
    setBusy(false)
    if (!r) return // folder picker cancelled
    setReport(r)
    if (r.installed.length) onInstalled()
  }

  const fromGithub = (): void => {
    if (!url.trim() || busy) return
    setBusy(true)
    setReport(null)
    void window.harness.skills.installGithub(url.trim()).then(finish)
  }

  const fromFolder = (): void => {
    if (busy) return
    setBusy(true)
    setReport(null)
    void window.harness.skills.importFolder().then(finish)
  }

  return (
    <div className="skill-install">
      <div className="mcp-add">
        <input
          className="login-input"
          placeholder="GitHub URL or owner/repo (repo, skill folder, or SKILL.md link)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fromGithub()}
        />
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn" disabled={busy || !url.trim()} onClick={fromGithub}>
            {busy ? 'Installing…' : 'Install from GitHub'}
          </button>
          <button className="btn" disabled={busy} onClick={fromFolder}>
            Import folder…
          </button>
        </span>
      </div>
      {report && (
        <div className="skill-install-report">
          {report.installed.length > 0 && (
            <div className="ok">Installed: {report.installed.join(', ')}</div>
          )}
          {report.errors.map((e) => (
            <div key={e} className="err">
              {e}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillsSection(): JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [pending, setPending] = useState<PendingSkillWrite[]>([])
  const [openSkill, setOpenSkill] = useState<{ name: string; content: string; files: string[] } | null>(
    null
  )

  const refresh = useCallback(() => {
    void window.harness.skills.list().then(setSkills)
    void window.harness.skills.pending().then(setPending)
  }, [])

  useEffect(refresh, [refresh])

  const resolve = (id: string | 'all', approve: boolean): void => {
    void window.harness.skills.resolvePending(id, approve).then((rest) => {
      setPending(rest)
      void window.harness.skills.list().then(setSkills)
    })
  }

  return (
    <div className="memory-section">
      <SkillInstall onInstalled={refresh} />
      {pending.length > 0 && (
        <>
          <div className="memory-header">
            <span>Pending skill writes ({pending.length})</span>
            <span>
              <button className="mini-btn" onClick={() => resolve('all', true)}>
                approve all
              </button>
              <button className="mini-btn danger" onClick={() => resolve('all', false)}>
                reject all
              </button>
            </span>
          </div>
          {pending.map((p) => (
            <div key={p.id} className="memory-entry pending">
              <span className="memory-entry-text">
                <b>
                  {p.action} {p.name}
                  {p.source === 'auto' ? ' [auto]' : ''}:
                </b>{' '}
                {p.description ?? ''} {p.content ? `— ${p.content.slice(0, 140)}…` : ''}
              </span>
              <span>
                <button className="mini-btn" onClick={() => resolve(p.id, true)}>
                  ✓
                </button>
                <button className="mini-btn danger" onClick={() => resolve(p.id, false)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
        </>
      )}
      {skills.length === 0 && pending.length === 0 && (
        <div className="memory-empty">
          No skills yet — the agent saves playbooks here as it works out reusable procedures, or
          install some from a GitHub repo above.
        </div>
      )}
      {skills.map((s) => (
        <div key={s.name} className="memory-entry">
          <span className="memory-entry-text">
            <b>{s.name}</b> — {s.description}{' '}
            <span style={{ opacity: 0.6 }}>
              (updated {s.updated}
              {s.fileCount ? ` · ${s.fileCount} bundled file${s.fileCount === 1 ? '' : 's'}` : ''})
            </span>
            {openSkill?.name === s.name && (
              <>
                {openSkill.files.length > 0 && (
                  <div className="skill-files">
                    {openSkill.files.map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                  </div>
                )}
                <pre className="skill-body">{openSkill.content}</pre>
              </>
            )}
          </span>
          <span>
            <button
              className="mini-btn"
              title="View playbook"
              onClick={() =>
                openSkill?.name === s.name
                  ? setOpenSkill(null)
                  : void window.harness.skills
                      .get(s.name)
                      .then((r) => r && setOpenSkill({ name: s.name, content: r.content, files: r.files }))
              }
            >
              {openSkill?.name === s.name ? 'hide' : 'view'}
            </button>
            <button
              className="mini-btn"
              title="Show the skill folder (share it by copying the folder)"
              onClick={() => void window.harness.skills.reveal(s.name)}
            >
              folder
            </button>
            <button
              className="mini-btn danger"
              title="Delete this skill"
              onClick={() => void window.harness.skills.remove(s.name).then(refresh)}
            >
              ✕
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

function McpSection(props: {
  settings: Settings
  onChange: (s: Settings) => void
}): JSX.Element {
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [draft, setDraft] = useState({ name: '', command: '', args: '', env: '' })

  const refresh = useCallback(() => {
    void window.harness.mcp.status().then(setStatus)
  }, [])
  useEffect(refresh, [refresh])

  const save = async (servers: McpServerConfig[]): Promise<void> => {
    props.onChange(await window.harness.settings.set({ mcpServers: servers }))
    setTimeout(refresh, 500)
  }

  const add = (): void => {
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name || !command) return
    // Parse "KEY=VALUE" per line into the server's environment.
    const env: Record<string, string> = {}
    for (const line of draft.env.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) env[m[1]] = m[2]
    }
    const server: McpServerConfig = {
      name,
      command,
      args: draft.args.trim() ? draft.args.trim().split(/\s+/) : [],
      ...(Object.keys(env).length ? { env } : {}),
      enabled: true
    }
    void save([...props.settings.mcpServers.filter((s) => s.name !== name), server])
    setDraft({ name: '', command: '', args: '', env: '' })
  }

  return (
    <div className="memory-section">
      {props.settings.mcpServers.length === 0 && (
        <div className="memory-empty">
          No MCP servers. Add one to expose external tools (filesystem, GitHub, databases…) to Grok.
        </div>
      )}
      {props.settings.mcpServers.map((srv) => {
        const st = status.find((s) => s.name === srv.name)
        return (
          <div key={srv.name} className="memory-entry">
            <span className="memory-entry-text">
              <span className={`tool-status ${st?.connected ? 'ok' : 'error'}`} />{' '}
              <b>{srv.name}</b> <code>{srv.command} {srv.args.join(' ')}</code>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                {st?.connected ? `${st.toolCount} tools` : st?.error ? st.error : 'not connected'}
                {st?.connected && st.tools && st.tools.length > 0 && (
                  <span> — {st.tools.slice(0, 12).join(', ')}{st.tools.length > 12 ? '…' : ''}</span>
                )}
              </div>
            </span>
            <span>
              <button
                className="mini-btn"
                onClick={() =>
                  void save(
                    props.settings.mcpServers.map((s) =>
                      s.name === srv.name ? { ...s, enabled: !s.enabled } : s
                    )
                  )
                }
              >
                {srv.enabled ? 'disable' : 'enable'}
              </button>
              <button
                className="mini-btn danger"
                onClick={() => void save(props.settings.mcpServers.filter((s) => s.name !== srv.name))}
              >
                ✕
              </button>
            </span>
          </div>
        )
      })}
      <div className="mcp-add">
        <input
          className="login-input"
          placeholder="name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="login-input"
          placeholder="command (e.g. npx)"
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
        />
        <input
          className="login-input"
          placeholder="args (e.g. -y @modelcontextprotocol/server-filesystem /path)"
          value={draft.args}
          onChange={(e) => setDraft({ ...draft, args: e.target.value })}
        />
        <textarea
          className="login-input"
          placeholder={'env vars, one per line (e.g. GITHUB_TOKEN=ghp_...)'}
          rows={2}
          value={draft.env}
          onChange={(e) => setDraft({ ...draft, env: e.target.value })}
        />
        <button className="btn" onClick={add}>
          Add server
        </button>
      </div>
    </div>
  )
}

export default function SettingsModal(props: {
  settings: Settings
  email?: string
  /** cwd of the active session, for project-scoped memory */
  activeCwd?: string
  onClose: () => void
  onChange: (s: Settings) => void
  onLogout: () => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('General')
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const update = async (patch: Partial<Settings>): Promise<void> => {
    props.onChange(await window.harness.settings.set(patch))
  }
  const checkUpdate = async (): Promise<void> => {
    setUpdateMsg('Checking…')
    const r = await window.harness.update.check()
    setUpdateMsg(r.ok ? (r.version ? `Update ${r.version} available` : 'Up to date') : r.error ?? 'Check failed')
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`settings-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'General' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Default model</div>
                  <div className="setting-help">Used for new sessions</div>
                </div>
                <select
                  value={props.settings.defaultModel}
                  onChange={(e) => void update({ defaultModel: e.target.value as ModelId })}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Theme</div>
                </div>
                <select
                  value={props.settings.theme}
                  onChange={(e) => void update({ theme: e.target.value as Settings['theme'] })}
                >
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                </select>
              </div>

              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ marginBottom: 6 }}>
                  <div className="setting-label">Custom instructions</div>
                  <div className="setting-help">
                    Appended to the agent&apos;s system prompt in every session
                  </div>
                </div>
                <textarea
                  defaultValue={props.settings.customInstructions}
                  onBlur={(e) => void update({ customInstructions: e.target.value })}
                  placeholder="e.g. Always use pnpm. Prefer TypeScript strict mode."
                />
              </div>
            </>
          )}

          {tab === 'Agent' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Permission mode</div>
                  <div className="setting-help">
                    ask: approve edits & commands · auto-edit: file edits run freely · full-auto:
                    everything runs
                  </div>
                </div>
                <select
                  value={props.settings.permissionMode}
                  onChange={(e) => void update({ permissionMode: e.target.value as PermissionMode })}
                >
                  <option value="ask">ask</option>
                  <option value="auto-edit">auto-edit</option>
                  <option value="full-auto">full-auto</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Web search</div>
                  <div className="setting-help">
                    Let Grok use xAI&apos;s built-in web and X search (runs on xAI servers)
                  </div>
                </div>
                <select
                  value={props.settings.enableWebSearch ? 'on' : 'off'}
                  onChange={(e) => void update({ enableWebSearch: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Parallel subagents</div>
                  <div className="setting-help">
                    Let Grok spawn read-only investigation subagents that run in parallel
                  </div>
                </div>
                <select
                  value={props.settings.enableSubagents ? 'on' : 'off'}
                  onChange={(e) => void update({ enableSubagents: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
            </>
          )}

          {tab === 'Memory' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Memory</div>
                  <div className="setting-help">
                    Grok keeps bounded notes about you and your environment across sessions
                  </div>
                </div>
                <select
                  value={props.settings.memoryEnabled ? 'on' : 'off'}
                  onChange={(e) => void update({ memoryEnabled: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Memory write approval</div>
                  <div className="setting-help">
                    Require your approval before memories are saved (foreground writes prompt
                    inline, background review writes are staged below)
                  </div>
                </div>
                <select
                  value={props.settings.memoryWriteApproval ? 'on' : 'off'}
                  onChange={(e) => void update({ memoryWriteApproval: e.target.value === 'on' })}
                >
                  <option value="off">off</option>
                  <option value="on">on</option>
                </select>
              </div>

              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ marginBottom: 6 }}>
                  <div className="setting-label">Memory contents</div>
                </div>
                <MemorySection cwd={props.activeCwd} />
              </div>
            </>
          )}

          {tab === 'Skills' && (
            <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ marginBottom: 6 }}>
                <div className="setting-label">Skills</div>
                <div className="setting-help">
                  Reusable playbooks — written by the agent as it works, or installed from a
                  GitHub repo / local folder containing SKILL.md files (bundled scripts and
                  reference files are included)
                </div>
              </div>
              <SkillsSection />
            </div>
          )}

          {tab === 'MCP' && (
            <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ marginBottom: 6 }}>
                <div className="setting-label">MCP servers</div>
                <div className="setting-help">
                  Connect external Model Context Protocol servers to add tools (stdio)
                </div>
              </div>
              <McpSection settings={props.settings} onChange={props.onChange} />
            </div>
          )}

          {tab === 'About' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Software updates</div>
                  <div className="setting-help">
                    {updateMsg ?? 'Check for a new version of Grok Harness'}
                  </div>
                </div>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select
                    value={props.settings.autoUpdate ? 'on' : 'off'}
                    onChange={(e) => void update({ autoUpdate: e.target.value === 'on' })}
                  >
                    <option value="on">auto</option>
                    <option value="off">manual</option>
                  </select>
                  <button className="mini-btn" onClick={() => void checkUpdate()}>
                    check now
                  </button>
                </span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Diagnostics</div>
                  <div className="setting-help">Open the folder with application logs</div>
                </div>
                <button className="mini-btn" onClick={() => void window.harness.revealLogs()}>
                  Reveal logs
                </button>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Account</div>
                  <div className="setting-help">{props.email ?? 'Signed in to xAI'}</div>
                </div>
                <button className="btn danger" onClick={props.onLogout}>
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
