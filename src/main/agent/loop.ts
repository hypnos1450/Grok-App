// The agent loop: model → tool calls → tool results → model, until the model
// stops calling tools. Emits AgentEvents for the renderer and persists via
// the session store.
//
// Cache discipline: messages are strictly append-only between compactions and
// the system prompt is stable per session, so xAI's prompt-prefix cache hits
// on every turn (cached input is ~6x cheaper and much faster).
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  AgentEvent,
  Attachments,
  ChatItem,
  PermissionMode,
  PermissionRequest,
  Settings
} from '@shared/types'
import { ApiMessage, ApiToolCall, ProviderError, UserContentPart, streamCompletion } from './provider'
import { COMPACTION_PROMPT, REVIEW_PROMPT, estimateTokens, profileFor } from './profiles'
import { MemoryTarget, memoryStore } from './memory'
import { skillStore } from './skills'
import { mcpManager } from './mcp'
import { gitSummary } from './git'
import { approvalCount, bumpApproval, recordFailure, recurringFailures } from './telemetry'
import { recordOriginal } from './checkpoints'
import { ApiToolDef } from './provider'
import { Tool, ToolContext, ToolResult, toolByName } from './tools'
import { SessionRecord, sessionStore } from '../sessions'
import { bashAllowKey, resolveInWorkspace, writeAllowKey } from '../security'
import { buildRepoMap } from '../repo-map'
import { appendAudit } from '../audit'

export type PermissionResponder = (request: PermissionRequest) => Promise<{
  allow: boolean
  alwaysAllow: boolean
  globalAllow?: boolean
}>

const KEEP_RECENT_MESSAGES = 8

function id(): string {
  return crypto.randomBytes(8).toString('hex')
}

export class AgentRun {
  private abort = new AbortController()
  /** id of this run's user message — doubles as the checkpoint id */
  private checkpointId = ''
  /** items index where this run started (for the background review digest) */
  private turnStartIndex = 0
  /** Steering messages queued by the user while the agent is running */
  private steerQueue: string[] = []
  /** Per-run tool set (static + MCP), resolved when the run starts */
  private runTools = new Map<string, Tool>()
  constructor(
    private session: SessionRecord,
    private settings: Settings,
    private emit: (ev: AgentEvent) => void,
    private askPermission: PermissionResponder,
    /** Persist settings after global-allowlist changes */
    private persistSettings: () => void = () => undefined
  ) {}

  cancel(): void {
    this.abort.abort()
  }

  get cancelled(): boolean {
    return this.abort.signal.aborted
  }

  /** Accept a steering message mid-run; it becomes a user turn next iteration. */
  queueMessage(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    this.steerQueue.push(t)
    this.emit({ type: 'queued', sessionId: this.session.meta.id, text: t })
    return true
  }

  private planOnly(): boolean {
    return this.session.meta.planOnly === true || this.settings.permissionMode === 'plan-only'
  }

  /** Static + MCP tools available this run, honoring settings toggles. */
  private resolveTools(): { defs: ApiToolDef[]; byName: Map<string, Tool> } {
    const byName = new Map<string, Tool>()
    const planOnly = this.planOnly()
    for (const t of toolByName.values()) {
      if (!this.settings.memoryEnabled && (t.name === 'memory' || t.name === 'skill')) continue
      if (!this.settings.enableSubagents && t.name === 'spawn_agent') continue
      if (planOnly && (t.kind === 'write' || t.kind === 'command')) continue
      if (planOnly && t.name === 'spawn_agent') continue
      byName.set(t.name, t)
    }
    if (!planOnly) {
      for (const t of mcpManager.tools()) byName.set(t.name, t)
    }
    return { defs: [...byName.values()].map((t) => t.def), byName }
  }

  async run(userText: string, attachments?: Attachments): Promise<void> {
    const sessionId = this.session.meta.id
    const profile = profileFor(this.session.meta.model)
    this.emit({ type: 'turn-start', sessionId })

    // Freeze the git branch into the session (system-prompt cache stability).
    if (this.session.gitSnapshot === undefined) {
      this.session.gitSnapshot = await gitSummary(this.session.meta.cwd)
    }
    if (this.settings.repoMapEnabled && this.session.repoMapSnapshot === undefined) {
      try {
        this.session.repoMapSnapshot = buildRepoMap(this.session.meta.cwd)
      } catch {
        this.session.repoMapSnapshot = ''
      }
    }
    const { defs: toolDefsForRun, byName } = this.resolveTools()
    this.runTools = byName
    this.session.lastTurnChanges = []

    const images = (attachments?.images ?? []).slice(0, 8)
    const files = (attachments?.files ?? []).slice(0, 5)
    const userItem: ChatItem = {
      kind: 'user',
      id: id(),
      ts: Date.now(),
      text: userText,
      images: images.length ? images : undefined,
      files: files.length ? files : undefined
    }
    this.checkpointId = userItem.id
    this.turnStartIndex = this.session.items.length
    this.pushItem(userItem)

    // Inline @-mentioned files into the message so the model has them
    // immediately, and attach pasted images as vision input parts.
    let messageText = userText
    for (const rel of files) {
      try {
        const abs = resolveInWorkspace(this.session.meta.cwd, rel)
        const raw = await fsp.readFile(abs, 'utf8')
        const capped = raw.length > 16_000 ? `${raw.slice(0, 16_000)}\n… (truncated)` : raw
        messageText += `\n\n[Attached file: ${rel}]\n\`\`\`\n${capped}\n\`\`\``
      } catch {
        messageText += `\n\n[Attached file ${rel} could not be read]`
      }
    }
    const content: string | UserContentPart[] = images.length
      ? [
          { type: 'input_text', text: messageText },
          ...images.map((u): UserContentPart => ({ type: 'input_image', image_url: u }))
        ]
      : messageText
    this.session.apiMessages.push({ role: 'user', content })

    if (this.session.items.filter((i) => i.kind === 'user').length === 1) {
      void this.generateTitle(userText)
    }

    let stopReason: 'done' | 'cancelled' | 'error' | 'max-turns' = 'done'
    try {
      for (let turn = 0; turn < profile.maxTurns; turn++) {
        if (this.cancelled) {
          stopReason = 'cancelled'
          break
        }
        this.drainSteerQueue()
        await this.maybeCompact()

        const assistantId = id()
        let streamedText = ''
        const result = await this.streamWithRetry({
          model: profile.apiModel,
          messages: this.buildMessages(),
          tools: toolDefsForRun,
          serverTools: this.settings.enableWebSearch,
          maxOutputTokens: profile.maxOutputTokens,
          temperature: profile.temperature,
          reasoningEffort: profile.supportsReasoningEffort
            ? this.session.meta.reasoningEffort
            : undefined,
          // Every turn in a session shares the same system-prompt prefix; pin
          // them to one cache server so that prefix bills at the cached rate.
          cacheKey: this.session.meta.id,
          signal: this.abort.signal,
          handlers: {
            onTextDelta: (text) => {
              streamedText += text
              this.emit({ type: 'text-delta', sessionId, itemId: assistantId, text })
            },
            onReasoningDelta: (text) =>
              this.emit({ type: 'reasoning-delta', sessionId, itemId: assistantId, text }),
            onServerTool: (use) => {
              // Server-side tools run on xAI's infrastructure; surface them
              // in the transcript so the user sees what the model looked up.
              this.pushItem({
                kind: 'tool',
                id: id(),
                ts: Date.now(),
                callId: id(),
                name: use.name,
                input: { query: use.detail },
                status: 'ok',
                output: 'Executed on xAI servers.'
              })
            }
          }
        })

        if (result.usage) {
          // Context fill = last prompt size (what actually occupies the window).
          // Session totals accumulate every call and routinely exceed the window.
          const contextTokens = result.usage.promptTokens
          this.session.lastPromptTokens = contextTokens
          this.session.meta.totalInputTokens =
            (this.session.meta.totalInputTokens ?? 0) + result.usage.promptTokens
          this.session.meta.totalOutputTokens =
            (this.session.meta.totalOutputTokens ?? 0) + result.usage.completionTokens
          this.session.meta.totalCachedTokens =
            (this.session.meta.totalCachedTokens ?? 0) + result.usage.cachedTokens
          this.emit({
            type: 'usage',
            sessionId,
            usage: {
              contextTokens,
              contextWindow: profile.contextWindow,
              contextUsed: Math.min(1, contextTokens / profile.contextWindow),
              sessionInputTokens: this.session.meta.totalInputTokens ?? 0,
              sessionOutputTokens: this.session.meta.totalOutputTokens ?? 0,
              sessionCachedTokens: this.session.meta.totalCachedTokens ?? 0
            }
          })
        }

        if (result.content || result.reasoning || result.toolCalls.length === 0) {
          const item: ChatItem = {
            kind: 'assistant',
            id: assistantId,
            ts: Date.now(),
            text: result.content || streamedText,
            reasoning: result.reasoning || undefined,
            citations: result.citations.length ? result.citations : undefined,
            // Prefer the model the API says it served — visible proof in the UI.
            model: result.servedModel ?? profile.apiModel
          }
          this.pushItem(item, true)
        }

        this.session.apiMessages.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
        })

        if (result.toolCalls.length === 0) {
          // The model is done — but if the user steered mid-turn, keep going
          // and let it address the queued message instead of ending.
          if (this.steerQueue.length > 0) continue
          stopReason = 'done'
          break
        }
        if (turn === profile.maxTurns - 1) stopReason = 'max-turns'

        await this.executeToolCalls(result.toolCalls)
      }
    } catch (err) {
      if (this.cancelled) {
        stopReason = 'cancelled'
      } else {
        stopReason = 'error'
        // Turn rate limits into a friendly, actionable banner.
        if (err instanceof ProviderError && err.status === 429) {
          this.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            message: err.retryAt
              ? 'You hit your Grok rate limit. It resets shortly — try again then.'
              : 'You hit your Grok rate limit. Give it a moment and retry.',
            retryAt: err.retryAt
          })
        }
        const message = err instanceof Error ? err.message : String(err)
        this.pushItem({ kind: 'error', id: id(), ts: Date.now(), message })
        // Keep apiMessages consistent: drop a trailing assistant tool-call
        // request whose results will never arrive.
        const last = this.session.apiMessages[this.session.apiMessages.length - 1]
        if (last?.role === 'assistant' && 'tool_calls' in last && last.tool_calls?.length) {
          this.session.apiMessages.pop()
        }
      }
    } finally {
      if (stopReason === 'cancelled') this.reconcileCancelledToolCalls()
      await sessionStore.save(this.session)
      this.emit({ type: 'turn-end', sessionId, stopReason })
      if (stopReason === 'done' && this.settings.memoryEnabled) {
        // Fire-and-forget: distill durable lessons from this turn into memory.
        void this.backgroundReview().catch(() => undefined)
      }
    }
  }

  /**
   * One automatic retry on transient provider failures (5xx, network drops,
   * short rate limits) so a single blip doesn't kill a long agentic turn.
   */
  private async streamWithRetry(
    opts: Parameters<typeof streamCompletion>[0]
  ): Promise<Awaited<ReturnType<typeof streamCompletion>>> {
    try {
      return await streamCompletion(opts)
    } catch (err) {
      const retryable =
        err instanceof ProviderError &&
        err.retryable &&
        !this.cancelled &&
        !this.abort.signal.aborted
      if (!retryable) throw err
      // Wait out a known rate-limit reset (up to 20s), otherwise a short pause.
      const waitMs = err.retryAt
        ? Math.min(Math.max(err.retryAt - Date.now(), 1000), 20_000)
        : 3000
      this.emit({
        type: 'notice',
        sessionId: this.session.meta.id,
        level: 'info',
        message: `Transient API error — retrying in ${Math.round(waitMs / 1000)}s…`
      })
      await new Promise((res) => setTimeout(res, waitMs))
      if (this.cancelled || this.abort.signal.aborted) throw err
      return await streamCompletion(opts)
    }
  }

  // ---------------------------------------------------- background review

  private async backgroundReview(): Promise<void> {
    const turnItems = this.session.items.slice(this.turnStartIndex)
    const digestParts: string[] = []
    for (const item of turnItems) {
      if (item.kind === 'user') digestParts.push(`USER: ${item.text.slice(0, 2500)}`)
      else if (item.kind === 'assistant' && item.text)
        digestParts.push(`ASSISTANT: ${item.text.slice(0, 2500)}`)
      else if (item.kind === 'tool')
        digestParts.push(`TOOL ${item.name} (${item.status}): ${JSON.stringify(item.input).slice(0, 200)}`)
    }
    const digest = digestParts.join('\n').slice(0, 14_000)
    if (!digest) return

    const cwd = this.session.meta.cwd
    const memoryState = memoryStore.snapshot(cwd) || '(all memory stores are currently empty)'
    const skillsIndex = skillStore.index() || '(no skills saved yet)'
    const failures = recurringFailures()
    // Multi-model routing: prefer a lighter profile for background distillation.
    const reviewProfile = this.settings.multiModelRouting
      ? profileFor('grok-4.3')
      : profileFor(this.session.meta.model)
    const result = await streamCompletion({
      model: reviewProfile.apiModel,
      // Distillation doesn't need deep reasoning — keep background calls cheap.
      reasoningEffort: reviewProfile.supportsReasoningEffort ? 'low' : undefined,
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        {
          role: 'user',
          content:
            `Current memory stores:\n${memoryState}\n\n${skillsIndex}\n\n` +
            (failures ? `Recurring failures (last 14 days):\n${failures}\n\n` : '') +
            `Latest exchange:\n${digest}`
        }
      ],
      maxOutputTokens: 1400,
      temperature: 0
    })

    const review = parseReview(result.content)

    // Session digest: always refresh — it powers session_search recall.
    if (review.digest) {
      this.session.digest = review.digest.slice(0, 1200)
      this.session.meta.digest = this.session.digest
    }

    let applied = 0
    let staged = 0
    const summaries: string[] = []
    for (const op of review.memory.slice(0, 3)) {
      if (this.settings.memoryWriteApproval) {
        memoryStore.stage({ ...op, cwd: op.target === 'project' ? cwd : undefined, source: 'auto' })
        staged++
      } else if (memoryStore.apply({ ...op, cwd }).success) {
        applied++
        summaries.push(
          `${op.action === 'remove' ? '−' : op.action === 'replace' ? '±' : '+'} ${(op.content ?? op.old_text ?? '').slice(0, 70)}`
        )
      }
    }
    for (const op of review.skills.slice(0, 2)) {
      if (this.settings.memoryWriteApproval) {
        skillStore.stage({ ...op, source: 'auto' })
        staged++
      } else if (skillStore.save(op).success) {
        applied++
        summaries.push(`📘 skill ${op.name} ${op.action}d`)
      }
    }

    if (applied + staged === 0) {
      if (review.digest) await sessionStore.save(this.session)
      return
    }
    const text = staged
      ? `💾 ${staged} learning update${staged === 1 ? '' : 's'} staged for review (Settings → Memory)`
      : `💾 ${summaries.join(' · ')}`
    this.pushItem({ kind: 'note', id: id(), ts: Date.now(), text })
    await sessionStore.save(this.session)
  }

  // ------------------------------------------------------------ tool calls

  private async executeToolCalls(calls: ApiToolCall[]): Promise<void> {
    const parsed = calls.map((call) => {
      let input: Record<string, unknown> = {}
      let parseError: string | null = null
      try {
        input = JSON.parse(call.function.arguments || '{}')
      } catch {
        parseError = 'Tool arguments were not valid JSON. Emit a single JSON object.'
      }
      return { call, input, parseError, tool: this.runTools.get(call.function.name) }
    })

    // Read-only tools run concurrently; mutating tools and commands run
    // sequentially, in order, each gated by permissions.
    const readers = parsed.filter((p) => p.tool?.kind === 'read' && !p.parseError)
    const rest = parsed.filter((p) => !(p.tool?.kind === 'read' && !p.parseError))

    const results = new Map<string, ToolResult>()
    await Promise.all(
      readers.map(async (p) => {
        results.set(p.call.id, await this.runSingleTool(p.tool!, p.call, p.input))
      })
    )
    for (const p of rest) {
      if (p.parseError || !p.tool) {
        const output = p.parseError ?? `Unknown tool: ${p.call.function.name}`
        this.pushItem({
          kind: 'tool', id: id(), ts: Date.now(), callId: p.call.id,
          name: p.call.function.name, input: p.input, status: 'error', output
        })
        results.set(p.call.id, { ok: false, output })
        continue
      }
      results.set(p.call.id, await this.runSingleTool(p.tool, p.call, p.input))
    }

    // Results must be appended in the same order as the calls.
    for (const call of calls) {
      const r = results.get(call.id) ?? { ok: false, output: 'Tool did not run.' }
      this.session.apiMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: r.output
      })
    }
    await sessionStore.save(this.session)
  }

  private async runSingleTool(
    tool: Tool,
    call: ApiToolCall,
    input: Record<string, unknown>
  ): Promise<ToolResult> {
    const sessionId = this.session.meta.id
    const toolCtx: ToolContext = {
      cwd: this.session.meta.cwd,
      sessionId,
      signal: this.abort.signal,
      onBeforeMutate: (absPath) => recordOriginal(this.session, this.checkpointId, absPath),
      onPlan: (steps) => {
        this.session.plan = steps
        this.emit({ type: 'plan', sessionId, steps })
      }
    }

    let preview: string | undefined
    try {
      preview = await tool.preview?.(input, toolCtx)
    } catch {
      // Preview is best-effort; the tool itself reports real errors.
    }

    const item: ChatItem = {
      kind: 'tool',
      id: id(),
      ts: Date.now(),
      callId: call.id,
      name: tool.name,
      input,
      preview,
      status: 'running'
    }

    if (this.cancelled) {
      item.status = 'denied'
      item.output = 'Cancelled by user.'
      this.pushItem(item)
      return { ok: false, output: 'The user cancelled this action.' }
    }

    const decision = await this.checkPermission(tool, input, preview)
    if (!decision) {
      item.status = 'denied'
      item.output = 'Denied by user.'
      this.pushItem(item)
      return {
        ok: false,
        output:
          'The user declined this action. Do not retry it verbatim — ask what they would prefer or take a different approach.'
      }
    }

    this.pushItem(item)
    const started = Date.now()
    let result: ToolResult
    try {
      result = await tool.run(input, toolCtx)
    } catch (err) {
      result = { ok: false, output: err instanceof Error ? err.message : String(err) }
    }
    if (!result.ok) recordFailure('error', tool.name, result.output)
    // Track file mutations for the turn review panel.
    if (result.ok && (tool.name === 'write_file' || tool.name === 'edit_file')) {
      const p = String(input.path ?? '')
      if (p) {
        this.session.lastTurnChanges = this.session.lastTurnChanges ?? []
        this.session.lastTurnChanges.push({
          path: p,
          kind: tool.name === 'write_file' ? 'write' : 'edit'
        })
      }
    }
    // Test-after-edit: append a verification hint so the model runs checks.
    if (
      result.ok &&
      tool.kind === 'write' &&
      this.settings.testAfterEdit &&
      !this.planOnly()
    ) {
      const hint = this.settings.testCommand?.trim()
        ? `Next: run \`${this.settings.testCommand.trim()}\` to verify.`
        : 'Next: run the project typecheck/tests (or a targeted check) to verify this change.'
      result = { ...result, output: `${result.output}\n\n[verify] ${hint}` }
    }
    if (this.settings.auditLogEnabled && (tool.kind === 'write' || tool.kind === 'command')) {
      appendAudit('tool', `${tool.name}: ${tool.summarize(input)}`, {
        sessionId,
        detail: result.ok ? 'ok' : result.output.slice(0, 200)
      })
    }
    const updated: ChatItem = {
      ...item,
      status: result.ok ? 'ok' : 'error',
      output: result.output,
      durationMs: Date.now() - started
    }
    this.replaceItem(updated)
    this.emit({ type: 'item-update', sessionId, item: updated })
    return result
  }

  private async checkPermission(
    tool: Tool,
    input: Record<string, unknown>,
    preview?: string
  ): Promise<boolean> {
    const mode: PermissionMode = this.planOnly() ? 'plan-only' : this.settings.permissionMode
    if (tool.kind === 'read') return true
    if (mode === 'plan-only' && (tool.kind === 'write' || tool.kind === 'command')) {
      recordFailure('denied', tool.name, 'plan-only mode')
      return false
    }
    if (tool.kind === 'memory') {
      // Memory/skill writes are gated only by the dedicated approval setting —
      // they never touch the user's files, so the permission mode doesn't
      // apply. Read-style calls (e.g. skill read) never prompt.
      if (!this.settings.memoryWriteApproval) return true
      if (!(tool.requiresApproval?.(input) ?? true)) return true
    } else {
      if (mode === 'full-auto') return true
      if (mode === 'auto-edit' && tool.kind === 'write') return true
    }

    // Path-scoped write keys; bash keys only for simple (non-compound) commands.
    let allowKey: string | null = tool.name
    if (tool.name === 'bash') {
      allowKey = bashAllowKey(String(input.command ?? ''))
    } else if (tool.kind === 'write' && typeof input.path === 'string') {
      try {
        const abs = resolveInWorkspace(this.session.meta.cwd, input.path)
        allowKey = writeAllowKey(tool.name, abs, this.session.meta.cwd)
      } catch {
        allowKey = null // outside workspace — always re-prompt (and tool will fail)
      }
    }
    // MCP tools keep full namespaced name as the allow key.
    if (allowKey && this.session.allowlist.includes(allowKey)) return true
    if (allowKey && this.settings.globalAllowlist.includes(allowKey)) return true

    const request: PermissionRequest = {
      requestId: id(),
      sessionId: this.session.meta.id,
      toolName: tool.name,
      summary: tool.summarize(input),
      input,
      preview,
      priorApprovals: allowKey ? approvalCount(allowKey) : 0
    }
    const { allow, alwaysAllow, globalAllow } = await this.askPermission(request)
    if (this.settings.auditLogEnabled) {
      appendAudit('permission', `${allow ? 'allow' : 'deny'} ${tool.name}: ${tool.summarize(input)}`, {
        sessionId: this.session.meta.id,
        detail: allowKey ?? undefined
      })
    }
    if (allow) {
      if (allowKey) {
        bumpApproval(allowKey)
        if (globalAllow && !this.settings.globalAllowlist.includes(allowKey)) {
          this.settings.globalAllowlist.push(allowKey)
          this.persistSettings()
        } else if (alwaysAllow && !this.session.allowlist.includes(allowKey)) {
          this.session.allowlist.push(allowKey)
        }
      }
    } else {
      recordFailure('denied', tool.name, tool.summarize(input))
    }
    return allow
  }

  // ------------------------------------------------------------ compaction

  private buildMessages(): ApiMessage[] {
    const profile = profileFor(this.session.meta.model)
    // Freeze memory/skills/project-doc snapshots the first time this session
    // hits the model, so the system prompt (and the prompt-cache prefix)
    // stays stable even as the agent learns mid-session.
    if (this.settings.memoryEnabled && this.session.memorySnapshot === undefined) {
      this.session.memorySnapshot = memoryStore.snapshot(this.session.meta.cwd)
    }
    if (this.settings.memoryEnabled && this.session.skillsSnapshot === undefined) {
      this.session.skillsSnapshot = skillStore.index()
    }
    if (this.session.projectDocSnapshot === undefined) {
      this.session.projectDocSnapshot = readProjectDoc(this.session.meta.cwd)
    }
    if (this.settings.repoMapEnabled && this.session.repoMapSnapshot === undefined) {
      try {
        this.session.repoMapSnapshot = buildRepoMap(this.session.meta.cwd)
      } catch {
        this.session.repoMapSnapshot = ''
      }
    }
    const system: ApiMessage = {
      role: 'system',
      content: profile.systemPrompt({
        cwd: this.session.meta.cwd,
        customInstructions: this.settings.customInstructions,
        memoryEnabled: this.settings.memoryEnabled,
        memorySnapshot: this.session.memorySnapshot,
        skillsIndex: this.session.skillsSnapshot,
        projectDoc: this.session.projectDocSnapshot,
        gitBranch: this.session.gitSnapshot,
        repoMap: this.settings.repoMapEnabled ? this.session.repoMapSnapshot : undefined,
        planOnly: this.planOnly(),
        testCommand: this.settings.testCommand
      })
    }
    return [system, ...this.session.apiMessages]
  }

  /** Fold any queued steering messages into a single user turn. */
  private drainSteerQueue(): void {
    if (this.steerQueue.length === 0) return
    const text = this.steerQueue.join('\n\n')
    this.steerQueue = []
    const item: ChatItem = { kind: 'user', id: id(), ts: Date.now(), text }
    this.pushItem(item)
    this.session.apiMessages.push({
      role: 'user',
      content: `[Steering message added mid-task — adjust course accordingly]\n${text}`
    })
  }

  private estimateContext(): number {
    return this.buildMessages().reduce(
      (sum, m) => sum + estimateTokens(JSON.stringify(m)) + 4,
      0
    )
  }

  private async maybeCompact(): Promise<void> {
    const profile = profileFor(this.session.meta.model)
    const budget = profile.contextWindow * profile.compactAt
    const estimate = Math.max(this.estimateContext(), this.session.lastPromptTokens ?? 0)
    if (estimate < budget || this.session.apiMessages.length <= KEEP_RECENT_MESSAGES + 2) return

    // Keep the most recent messages verbatim, but never split an assistant
    // tool-call from its tool results.
    let cut = this.session.apiMessages.length - KEEP_RECENT_MESSAGES
    while (cut > 0 && this.session.apiMessages[cut]?.role === 'tool') cut--
    if (cut <= 0) return
    const toSummarize = this.session.apiMessages.slice(0, cut)
    const kept = this.session.apiMessages.slice(cut)

    const compactProfile = this.settings.multiModelRouting ? profileFor('grok-4.3') : profile
    const summaryResult = await streamCompletion({
      model: compactProfile.apiModel,
      messages: [
        { role: 'system', content: COMPACTION_PROMPT },
        {
          role: 'user',
          content: `Conversation to summarize:\n\n${JSON.stringify(toSummarize).slice(0, 600_000)}`
        }
      ],
      maxOutputTokens: 4000,
      temperature: 0,
      // Summarizing doesn't need deep reasoning, and grok-4.5 defaults to high
      // effort — without this the compaction pass reasons hard over the whole
      // transcript it is trying to cheaply distill.
      reasoningEffort: compactProfile.supportsReasoningEffort ? 'low' : undefined,
      signal: this.abort.signal
    })

    const summary = summaryResult.content.trim() || '(summary unavailable)'
    this.session.apiMessages = [
      {
        role: 'user',
        content:
          `[Context was compacted. Summary of the session so far:]\n\n${summary}\n\n` +
          `[The full transcript of these earlier turns is still saved. If you need a detail this ` +
          `summary left out — an exact error, a path, a command's output, why something was decided — ` +
          `search it with recall_history(query) rather than asking the user to repeat it.]`
      },
      ...kept
    ]
    this.session.lastPromptTokens = 0
    this.pushItem({ kind: 'compaction', id: id(), ts: Date.now(), summary })
    await sessionStore.save(this.session)
  }

  // ------------------------------------------------------------ misc

  private reconcileCancelledToolCalls(): void {
    // If we stopped between an assistant tool-call message and its results,
    // append synthetic results so the transcript stays API-valid.
    const msgs = this.session.apiMessages
    const last = msgs[msgs.length - 1]
    if (last?.role === 'assistant' && 'tool_calls' in last && last.tool_calls?.length) {
      for (const tc of last.tool_calls) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'Cancelled by user before running.' })
      }
    }
  }

  private async generateTitle(userText: string): Promise<void> {
    try {
      const titleProfile = this.settings.multiModelRouting
        ? profileFor('grok-4.3')
        : profileFor(this.session.meta.model)
      const result = await streamCompletion({
        model: titleProfile.apiModel,
        reasoningEffort: titleProfile.supportsReasoningEffort ? 'low' : undefined,
        messages: [
          {
            role: 'system',
            content:
              'Generate a 3-6 word title for a coding session that starts with the following request. Reply with the title only — no quotes, no punctuation at the end.'
          },
          { role: 'user', content: userText.slice(0, 2000) }
        ],
        maxOutputTokens: 24,
        temperature: 0.3
      })
      const title = result.content.trim().replace(/^["']|["']$/g, '').slice(0, 60)
      if (title) {
        this.session.meta.title = title
        await sessionStore.save(this.session)
        this.emit({ type: 'title', sessionId: this.session.meta.id, title })
      }
    } catch {
      // Title generation is best-effort.
    }
  }

  private pushItem(item: ChatItem, replaceStreamed = false): void {
    this.session.items.push(item)
    this.session.meta.updatedAt = Date.now()
    this.session.meta.messageCount = this.session.items.length
    this.emit({
      type: replaceStreamed ? 'item-update' : 'item',
      sessionId: this.session.meta.id,
      item
    })
  }

  private replaceItem(item: ChatItem): void {
    const idx = this.session.items.findIndex((i) => i.id === item.id)
    if (idx >= 0) this.session.items[idx] = item
  }
}

interface ReviewMemoryOp {
  action: 'add' | 'replace' | 'remove'
  target: MemoryTarget
  content?: string
  old_text?: string
}

interface ReviewSkillOp {
  action: 'create' | 'update' | 'delete'
  name: string
  description?: string
  content?: string
}

interface ReviewResult {
  memory: ReviewMemoryOp[]
  skills: ReviewSkillOp[]
  digest: string
}

/** Parse the review model's JSON output defensively (fences, prose, junk). */
function parseReview(raw: string): ReviewResult {
  const empty: ReviewResult = { memory: [], skills: [], digest: '' }
  const text = raw.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return empty
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return empty
  }

  const memory: ReviewMemoryOp[] = []
  if (Array.isArray(parsed.memory)) {
    for (const raw of parsed.memory) {
      if (!raw || typeof raw !== 'object') continue
      const op = raw as Record<string, unknown>
      const action = String(op.action ?? '')
      const target = String(op.target ?? '')
      if (!['add', 'replace', 'remove'].includes(action)) continue
      if (target !== 'memory' && target !== 'user' && target !== 'project') continue
      memory.push({
        action: action as ReviewMemoryOp['action'],
        target,
        content: typeof op.content === 'string' ? op.content : undefined,
        old_text: typeof op.old_text === 'string' ? op.old_text : undefined
      })
    }
  }

  const skills: ReviewSkillOp[] = []
  if (Array.isArray(parsed.skills)) {
    for (const raw of parsed.skills) {
      if (!raw || typeof raw !== 'object') continue
      const op = raw as Record<string, unknown>
      const action = String(op.action ?? '')
      const name = String(op.name ?? '')
      if (!['create', 'update', 'delete'].includes(action) || !name) continue
      skills.push({
        action: action as ReviewSkillOp['action'],
        name,
        description: typeof op.description === 'string' ? op.description : undefined,
        content: typeof op.content === 'string' ? op.content : undefined
      })
    }
  }

  return {
    memory,
    skills,
    digest: typeof parsed.digest === 'string' ? parsed.digest.trim() : ''
  }
}

/** Read the repo's agent-instruction doc, if any (AGENTS.md convention). */
function readProjectDoc(cwd: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GROK.md']) {
    try {
      const raw = fsSync.readFileSync(path.join(cwd, name), 'utf8').trim()
      if (raw) return raw.length > 6000 ? `${raw.slice(0, 6000)}\n… (truncated)` : raw
    } catch {
      // try next
    }
  }
  return ''
}
