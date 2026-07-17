import { JSX, useCallback, useEffect, useState } from 'react'
import {
  McpInstallPreview,
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
import { CheckIcon, XIcon } from './Icons'

const TABS = ['General', 'Agent', 'Memory', 'Skills', 'MCP', 'Security', 'About'] as const
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
                <button className="mini-btn" title="Approve" onClick={() => resolve(p.id, true)}>
                  <CheckIcon size={12} strokeWidth={2.2} />
                </button>
                <button className="mini-btn danger" title="Reject" onClick={() => resolve(p.id, false)}>
                  <XIcon size={12} strokeWidth={2.2} />
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
                  <XIcon size={12} strokeWidth={2.2} />
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
                <button className="mini-btn" title="Approve" onClick={() => resolve(p.id, true)}>
                  <CheckIcon size={12} strokeWidth={2.2} />
                </button>
                <button className="mini-btn danger" title="Reject" onClick={() => resolve(p.id, false)}>
                  <XIcon size={12} strokeWidth={2.2} />
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
              <XIcon size={12} strokeWidth={2.2} />
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
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<McpInstallPreview | null>(null)
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [installName, setInstallName] = useState('')
  const [installMsg, setInstallMsg] = useState<string | null>(null)
  const [editEnv, setEditEnv] = useState<string | null>(null)
  const [editEnvText, setEditEnvText] = useState('')

  const refresh = useCallback(() => {
    void window.harness.mcp.status().then(setStatus)
  }, [])
  useEffect(refresh, [refresh])

  const save = async (servers: McpServerConfig[]): Promise<void> => {
    props.onChange(await window.harness.settings.set({ mcpServers: servers }))
    // settings:set already reconnects MCP when the list changes
    setTimeout(refresh, 800)
  }

  const addManual = (): void => {
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name || !command) return
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

  const inspect = async (): Promise<void> => {
    const input = url.trim()
    if (!input) return
    setBusy(true)
    setInstallMsg(null)
    setPreview(null)
    try {
      const p = await window.harness.mcp.previewInstall(input)
      setPreview(p)
      if (p.ok) {
        setInstallName(p.name ?? '')
        const init: Record<string, string> = {}
        for (const e of p.envNeeds ?? []) init[e.key] = ''
        setEnvValues(init)
      }
    } finally {
      setBusy(false)
    }
  }

  const confirmInstall = async (): Promise<void> => {
    if (!preview?.ok) return
    setBusy(true)
    setInstallMsg(null)
    try {
      const result = await window.harness.mcp.install(url.trim(), {
        name: installName.trim() || preview.name,
        env: envValues
      })
      if (!result.ok) {
        setInstallMsg(result.error ?? 'Install failed')
        return
      }
      // Refresh settings from main so the list updates
      props.onChange(await window.harness.settings.get())
      if (result.status) setStatus(result.status)
      else refresh()
      const missing = result.missingEnv?.length
        ? ` Installed — still need: ${result.missingEnv.join(', ')}`
        : ' Installed and connecting…'
      setInstallMsg((result.notes ?? []).join(' ') + missing)
      setPreview(null)
      setUrl('')
      setEnvValues({})
    } finally {
      setBusy(false)
    }
  }

  const saveEnvFor = async (name: string): Promise<void> => {
    const env: Record<string, string> = {}
    for (const line of editEnvText.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (m) env[m[1]] = m[2]
    }
    await save(
      props.settings.mcpServers.map((s) =>
        s.name === name ? { ...s, env: Object.keys(env).length ? env : undefined } : s
      )
    )
    setEditEnv(null)
    setEditEnvText('')
  }

  return (
    <div className="memory-section">
      <div className="skill-install">
        <div className="mcp-add">
          <input
            className="login-input"
            placeholder="GitHub URL, owner/repo, or npm package (e.g. @modelcontextprotocol/server-github)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void inspect()
            }}
            disabled={busy}
          />
          <button className="btn" onClick={() => void inspect()} disabled={busy || !url.trim()}>
            {busy && !preview ? 'Inspecting…' : 'Install from link'}
          </button>
        </div>
        <div className="setting-hint" style={{ marginTop: 6 }}>
          Same idea as Skills: paste a repo or package and we detect the start command and any API keys.
        </div>
      </div>

      {preview && !preview.ok && (
        <div className="skill-install-report" style={{ color: 'var(--err)' }}>
          {preview.error}
        </div>
      )}

      {preview?.ok && (
        <div className="mcp-install-preview">
          <div className="memory-header">
            <span>
              Ready to install <b>{preview.source ?? preview.name}</b>
            </span>
            <button className="mini-btn" onClick={() => setPreview(null)} disabled={busy}>
              cancel
            </button>
          </div>
          <div className="mcp-install-row">
            <label>Name</label>
            <input
              className="login-input"
              value={installName}
              onChange={(e) => setInstallName(e.target.value)}
            />
          </div>
          <div className="mcp-install-cmd">
            <code>
              {preview.command} {(preview.args ?? []).join(' ')}
            </code>
          </div>
          {(preview.notes ?? []).length > 0 && (
            <ul className="mcp-install-notes">
              {preview.notes!.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {(preview.envNeeds ?? []).length > 0 && (
            <div className="mcp-install-env">
              <div className="setting-label">Secrets & config</div>
              <div className="setting-hint">Required fields are marked. You can leave optional ones blank.</div>
              {preview.envNeeds!.map((e) => (
                <div key={e.key} className="mcp-install-row">
                  <label title={e.description}>
                    {e.key}
                    {e.required ? ' *' : ''}
                  </label>
                  <input
                    className="login-input"
                    type="password"
                    autoComplete="off"
                    placeholder={e.placeholder ?? e.description ?? e.key}
                    value={envValues[e.key] ?? ''}
                    onChange={(ev) => setEnvValues((v) => ({ ...v, [e.key]: ev.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
          <button className="btn primary" onClick={() => void confirmInstall()} disabled={busy}>
            {busy ? 'Installing…' : 'Add MCP server'}
          </button>
        </div>
      )}

      {installMsg && <div className="skill-install-report">{installMsg}</div>}

      {props.settings.mcpServers.length === 0 && !preview && (
        <div className="memory-empty">
          No MCP servers yet. Install from a GitHub link above, or add one manually below.
        </div>
      )}

      {props.settings.mcpServers.map((srv) => {
        const st = status.find((s) => s.name === srv.name)
        const envKeys = Object.keys(srv.env ?? {})
        return (
          <div key={srv.name} className="memory-entry">
            <span className="memory-entry-text">
              <span className={`tool-status ${st?.connected ? 'ok' : srv.enabled ? 'error' : ''}`} />{' '}
              <b>{srv.name}</b>{' '}
              <code>
                {srv.command} {srv.args.join(' ')}
              </code>
              {srv.source && (
                <span style={{ fontSize: 11, opacity: 0.55 }}> · {srv.source}</span>
              )}
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                {!srv.enabled
                  ? 'disabled'
                  : st?.connected
                    ? `${st.toolCount} tools`
                    : st?.error
                      ? st.error
                      : 'connecting…'}
                {st?.connected && st.tools && st.tools.length > 0 && (
                  <span>
                    {' '}
                    — {st.tools.slice(0, 12).join(', ')}
                    {st.tools.length > 12 ? '…' : ''}
                  </span>
                )}
                {envKeys.length > 0 && (
                  <span> · env: {envKeys.join(', ')}</span>
                )}
              </div>
              {editEnv === srv.name && (
                <div className="mcp-edit-env">
                  <textarea
                    className="login-input"
                    rows={3}
                    placeholder={'KEY=value\nOTHER=…'}
                    value={editEnvText}
                    onChange={(e) => setEditEnvText(e.target.value)}
                  />
                  <span>
                    <button className="mini-btn" onClick={() => void saveEnvFor(srv.name)}>
                      save env
                    </button>
                    <button className="mini-btn" onClick={() => setEditEnv(null)}>
                      cancel
                    </button>
                  </span>
                </div>
              )}
            </span>
            <span>
              <button
                className="mini-btn"
                title="Edit environment variables"
                onClick={() => {
                  setEditEnv(srv.name)
                  setEditEnvText(
                    Object.entries(srv.env ?? {})
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n')
                  )
                }}
              >
                env
              </button>
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
                title="Remove server"
                onClick={() => void save(props.settings.mcpServers.filter((s) => s.name !== srv.name))}
              >
                <XIcon size={12} strokeWidth={2.2} />
              </button>
            </span>
          </div>
        )
      })}

      <details className="mcp-manual">
        <summary>Add manually</summary>
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
          <button className="btn" onClick={addManual}>
            Add server
          </button>
        </div>
      </details>
    </div>
  )
}

export default function SettingsModal(props: {
  settings: Settings
  email?: string
  /** cwd of the active session, for project-scoped memory */
  activeCwd?: string
  initialTab?: string
  onClose: () => void
  onChange: (s: Settings) => void
  onLogout: () => void
}): JSX.Element {
  const initial = (TABS as readonly string[]).includes(props.initialTab ?? '')
    ? (props.initialTab as Tab)
    : 'General'
  const [tab, setTab] = useState<Tab>(initial)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const [audit, setAudit] = useState<import('@shared/types').AuditEvent[]>([])
  const [catalog, setCatalog] = useState<import('@shared/types').McpCatalogEntry[]>([])
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null)
  const [catalogMsg, setCatalogMsg] = useState<{ id: string; text: string; err?: boolean } | null>(
    null
  )
  const update = async (patch: Partial<Settings>): Promise<void> => {
    props.onChange(await window.harness.settings.set(patch))
  }
  useEffect(() => {
    if (tab === 'Security') void window.harness.audit.list(100).then(setAudit)
    if (tab === 'MCP') void window.harness.mcpCatalog.list().then(setCatalog)
  }, [tab])
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
                  <div className="setting-label">Notifications</div>
                  <div className="setting-help">
                    System notification when a task finishes or needs approval while the app is in
                    the background
                  </div>
                </div>
                <select
                  value={props.settings.notifications ? 'on' : 'off'}
                  onChange={(e) => void update({ notifications: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
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
                  <div className="setting-label">Agent profile</div>
                  <div className="setting-help">
                    Careful / Balanced / YOLO — sets default permission mode
                  </div>
                </div>
                <select
                  value={props.settings.agentProfile}
                  onChange={(e) => {
                    const id = e.target.value as Settings['agentProfile']
                    const map = {
                      careful: 'ask' as PermissionMode,
                      balanced: 'auto-edit' as PermissionMode,
                      yolo: 'full-auto' as PermissionMode
                    }
                    void update({ agentProfile: id, permissionMode: map[id] })
                  }}
                >
                  <option value="careful">careful</option>
                  <option value="balanced">balanced</option>
                  <option value="yolo">yolo</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Permission mode</div>
                  <div className="setting-help">
                    ask · auto-edit · full-auto · plan-only (read/plan, no writes)
                  </div>
                </div>
                <select
                  value={props.settings.permissionMode}
                  onChange={(e) => void update({ permissionMode: e.target.value as PermissionMode })}
                >
                  <option value="ask">ask</option>
                  <option value="auto-edit">auto-edit</option>
                  <option value="full-auto">full-auto</option>
                  <option value="plan-only">plan-only</option>
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
                  <div className="setting-label">Test after edit</div>
                  <div className="setting-help">
                    After write/edit tools, remind the agent to run checks
                  </div>
                </div>
                <select
                  value={props.settings.testAfterEdit ? 'on' : 'off'}
                  onChange={(e) => void update({ testAfterEdit: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ marginBottom: 6 }}>
                  <div className="setting-label">Test command</div>
                  <div className="setting-help">Optional preferred verify command (e.g. npm test)</div>
                </div>
                <input
                  className="text-input"
                  defaultValue={props.settings.testCommand}
                  onBlur={(e) => void update({ testCommand: e.target.value })}
                  placeholder="npm test"
                />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Multi-model routing</div>
                  <div className="setting-help">
                    Use a lighter model for titles, compaction, and background review
                  </div>
                </div>
                <select
                  value={props.settings.multiModelRouting ? 'on' : 'off'}
                  onChange={(e) => void update({ multiModelRouting: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Repository map</div>
                  <div className="setting-help">Inject a frozen top-level file map into the system prompt</div>
                </div>
                <select
                  value={props.settings.repoMapEnabled ? 'on' : 'off'}
                  onChange={(e) => void update({ repoMapEnabled: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Custom slash commands</div>
                  <div className="setting-help">
                    Prompt templates as .md files — the filename is the command, $ARGUMENTS is
                    replaced with what you type after it. /init is built in.
                  </div>
                </div>
                <button className="mini-btn" onClick={() => void window.harness.commands.openFolder()}>
                  Open folder
                </button>
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
              {catalog.length > 0 && (
                <div className="mcp-catalog" style={{ marginBottom: 12 }}>
                  <div className="setting-label" style={{ marginBottom: 6 }}>
                    Catalog
                  </div>
                  {catalog.map((c) => {
                    const installed = props.settings.mcpServers.some(
                      (s) => s.source === `npm:${c.install}` || s.name === c.id
                    )
                    const busy = catalogBusy === c.id
                    const msg = catalogMsg?.id === c.id ? catalogMsg : null
                    return (
                      <div key={c.id} className="mcp-catalog-row">
                        <div>
                          <b>{c.name}</b>
                          <div className="setting-help">
                            {c.description} · risk: {c.risk}
                          </div>
                          {msg && (
                            <div
                              className="setting-help"
                              style={{ color: msg.err ? 'var(--err)' : 'var(--ok)' }}
                            >
                              {msg.text}
                            </div>
                          )}
                        </div>
                        <button
                          className="mini-btn"
                          disabled={installed || busy}
                          onClick={() => {
                            setCatalogBusy(c.id)
                            setCatalogMsg(null)
                            void window.harness.mcp
                              .install(c.install)
                              .then(async (r) => {
                                props.onChange(await window.harness.settings.get())
                                if (r.ok) {
                                  setCatalogMsg({
                                    id: c.id,
                                    text: r.missingEnv?.length
                                      ? `Installed — add ${r.missingEnv.join(', ')} below to connect.`
                                      : 'Installed and connecting…'
                                  })
                                } else {
                                  setCatalogMsg({ id: c.id, text: r.error ?? 'Install failed', err: true })
                                }
                              })
                              .finally(() => setCatalogBusy(null))
                          }}
                        >
                          {installed ? 'Installed' : busy ? 'Installing…' : 'Install'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              <McpSection settings={props.settings} onChange={props.onChange} />
            </div>
          )}

          {tab === 'Security' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Require workspace trust</div>
                  <div className="setting-help">
                    Agent tools blocked until you trust the folder (VS Code-style)
                  </div>
                </div>
                <select
                  value={props.settings.requireWorkspaceTrust ? 'on' : 'off'}
                  onChange={(e) => void update({ requireWorkspaceTrust: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Trusted workspaces</div>
                  <div className="setting-help">
                    {props.settings.trustedWorkspaces.length
                      ? props.settings.trustedWorkspaces.slice(0, 5).join(' · ')
                      : 'None yet'}
                    {props.settings.trustedWorkspaces.length > 5
                      ? ` · +${props.settings.trustedWorkspaces.length - 5} more`
                      : ''}
                  </div>
                </div>
                {props.activeCwd && (
                  <button
                    className="mini-btn"
                    onClick={() =>
                      void window.harness.workspace
                        .setTrust(props.activeCwd!, 'trusted')
                        .then(async () => props.onChange(await window.harness.settings.get()))
                    }
                  >
                    Trust current
                  </button>
                )}
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Audit log</div>
                  <div className="setting-help">Record permissions, tools, MCP, and trust changes</div>
                </div>
                <select
                  value={props.settings.auditLogEnabled ? 'on' : 'off'}
                  onChange={(e) => void update({ auditLogEnabled: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Allowlist</div>
                  <div className="setting-help">
                    {props.settings.globalAllowlist.length
                      ? `${props.settings.globalAllowlist.length} global keys`
                      : 'Empty — approvals are one-shot unless you choose Always'}
                  </div>
                </div>
                <button
                  className="mini-btn"
                  disabled={!props.settings.globalAllowlist.length}
                  onClick={() => void update({ globalAllowlist: [] })}
                >
                  Clear allowlist
                </button>
              </div>
              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div className="setting-label">Recent audit events</div>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="mini-btn" onClick={() => void window.harness.audit.export()}>
                      Export
                    </button>
                    <button
                      className="mini-btn"
                      onClick={() => void window.harness.audit.clear().then(() => setAudit([]))}
                    >
                      Clear
                    </button>
                  </span>
                </div>
                <div className="audit-list">
                  {audit.length === 0 && <div className="setting-help">No events yet</div>}
                  {audit.slice(0, 40).map((e) => (
                    <div key={e.id} className="audit-row">
                      <span className="audit-kind">{e.kind}</span>
                      <span className="audit-summary">{e.summary}</span>
                      <span className="audit-ts">{new Date(e.ts).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'About' && (
            <>
              <div className="setting-row">
                <div>
                  <div className="setting-label">Software updates</div>
                  <div className="setting-help">
                    {updateMsg ?? 'Check for a new version of Conduit'}
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
                  <select
                    value={props.settings.updateChannel}
                    onChange={(e) => {
                      const ch = e.target.value as Settings['updateChannel']
                      void update({ updateChannel: ch })
                      void window.harness.update.setChannel(ch)
                    }}
                  >
                    <option value="latest">stable</option>
                    <option value="beta">beta</option>
                  </select>
                  <button className="mini-btn" onClick={() => void checkUpdate()}>
                    check now
                  </button>
                </span>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Reduced motion</div>
                  <div className="setting-help">Minimize animations for accessibility</div>
                </div>
                <select
                  value={props.settings.reducedMotion ? 'on' : 'off'}
                  onChange={(e) => void update({ reducedMotion: e.target.value === 'on' })}
                >
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Diagnostics</div>
                  <div className="setting-help">Logs and a support bundle for troubleshooting</div>
                </div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="mini-btn" onClick={() => void window.harness.revealLogs()}>
                    Reveal logs
                  </button>
                  <button
                    className="mini-btn"
                    onClick={() =>
                      void window.harness.crash.copyDiagnostics().then((r) => {
                        if (r.ok && r.path) alert(`Saved:\n${r.path}`)
                        else if (r.error) alert(r.error)
                      })
                    }
                  >
                    Save diagnostics
                  </button>
                </span>
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
