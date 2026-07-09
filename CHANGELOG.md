# Changelog

All notable changes to Grok Harness. Each release on GitHub carries the notes
from its section here — the release workflow extracts them automatically when a
version tag is pushed.

## 0.4.2 — 2026-07-09

**Home dashboard**

- New Home page shown at launch and whenever no session is open: time-of-day
  welcome message, usage statistics (sessions, messages, tokens used, sessions
  this week), recent projects grouped by working folder, and recent sessions
- **New project** action opens the native folder picker and starts a session
  there; **Quick session** starts one in your home folder
- Click a recent project to start a new session in that folder; click a recent
  session to jump back into it
- Return to Home anytime via the Grok Harness brand in the sidebar or the home
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
