# Conduit

A cross-platform desktop agent harness for xAI's **Grok 4.5** and **Grok 4.3** models, in the spirit of Claude Desktop / Codex Desktop. Sign in with your **SuperGrok or X Premium+ subscription** (OAuth) — no API key required — and put Grok to work on real projects: it reads, edits, and runs code on your machine with a permissioned tool loop.

## Models

- **Grok Build → Grok 4.5** — xAI's default agentic coding model (500K context, native reasoning, vision). The harness sends `grok-4.5` on the wire; a per-session **reasoning effort** control (default/low/medium/high) sits next to the model picker.
- **Grok 4.3** — flagship reasoning model (1M context) for the hardest planning and debugging work.
- Every assistant reply shows a badge with the model **the xAI API reports it actually served** — not just what the menu says. The same is logged by the provider (`Settings → About → Reveal logs`).

## Features

- **xAI subscription OAuth** — the same public desktop OAuth client + PKCE loopback flow the Grok CLI uses (`auth.x.ai`). Tokens are encrypted at rest with the OS keychain (Electron `safeStorage`) and refreshed automatically. API-key sign-in is available as a fallback.
- **Grok-tuned agent loop** — per-model profiles in `src/main/agent/profiles.ts`:
  - *Grok Build / Grok 4.5* (500K context): plan-first workflow, small verified diffs, context-hygiene rules; background calls (session titles, self-review) automatically run at **low** reasoning effort so your quota goes to real work.
  - *Grok 4.3* (1M context): read-generously strategy, private-reasoning guidance, evidence-required claims to preserve its low-hallucination behavior.
- **Prompt-cache discipline** — stable system-prompt prefix and append-only message history, so xAI's cached-input pricing hits on every agentic turn.
- **Tools** — `bash`, `read_file`, `apply_patch`, `write_file`, `list_dir`, `glob`, `grep`, `diagnostics`, `lsp`, `lsp_edit`, `docs`, `monitor`, `fetch_page`, `update_plan`, `ask_user`. Read-only tools run in parallel; mutations and commands are permission-gated (`ask` / `auto-edit` / `full-auto`) with per-session and global "always allow" plus allowlist learning.
- **`apply_patch` as the primary editor** — Grok edits with Codex-style patches (`*** Begin Patch` … add/update/delete/rename, `@@` hunks), the format the Grok models are tuned to produce. One call can touch several files; a bad hunk aborts the whole patch before anything is written. `write_file` (full rewrite) remains for new/heavily-rewritten files.
- **Code intelligence (LSP)** — `lsp` starts a real language server on demand (TypeScript/JS, Python, Go, Rust, C/C++ when one is installed) for **per-file diagnostics in milliseconds**, go-to-definition, find-references (resolves imports/scoping — more precise than grep), hover signatures, and file symbols. `lsp_edit` then applies **server-computed changes**: `rename` updates a symbol across every file that uses it as one atomic, semantics-aware edit (it will even alias an import rather than break it) — far safer than find/replace — and `fix` lists and applies the quick-fixes the server offers for a diagnostic (add missing import, remove unused, …). Every edit is jailed to the workspace, refused entirely if it would reach outside, snapshotted for rewind, and shown as a diff in the Review panel. `diagnostics` runs the project's own type-checker/linter; `monitor` runs a long command and watches until a regex/log line appears or it exits. Together these give Grok a tight edit → verify loop.
- **Documentation lookup** — `docs` searches and reads **versioned official documentation** (devdocs.io: JavaScript, Python, Node, React, Go, Rust, CSS, PostgreSQL, …) so Grok checks an exact API/signature instead of recalling from memory. Docset indexes cache to disk for a week (instant, offline-tolerant); an exact hit returns the full page in one call.
- **`ask_user`** — Grok can pause mid-run to ask a genuine decision (with quick-reply options) instead of guessing or stalling; the chat shows a question card and the loop resumes on your answer.
- **Built-in xAI tools** — Grok's server-side `web_search` and `x_search` are enabled by default (toggle in Settings); cited sources render as chips under the answer. `fetch_page` then reads any surfaced page in full — readable-text extraction, size/time caps, and local/private-address blocking. The harness talks to the **Responses API** (`/v1/responses`).
- **Live plan** — on multi-step tasks Grok publishes and maintains a checklist via `update_plan`; watch steps tick off live in the Tasks panel. Plans persist with the session.
- **Right dock (Claude Desktop-style)** — a slim icon rail toggles four panels; open panels split their column, Terminal gets its own:
  - *Preview* — renders files as the agent writes them: markdown, sandboxed live HTML, images, highlighted code
  - *Files* — lazy workspace tree that follows agent writes; click to preview
  - *Tasks* — the live plan plus every tool call with status
  - *Terminal* — run dev servers/builds in the workspace with streamed output, stop button, and per-session history
- **Persistent memory** (modeled after [Hermes Agent](https://github.com/NousResearch/hermes-agent)) — bounded, agent-curated stores under `userData/memories/`: `MEMORY.md` (environment facts, lessons), `USER.md` (your preferences), and per-project memory scoped to the workspace. Grok manages them itself via the `memory` tool; hard capacity limits force consolidation, duplicates are rejected, and entries are scanned for prompt-injection patterns. Snapshots are frozen per session to preserve the prompt cache. `session_search` recalls past sessions; the repo's `AGENTS.md`/`CLAUDE.md`/`GROK.md` is included automatically.
- **Skills (procedural memory)** — playbooks the agent writes for itself, plus **install from GitHub** (repo, skill folder, or SKILL.md link — fetched as one tarball, no API rate limits) or a local folder. Skill **bundles** (scripts, reference docs) are copied alongside SKILL.md and surfaced to the agent with runnable paths. Browse, view, reveal-in-folder (for sharing), and delete in Settings → Skills; agent-authored skill writes can be gated behind approval.
- **Background self-review** — after each turn, a cheap low-effort call distills durable lessons into memory/skill ops, evaluates the agent's behavior against its own guidance (recurring misses become corrective self-directives), and refreshes a searchable session digest. Recurring tool failures and permission denials feed into the review.
- **Memory write approval** — optional gate (Settings): foreground writes prompt inline; background writes are staged for approve/reject in Settings → Memory.
- **Diff previews, checkpoints & rewind** — every edit shows a unified diff before it's applied; originals are snapshotted so ↺ on a user message restores files to their state before it.
- **Attachments** — type `@` to fuzzy-attach workspace files; paste images for vision input.
- **Context compaction** — history is auto-summarized as it approaches the model's window, without splitting tool calls from their results.
- **Resilience** — transient API errors (5xx, network blips, short rate limits) retry automatically with a notice instead of killing a long agentic turn; hard rate limits surface as a banner with the reset time; a post-login probe catches xAI's OAuth-allowlist 403 immediately.

## Production features

- **Custom agents** — define agent personas in **Settings → Agents**, each with a title, instructions, a chosen subset of your installed skills, a model, and a permission mode. Pick one per session from the composer (its instructions shape the prompt, only its skills are visible to it, and its model + permission mode take over), or let the main agent delegate a scoped read-only investigation to one **by name** via `spawn_agent`.
- **Parallel subagents** — `spawn_agent` runs up to 8 read-only investigation subagents concurrently (they can `fetch_page` and read `docs` too); pass a custom agent's name to run them with that agent's instructions, scoped skills, and model. Toggle in Settings.
- **MCP client** — connect external stdio MCP servers in Settings → MCP, including per-server env vars (e.g. `GITHUB_TOKEN=...`); connected servers list their tools in the UI. Tools are namespaced `mcp__<server>__<tool>` and flow through the normal permission-gated loop.
- **Git awareness** — branch/dirty status in the header and system prompt.
- **Message controls** — edit-and-resend or fork a session from any message, regenerate the last response; **steering** — type while the agent runs to queue a mid-task course correction without cancelling.
- **Tabbed Settings** — General / Agent / Agents / Memory / Skills / MCP / Security / About.
- **Syntax highlighting**, token/cost meter, session export to markdown, sidebar search, and a native menu with standard shortcuts (⌘N / ⌘K / ⌘, / ⌘. / ⌘L).
- **Auto-update** via GitHub Releases with an in-app "restart to update" prompt; **crash/error reporting** and rotated logs under `userData/logs` (Settings → About → Reveal logs).
- **Hardening** — sandboxed renderer, IPC sender validation, all renderer permissions denied, a destructive-command guardrail on bash, injection scanning on memory and skill content, and external links always open in the system browser.
- **Schema-versioned sessions** with a forward-migration ladder.

## Development

```bash
npm install
npm run dev        # hot-reloading dev app
npm run typecheck
npm run build      # production bundles into out/
```

## Releasing

Tag a version and CI builds and publishes installers for macOS, Windows, and Linux to GitHub Releases (the auto-updater picks them up):

```bash
# bump "version" in package.json, commit, then:
git tag vX.Y.Z && git push origin main vX.Y.Z
```

Local packaging: `npm run dist` (or `dist:mac` / `dist:win` / `dist:linux`) → installers in `release/`.

Unsigned-build caveats: on macOS right-click → Open the first time; Windows SmartScreen needs "More info → Run anyway". To ship signed builds, add the credentials listed in [build/README.md](build/README.md) as repo secrets — the release workflow uses them automatically when present. App icons go under `build/`.

## Auth notes

- OAuth uses the public Grok CLI desktop client ID against `https://auth.x.ai` with a loopback redirect on `127.0.0.1:56121` (random-port fallback). This is public desktop OAuth metadata, not a secret.
- Bearer tokens are only ever sent to `https://api.x.ai` (enforced in `src/main/agent/provider.ts`).
- **Caveat:** xAI's backend enforces its own allowlist on the OAuth API surface and has been known to reject some accounts with HTTP 403 even on active subscriptions. If that happens, use the API-key fallback on the login screen.

## Architecture

```
src/
  shared/types.ts          IPC contract shared by all processes
  main/
    index.ts               window + app lifecycle
    ipc.ts                 typed IPC handlers
    sessions.ts            JSON-per-session persistence (schema-versioned)
    panels.ts              right-dock backend: file browsing + terminal runner
    auth/oauth.ts          PKCE loopback flow against auth.x.ai
    auth/store.ts          safeStorage-encrypted credentials + refresh
    agent/provider.ts      SSE streaming client for api.x.ai (/v1/responses)
    agent/tools.ts         tool implementations (apply_patch, lsp, lsp_edit, docs, diagnostics, monitor, ask_user, …)
    agent/apply-patch.ts   Codex-format patch parser + applier
    agent/lsp/             language-server client (rpc, servers, client, manager, edit)
    agent/docs.ts          devdocs.io documentation client (cached)
    agent/profiles.ts      per-model tuning: prompts, budgets, reasoning effort, custom-agent personas
    agent/loop.ts          the agent loop: model ↔ tools, permissions, compaction, retry
    agent/memory.ts        bounded memory stores + injection scanning
    agent/skills.ts        directory-per-skill store (SKILL.md + bundled files)
    agent/skill-install.ts GitHub/folder skill importer (bundles included)
    agent/subagent.ts      parallel read-only investigation subagents (incl. custom-agent delegation)
    agent/mcp.ts           MCP client (stdio)
  preload/index.ts         contextBridge (window.harness)
  renderer/                React UI: chat, sidebar, right dock, settings
```
