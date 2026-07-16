# Changelog

All notable changes to Conduit. Each release on GitHub carries the notes
from its section here — the release workflow extracts them automatically when a
version tag is pushed.

## 0.5.3 — 2026-07-16

**Auth banner fix + security updates**

- **Fixed: permanent "Your session is not valid. Please sign in again." banner** after a
  successful OAuth sign-in. The health probe called `/v1/api-key`, which authenticates xAI
  API keys only and rejects a valid subscription OAuth bearer with 401. It now probes
  `/v1/models`, which accepts both credential types.
- **Fixed: stale offline status** — the probe ran before sign-in and never re-ran after it,
  so a pre-login failure could linger for up to two minutes (and a healthy status could
  outlive a logout). Probing is now scoped to the signed-in credential.
- **Fixed: MCP catalog gave no feedback** — every entry showed "Install" even when already
  installed, and successes and failures were both silent. Entries now show
  Install / Installing… / Installed, and report errors.
- **Electron 33 → 43**: Electron 33 is end-of-life and no longer receives security
  backports. Clears 18 advisories, incl. ASAR integrity bypass (GHSA-vmqv-hx8q-j7mg).
- **electron-builder 25 → 26**: clears 7 `tar` advisories in the build toolchain
  (`tar@6` had no patched release; fixes landed in 7.5.16+).
- `npm audit` now reports 0 vulnerabilities, down from 10 high.

## 0.5.2 — 2026-07-10

**Full Conduit branding + repo rename**

- GitHub repository renamed **`hypnos1450/Grok-App` → `hypnos1450/Conduit`**
- electron-builder publish target and git remote updated to the new repo
- Auto-update feed now points at Conduit releases

## 0.5.1 — 2026-07-10

**Rename to Conduit**

- Product name, window title, installers, and UI branding are now **Conduit**
- Bundle id `com.conduit.app`; npm package name `conduit`

## 0.5.0 — 2026-07-10

**Major product + agent upgrade**

- **Plan-only mode** (session toggle + permission mode): read/plan tools only; no writes/shell/MCP
- **Agent profiles**: careful / balanced / yolo map to permission defaults
- **Test-after-edit**: post-write verification hints + optional test command
- **Multi-model routing**: lighter model for titles, compaction, background review
- **Repo map**: frozen top-level tree injected into the system prompt
- **Workspace trust**: first-open gate before agent tools (banner + Settings → Security)
- **Security center**: audit log, allowlist clear, trusted workspaces
- **Command palette** (⇧⌘O) and **session search** (⇧⌘F) across titles/digests/messages
- **Review dock panel**: files changed this turn + plan checklist
- **GitHub PR** via `gh` CLI (composer chip + menu)
- **MCP catalog** one-click installs (still confirm)
- **Update channel** stable/beta; offline/auth status banner; diagnostics export
- **Reduced motion** setting; richer Home/Sidebar search entry points

## 0.4.8 — 2026-07-10

**Security hardening**

- Workspace path jail for agent file tools + panel browser (`realpath`, reject `..` / absolute escapes)
- Schema-validated `settings:set`; MCP command changes require a native confirm dialog
- Session cwd must be an existing directory; session/job IDs sanitized before path joins
- Terminal IPC session-bound with command/stdin caps (no free-form path)
- Path-scoped write allowlists; bash allowlist only for simple (non-compound) commands
- `fetch_page` re-validates DNS + every redirect hop against private IPs
- Credentials fail closed without OS secure storage; MCP env secrets in `secrets.bin`
- Permission responses bound to session + single-use request ids; updater IPC uses sender checks
- Strip credential-like env vars from agent bash; filtered env for MCP servers
- Tighter CSP (`object-src`, `base-uri`, `form-action`, `frame-ancestors`)

## 0.4.7 — 2026-07-10

**macOS quarantine after update**

- Clear `com.apple.quarantine` on launch (unsigned/ad-hoc builds)
- Custom Mac install path: unzip update, strip quarantine, swap `.app`, relaunch — so you should not need `xattr -cr` after auto-update
- Real long-term fix remains Developer ID signing + notarization (`CSC_LINK` + Apple secrets; see `build/README.md`)

## 0.4.6 — 2026-07-10

**Mac “Restart to update” fix**

- Force-quit path for `quitAndInstall` on macOS (destroy windows, `isForceRunAfter`, fall back to `app.exit`)
- Only show **Restart to update** after the package is fully downloaded; show a downloading state before that
- Quit the app when the last window closes during an update install (macOS normally stays alive)

## 0.4.5 — 2026-07-10

**Windows release runner pin**

- Pin release matrix to `windows-2022` — `windows-latest` now has VS 18, which the node-gyp bundled with electron-builder cannot detect, so `node-pty` rebuild still failed after 0.4.4

## 0.4.4 — 2026-07-10

**Release CI fix for node-pty**

- Bump GitHub Actions to Node 22 (matches `@electron/rebuild` / `node-abi` engines)
- Install Python 3.12 + setuptools so node-gyp has `distutils` on macOS/Linux
- Set up MSVC build tools on Windows (`ilammy/msvc-dev-cmd`) so `node-pty` rebuilds during `npm ci`
- Unblocks multi-platform release builds that failed on macOS and Windows in 0.4.3

## 0.4.3 — 2026-07-09

**Terminal overhaul**

- Real terminal panel with xterm.js (colors, selection, search, clickable links)
- Interactive PTY via node-pty when available, with enhanced multi-job spawn fallback
- Multiple concurrent job tabs per session (create/close, process-tree kill, restart last command)
- Sticky cwd, command history, scrollback persistence, open-in-system-terminal
- Pin agent `bash` tool cards into the Terminal panel; send terminal selection to chat
- Exit notifications when a job finishes while the app is unfocused

**MCP install-from-link**

- Paste a GitHub URL, owner/repo, or npm package in Settings → MCP to install a server
- Detects start command (package.json, mcp.json, smithery, known recipes) and required API keys
- Secrets form before install; per-server env editor afterward
- Manual add kept under a collapsible section

**Context usage meter**

- Header pill now shows live context fill vs model window (e.g. `27% · 135k / 500k`)
- Lifetime session totals moved to the tooltip so long sessions no longer look like a multi‑million-token window

## 0.4.2 — 2026-07-09

**Home dashboard**

- New Home page shown at launch and whenever no session is open: time-of-day
  welcome message, usage statistics (sessions, messages, tokens used, sessions
  this week), recent projects grouped by working folder, and recent sessions
- **New project** action opens the native folder picker and starts a session
  there; **Quick session** starts one in your home folder
- Click a recent project to start a new session in that folder; click a recent
  session to jump back into it
- Return to Home anytime via the Conduit brand in the sidebar or the home
  icon in the collapsed rail
- The in-session welcome is now a compact starter-pill row instead of the large
  card grid, keeping the focus on the composer
- Removed the old unstyled "Start a session" screen entirely

## 0.4.1 — 2026-07-09

**Welcome page redesign + SVG icon set**

- Reworked the empty-session welcome: greeting hero with glowing logo tile and
  accent halo, model/branch/folder context chips, starter cards with
  descriptions and hover arrows, keyboard-hint footer
- New shared SVG icon set replaces the small unicode glyph icons throughout the
  app (settings gear, search, sidebar collapse, new session, close, edit, fork,
  restore, regenerate, send/stop/queue, expand/shrink, warning)
- Larger icon-button hit areas across the sidebar, dock rail, and panel headers
- Accessibility: restored accessible names on icon-only buttons, bumped
  low-contrast welcome text to meet WCAG AA, reduced-motion setting now also
  neutralizes staggered animation delays
- Fixed attachment-remove icon centering and welcome-chip text truncation

## 0.4.0 — 2026-07-08

**UI polish batch + app icon**

- App icon (spark mark) on all platforms, plus Intel macOS builds alongside
  Apple Silicon
- Native system notifications when a task finishes or needs approval while the
  app is in the background — click to jump to the session
- Slash commands: built-in `/init` writes a GROK.md project guide; drop your
  own `*.md` prompts in the commands folder to add custom ones
- Drag & drop files and images anywhere in the chat to attach them
- Sidebar run awareness: colored dots show which sessions are running, blocked
  on approval, or finished unseen; sessions grouped by date; collapsible
  sidebar (⌘\)
- Welcome screen with starter prompts for empty sessions
- macOS vibrancy window chrome, refined tool cards with status colors, custom
  scrollbars, richer markdown (tables, blockquotes), circular send button,
  permission prompt card, light-theme parity pass
- Fixed a GPU crash when previewing certain HTML files: preview scripts are now
  opt-in per file, and the app auto-recovers if the renderer dies

## 0.3.0 — 2026-07-08

**Deeper Grok 4.5 support + agent tools**

- Reasoning-effort control for Grok 4.5 (low / medium / high) from the composer
- New `fetch_page` tool: the agent can read web pages (size-capped, private
  hosts blocked)
- Live plan: the agent maintains a step-by-step plan visible in the Tasks panel
  as it works
- Automatic retry with backoff on transient API errors mid-run
- Docs updated around Grok 4.5
- Fixed the release pipeline race that left macOS assets off multi-platform
  releases

## 0.2.0 — 2026-07-08

**Grok 4.5, right dock, and skill installs**

- Grok Build now runs Grok 4.5 on the wire, with served-model verification (the
  API's echoed model is logged and shown, so you can confirm what answered)
- Right-side dock, Claude Desktop style: artifact Preview, project Files tree,
  Tasks list, and a Terminal — collapsible rail, multi-panel stacking
- Install skills from a GitHub repo or a local folder, including bundled
  scripts and reference files
- Settings reorganized into tabs (General / Agent / Memory / Skills / MCP /
  About)

## 0.1.0 — 2026-07-08

**Initial release**

- Desktop agent harness for xAI Grok with xAI subscription OAuth sign-in
- Streaming agent loop with bash, file-edit, and search tools, parallel
  subagents, and permission prompts with allowlist learning
- Sessions with checkpoints and file rewind, edit-and-resend, forking,
  steering messages mid-run, export, and search
- Self-evolving memory: agent notes, user profile, and per-project memory with
  approval-gated writes; agent-authored skills
- MCP server support, git awareness, token/cost usage meter, diff previews,
  syntax highlighting, keyboard shortcuts and native menus
- Auto-updater and a multi-platform CI release pipeline (macOS, Windows, Linux)
