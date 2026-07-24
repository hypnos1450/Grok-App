# Conduit

Cross-platform Electron desktop agent for xAI **Grok 4.5** (menu: “Grok 4.5”, wire `grok-4.5`, internal id `grok-build-0.1`) and **Grok 4.3**. SuperGrok / X Premium+ OAuth (or API-key fallback); permissioned tool loop on the user’s machine. Talks to xAI **Responses API** (`/v1/responses`). Version in `package.json` (currently 0.5.x). Repo: `hypnos1450/Conduit`.

## Layout

```
src/
  shared/types.ts       IPC + domain types (ModelId, Settings, ChatItem, HarnessApi, SCHEMA_VERSION)
  main/
    index.ts            Window lifecycle, sandbox, vibrancy
    ipc.ts              All ipcMain handlers
    sessions.ts         JSON-per-session under userData; schema migration ladder
    panels.ts           Right-dock files + terminal (node-pty / xterm)
    commands.ts         Slash commands (/init → GROK.md); custom *.md in userData/commands
    auth/oauth.ts       PKCE loopback on 127.0.0.1:56121 → auth.x.ai
    auth/store.ts       safeStorage-encrypted tokens
    agent/
      loop.ts           Agent loop: tools, permissions, compaction, self-review
      provider.ts       SSE client for api.x.ai; prompt-cache-friendly messages
      tools.ts          bash, read_file, apply_patch, write_file, list_dir, glob, grep, diagnostics, lsp, lsp_edit, docs, monitor, fetch_page, update_plan, ask_user, memory, skill, session_search, recall_history, spawn_agent
      apply-patch.ts    Codex-format patch parser + applier
      lsp/              language-server client: rpc.ts, servers.ts, client.ts, manager.ts, edit.ts (WorkspaceEdit applier)
      docs.ts           devdocs.io documentation client (disk-cached, offline-tolerant)
      env.ts            credential scrub shared by bash + LSP spawns
      profiles.ts       Per-model prompts, budgets, apiModel mapping, custom-agent persona blocks
      memory.ts / skills.ts / skill-install.ts / subagent.ts / mcp.ts / mcp-install.ts
      checkpoints.ts, diff.ts, git.ts, telemetry.ts
  preload/index.ts      contextBridge → window.harness
  renderer/src/         React 19 UI (App, Chat, Home, Sidebar, RightDock, SettingsModal, TerminalPanel)
test/                   Vitest unit tests (security, memory, profiles, apply-patch, lsp, docs, env)
build/                  Icons, mac entitlements, notarize.cjs
scripts/                patch-node-pty-spectre.js (postinstall)
.github/workflows/      ci.yml (typecheck+build), release.yml (tag → multi-OS publish)
```

Runtime data lives in Electron `userData` (sessions, settings, memories, skills, logs) — not in the repo.

## Commands

```bash
npm install              # postinstall: spectre patch + electron-builder install-app-deps
npm run dev              # electron-vite hot reload
npm run typecheck        # tsc --noEmit on tsconfig.node.json + tsconfig.web.json
npm run build            # production → out/
npm run lint             # eslint (flat config; react-hooks + strict rules)
npm test                 # vitest run (unit tests under test/)
npm start                # electron-vite preview
npm run dist             # build + electron-builder → release/
npm run dist:mac|win|linux
npm run rebuild:pty      # if node-pty native module breaks
```

**Release:** bump `version` in `package.json`, update `CHANGELOG.md` section `## X.Y.Z`, commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`. CI builds mac/win/linux, attaches CHANGELOG notes, publishes GitHub Release (auto-updater). Signing secrets optional (see `build/README.md`).

**Vitest + ESLint** (flat config) are in place; no Prettier. CI = `npm ci` → lint → typecheck → test → build (Node 22). Release matrix needs Python setuptools (node-gyp distutils) and Windows MSVC (`ilammy/msvc-dev-cmd`) so `node-pty` postinstall rebuild succeeds.

## Conventions

- **TypeScript strict**, ES2022, React JSX. Path aliases: `@shared/*` → `src/shared/*`, `@/*` → `src/renderer/src/*` (renderer only).
- **Shared contract:** all cross-process shapes live in `src/shared/types.ts`. Preload implements `HarnessApi`; main handlers must stay in sync.
- **Style:** single quotes, semicolons, 2-space indent, explicit return types on exported functions. Prefer `node:` imports (`node:fs`, `node:path`). File-top comments explain module purpose.
- **Models:** UI/session id `grok-build-0.1` maps to API `grok-4.5` in `profiles.ts` — do not rename the internal id (breaks saved sessions). `grok-4.3` is 1:1.
- **Agent tools:** `apply_patch` (Codex format) is the primary editor; `write_file` for new files/full rewrites (`edit_file` was removed). `lsp` (read) for per-file diagnostics/navigation; `lsp_edit` (write) applies a server-computed `rename` (symbol across files) or `fix` (quick-fix) via `lsp/edit.ts`, jailed + checkpoint-tracked; `diagnostics` for project-wide checks; `docs` for versioned reference lookups. Read-only tools parallelize; mutations/commands are permission-gated. Tools whose changed files aren't derivable from their input report them via `ctx.onFileWritten` for the Review panel.
- **Custom agents:** `Settings.customAgents` (validated in `security.ts`); a session's `agentId` selects one → its instructions + scoped-skills index inject into the prompt (`profiles.assemble`), and its `model` + `permissionMode` override the session (`loop.effectiveMode`). `spawn_agent` can delegate to one by name.
- **Prompt-cache discipline:** stable system-prompt prefix (`HARNESS_CORE` first in both profiles); append-only `apiMessages` until compaction. Memory/skills/projectDoc/git snapshots freeze at first turn of a session.
- **Sessions:** schema-versioned (`SCHEMA_VERSION`); add migrations in `sessions.ts` `migrate()` as `if (v < N)`.
- **Project doc load order:** `AGENTS.md` → `CLAUDE.md` → `GROK.md` (first non-empty wins); truncated at 6k chars; frozen per session.
- Keep changes minimal; match neighboring code. No drive-by refactors.

## Gotchas

1. **OAuth 403:** xAI may reject some subscription accounts on the OAuth API surface; use API-key login. Tokens only ever go to `https://api.x.ai` (enforced in provider).
2. **node-pty:** Windows Spectre flags break the build — `scripts/patch-node-pty-spectre.js` runs on postinstall. `asarUnpack` includes `node-pty`. Rebuild with `npm run rebuild:pty` if the terminal dies after Electron upgrades.
3. **Two tsconfigs:** main/preload/shared → `tsconfig.node.json`; renderer → `tsconfig.web.json`. Typecheck both.
4. **Verify** with `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` (or `dev` for UI). Tests mock `electron` (see `test/setup.ts`); pure main-process logic is unit-tested.
5. **electron-builder publish** owner/repo is hard-coded in `package.json` → `build.publish`. Empty `CSC_LINK` breaks signing; release workflow only exports it when the secret is set.
6. **Unsigned macOS:** first open needs right-click → Open. Notarization via `build/notarize.cjs` only when Apple env vars are present.
7. **Destructive bash guardrail** in `tools.ts` is a backstop, not the security boundary — permissions are.
8. **MCP tools** are namespaced `mcp__<server>__<tool>` and use the same permission path as built-ins.
9. **Background self-review** and title generation use low reasoning effort so quota stays on the main turn.
10. Prefer `fetch_page` / server web_search over `bash curl` for HTTP; local/private addresses are blocked in fetch_page.
