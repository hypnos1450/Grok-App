# Grok Harness

A cross-platform desktop agent harness for xAI's **Grok 4.3** and **Grok Build** models, in the spirit of Claude Desktop / Codex Desktop. Sign in with your **SuperGrok or X Premium+ subscription** (OAuth) — no API key required — and put Grok to work on real projects: it reads, edits, and runs code on your machine with a permissioned tool loop.

## Features

- **xAI subscription OAuth** — the same public desktop OAuth client + PKCE loopback flow the Grok CLI uses (`auth.x.ai`). Tokens are encrypted at rest with the OS keychain (Electron `safeStorage`) and refreshed automatically. API-key sign-in is available as a fallback.
- **Grok-tuned agent loop** — per-model profiles in `src/main/agent/profiles.ts`:
  - *Grok 4.3* (1M context): read-generously strategy, private-reasoning guidance, evidence-required claims to preserve its low-hallucination behavior.
  - *Grok Build* (256K context): plan-first workflow, small verified diffs, context-hygiene rules matching how the model was trained in Grok Build CLI.
- **Prompt-cache discipline** — stable system-prompt prefix and append-only message history, so xAI's cached-input pricing (~6× cheaper) hits on every agentic turn.
- **Tools** — `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`. Read-only tools run in parallel; mutations and commands are permission-gated (`ask` / `auto-edit` / `full-auto`) with per-session "always allow".
- **Built-in xAI tools** — Grok's server-side `web_search` and `x_search` are enabled by default (toggle in Settings). Searches run on xAI's infrastructure, appear as tool cards in the transcript, and cited sources render as chips under the answer. The harness talks to the **Responses API** (`/v1/responses`) — the same surface the Grok CLI uses.
- **Persistent memory** (modeled after [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s built-in memory) — two bounded, agent-curated stores under `userData/memories/`: `MEMORY.md` (environment facts, conventions, lessons — 2,200 chars) and `USER.md` (your preferences and style — 1,375 chars). Grok manages them itself via a `memory` tool (`add`/`replace`/`remove` with substring matching); hard capacity limits force consolidation instead of silent dropping, duplicates are rejected, and entries are scanned for prompt-injection patterns before being accepted. Snapshots are frozen per session to preserve the prompt cache. A `session_search` tool additionally lets Grok search all past sessions for things you discussed before. Toggle in Settings.
- **Skills (procedural memory)** — the agent writes SKILL.md playbooks for itself when it works out reusable multi-step procedures (deploy steps, codegen, release rituals). A skills index lives in the system prompt; bodies are read on demand via the `skill` tool and updated when a procedure proves wrong. Browse/view/delete in Settings → Skills.
- **Per-project memory** — a third memory store scoped to the workspace (conventions, build commands, gotchas for *this* repo), plus automatic inclusion of the repo's `AGENTS.md`/`CLAUDE.md`/`GROK.md` in the system prompt.
- **Background self-review** — after each completed turn, a fire-and-forget call reviews the exchange and distills durable lessons into memory ops and skill ops, evaluates the agent's own behavior against its guidance (feeding recurring misses back as corrective self-directives), and refreshes a searchable session digest. Recurring tool failures and permission denials are tracked locally and fed into the review so repeated mistakes become lessons.
- **Allowlist learning** — approval counts per command are tracked; the permission prompt hints when you've approved something ≥3 times, and offers "Always (all sessions)" alongside per-session allows.
- **Memory write approval** — optional gate (Settings): foreground memory writes prompt inline; background review writes are staged for approve/reject in Settings → Memory, where you can also browse and delete individual entries.
- **Diff previews** — `edit_file`/`write_file` show a unified diff in the permission prompt and tool card before anything is applied.
- **Checkpoints & rewind** — originals are snapshotted before the file tools mutate anything; hover a user message and hit ↺ to restore all files to their state before that message (bash-driven mutations are not captured).
- **Attachments** — type `@` to fuzzy-attach workspace files (contents inlined into the message), paste images for Grok 4.3 vision input.
- **Context compaction** — history is auto-summarized when it approaches each model's window, without splitting tool calls from their results.
- **Sessions** — persisted per-project sessions with streaming responses, reasoning traces, tool cards, usage/context meter, and auto-generated titles.

## Production features

- **Parallel subagents** — Grok can `spawn_agent` up to 8 read-only investigation subagents that run concurrently and report findings back (matching Grok Build CLI's parallel-subagent workflow). Toggle in Settings.
- **MCP client** — connect external stdio MCP servers (Settings → MCP servers); their tools are namespaced `mcp__<server>__<tool>` and flow through the normal permission-gated loop.
- **Git awareness** — branch/dirty status in the header and system prompt.
- **Message controls** — edit-and-resend or fork a session from any message, regenerate the last response.
- **Steering** — type while the agent runs to queue a mid-task course correction without cancelling.
- **Diff-previewed edits, checkpoints/rewind, syntax highlighting**, token/cost meter, session export to markdown, sidebar search, and a native menu with standard shortcuts (⌘N / ⌘K / ⌘, / ⌘. / ⌘L).
- **Auto-update** via GitHub Releases with an in-app "restart to update" prompt; **crash/error reporting** and rotated logs under `userData/logs` (Settings → Reveal logs).
- **Hardening** — sandboxed renderer, IPC sender validation, all-renderer-permissions denied, and a destructive-command guardrail on the bash tool (blocks `rm -rf /`-class commands even under full-auto).
- **Rate-limit & quota UX** — 429s surface as a friendly banner with reset time; a post-login probe catches xAI's OAuth-allowlist 403 immediately instead of on your first message.
- **Schema-versioned sessions** with a forward-migration ladder.

### Before releasing
Two manual steps (see [build/README.md](build/README.md)): set `build.publish.owner` in `package.json` to your GitHub account, and supply Apple/Windows signing credentials as CI secrets (or env vars for local `npm run dist`). Add icons under `build/`.

## Development

```bash
npm install
npm run dev        # hot-reloading dev app
npm run typecheck
npm run build      # production bundles into out/
```

## Packaging

```bash
npm run dist       # current platform
npm run dist:mac   # dmg + zip
npm run dist:win   # nsis installer
npm run dist:linux # AppImage + deb
```

Installers land in `release/`. For distribution you'll want code signing (macOS notarization / Windows signing) configured via electron-builder's standard env vars.

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
    sessions.ts            JSON-per-session persistence
    auth/oauth.ts          PKCE loopback flow against auth.x.ai
    auth/store.ts          safeStorage-encrypted credentials + refresh
    agent/provider.ts      SSE streaming client for api.x.ai (chat completions)
    agent/tools.ts         tool implementations
    agent/profiles.ts      per-model tuning: prompts, budgets, sampling
    agent/loop.ts          the agent loop: model ↔ tools, permissions, compaction
  preload/index.ts         contextBridge (window.harness)
  renderer/                React UI: login, sidebar, chat, tool cards, settings
```
