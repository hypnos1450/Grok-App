// Streaming client for the xAI Responses API (/v1/responses).
// Works with both OAuth bearer tokens (subscription) and API keys, and
// supports xAI's server-side tools (web_search, x_search) alongside our
// client-side function tools.
import { authManager } from '../auth/store'
import { XAI_API_BASE_URL } from '../auth/oauth'
import { logger } from '../logger'

const log = logger('provider')

export interface ApiToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// Internal conversation format (stable across sessions on disk). Converted
// to Responses API input items at request time.
export type UserContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

export type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ApiToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ServerToolUse {
  /** e.g. web_search, x_search */
  name: string
  /** Best-effort human-readable detail (query, url) */
  detail: string
}

export interface StreamHandlers {
  onTextDelta?(text: string): void
  onReasoningDelta?(text: string): void
  onServerTool?(use: ServerToolUse): void
}

export interface CompletionResult {
  content: string
  reasoning: string
  toolCalls: ApiToolCall[]
  citations: string[]
  finishReason: string
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number } | null
  /** Model name the API reports it actually served (echoed in the response) */
  servedModel?: string
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable = false,
    /** epoch ms when a rate limit resets (from Retry-After), if provided */
    public retryAt?: number
  ) {
    super(message)
  }
}

const MAX_ATTEMPTS = 4

/**
 * Cheap post-login check that the current credential can actually reach the
 * API. Catches xAI's known OAuth-allowlist 403, which otherwise only surfaces
 * as a cryptic failure on the user's first real message.
 *
 * Probes /models, not /api-key: the latter authenticates xAI API keys only and
 * answers a valid subscription OAuth bearer with 401, which read as an expired
 * session and produced a permanent false "sign in again" banner.
 */
export async function probeAccess(): Promise<{ ok: boolean; status?: number; message?: string }> {
  try {
    const bearer = await authManager.getBearer()
    const res = await fetch(`${XAI_API_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${bearer}` }
    })
    if (res.ok || res.status === 404) return { ok: true }
    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        message:
          "xAI accepted your sign-in but this account isn't allowlisted for API access via subscription OAuth. This is an xAI-side restriction. You can use an xAI API key instead (Settings → sign out → Use API key)."
      }
    }
    if (res.status === 401) {
      return { ok: false, status: 401, message: 'Your session is not valid. Please sign in again.' }
    }
    return { ok: true } // Don't block on unexpected statuses; the real call will report.
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export async function streamCompletion(opts: {
  model: string
  messages: ApiMessage[]
  tools?: ApiToolDef[]
  /** Enable xAI's server-side web_search / x_search tools */
  serverTools?: boolean
  maxOutputTokens?: number
  temperature?: number
  /** Responses API reasoning depth (grok-4.5+); omit for the API default */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Pins the conversation to one cache server so the prompt prefix hits warm */
  cacheKey?: string
  /** Constrain the reply to a JSON Schema (Responses API structured outputs) */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  signal?: AbortSignal
  handlers?: StreamHandlers
}): Promise<CompletionResult> {
  let attempt = 0
  let refreshed = false
  for (;;) {
    attempt += 1
    try {
      return await streamOnce(opts)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      if (err instanceof ProviderError && err.status === 401 && authManager.usingOAuth() && !refreshed) {
        refreshed = true
        await authManager.forceRefresh()
        continue
      }
      const retryable =
        err instanceof ProviderError ? err.retryable : err instanceof TypeError // network errors
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delay = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)
        await new Promise((res) => setTimeout(res, delay))
        continue
      }
      throw err
    }
  }
}

// ------------------------------------------------------- request building

type InputItem = Record<string, unknown>

/** Convert our chat-format history into Responses API input items. */
function toInputItems(messages: ApiMessage[]): InputItem[] {
  const items: InputItem[] = []
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        items.push({ role: 'system', content: m.content })
        break
      case 'user':
        items.push({ role: 'user', content: m.content })
        break
      case 'assistant':
        if (m.content) items.push({ role: 'assistant', content: m.content })
        for (const tc of m.tool_calls ?? []) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments
          })
        }
        break
      case 'tool':
        items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
        break
    }
  }
  return items
}

/** Responses API uses flat function tool defs. */
function toResponsesTools(tools: ApiToolDef[] | undefined, serverTools: boolean): InputItem[] {
  const out: InputItem[] = []
  for (const t of tools ?? []) {
    out.push({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters
    })
  }
  if (serverTools) {
    out.push({ type: 'web_search' }, { type: 'x_search' })
  }
  return out
}

// -------------------------------------------------------------- streaming

async function streamOnce(opts: {
  model: string
  messages: ApiMessage[]
  tools?: ApiToolDef[]
  serverTools?: boolean
  maxOutputTokens?: number
  temperature?: number
  /** Responses API reasoning depth (grok-4.5+); omit for the API default */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /**
   * Routes a conversation's requests to the same cache server. Without it the
   * shared prompt prefix often lands cache-cold and bills at full input price
   * (grok-4.5: $2.00/M vs $0.50/M cached). Stable per conversation.
   */
  cacheKey?: string
  /** Constrain the reply to a JSON Schema (Responses API structured outputs) */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  signal?: AbortSignal
  handlers?: StreamHandlers
}): Promise<CompletionResult> {
  const bearer = await authManager.getBearer()
  const url = new URL(`${XAI_API_BASE_URL}/responses`)
  if (url.protocol !== 'https:' || url.hostname !== 'api.x.ai') {
    throw new ProviderError(`Refusing to send credentials to ${url.origin}`)
  }

  const tools = toResponsesTools(opts.tools, opts.serverTools ?? false)
  const body: Record<string, unknown> = {
    model: opts.model,
    input: toInputItems(opts.messages),
    stream: true
  }
  if (tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
  }
  if (opts.maxOutputTokens) body.max_output_tokens = opts.maxOutputTokens
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort }
  if (opts.cacheKey) body.prompt_cache_key = opts.cacheKey
  if (opts.jsonSchema) {
    body.text = {
      format: {
        type: 'json_schema',
        name: opts.jsonSchema.name,
        schema: opts.jsonSchema.schema,
        strict: true
      }
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'x-grok-source': 'conduit'
    },
    body: JSON.stringify(body),
    signal: opts.signal
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const retryable = res.status === 429 || res.status >= 500
    // Honor Retry-After (seconds or HTTP-date) on rate limits.
    let retryAt: number | undefined
    const ra = res.headers.get('retry-after')
    if (ra) {
      const secs = Number(ra)
      retryAt = Number.isFinite(secs) ? Date.now() + secs * 1000 : Date.parse(ra) || undefined
    }
    throw new ProviderError(
      `xAI API error (HTTP ${res.status})${text ? `: ${truncate(text, 600)}` : ''}`,
      res.status,
      retryable,
      retryAt
    )
  }
  if (!res.body) throw new ProviderError('xAI API returned an empty stream')

  const state = {
    content: '',
    reasoning: '',
    toolCalls: [] as ApiToolCall[],
    citations: [] as string[],
    finishReason: 'stop',
    usage: null as CompletionResult['usage'],
    announcedServerCalls: new Set<string>(),
    servedModel: undefined as string | undefined
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let ev: Record<string, any>
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      handleEvent(ev, state, opts.handlers)
    }
  }

  if (state.servedModel && state.servedModel !== opts.model) {
    log.warn(`requested model ${opts.model} but API served ${state.servedModel}`)
  } else if (state.servedModel) {
    log.info(`model: ${state.servedModel}`)
  }

  return {
    content: state.content,
    reasoning: state.reasoning,
    toolCalls: state.toolCalls,
    citations: state.citations,
    finishReason: state.finishReason,
    usage: state.usage,
    servedModel: state.servedModel
  }
}

type StreamState = {
  content: string
  reasoning: string
  toolCalls: ApiToolCall[]
  citations: string[]
  finishReason: string
  usage: CompletionResult['usage']
  announcedServerCalls: Set<string>
  servedModel: string | undefined
}

const SERVER_TOOL_ITEM_TYPES = new Set([
  'web_search_call',
  'x_search_call',
  'code_interpreter_call',
  'code_execution_call'
])

function handleEvent(
  ev: Record<string, any>,
  state: StreamState,
  handlers?: StreamHandlers
): void {
  const type: string = ev.type ?? ''

  // The API echoes the model it is actually serving on lifecycle events.
  if (!state.servedModel && typeof ev.response?.model === 'string') {
    state.servedModel = ev.response.model
  }

  // Text deltas
  if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
    state.content += ev.delta
    handlers?.onTextDelta?.(ev.delta)
    return
  }
  // Reasoning deltas (event name varies across providers/models)
  if (
    (type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning.delta') &&
    typeof ev.delta === 'string'
  ) {
    state.reasoning += ev.delta
    handlers?.onReasoningDelta?.(ev.delta)
    return
  }

  // Item lifecycle: collect finished client function calls, announce
  // server-side tool invocations as they start.
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = ev.item ?? {}
    const itemType: string = item.type ?? ''
    if (SERVER_TOOL_ITEM_TYPES.has(itemType)) {
      const key = String(item.id ?? `${itemType}-${state.announcedServerCalls.size}`)
      if (!state.announcedServerCalls.has(key)) {
        state.announcedServerCalls.add(key)
        handlers?.onServerTool?.({
          name: itemType.replace(/_call$/, ''),
          detail: serverToolDetail(item)
        })
      }
    }
    if (type === 'response.output_item.done' && itemType === 'function_call') {
      upsertFunctionCall(state, item)
    }
    return
  }

  // Terminal events: usage, citations, and a fallback sweep of the final
  // output array in case item events were missed.
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = ev.response ?? {}
    if (type === 'response.incomplete') state.finishReason = 'incomplete'
    const usage = response.usage
    if (usage) {
      state.usage = {
        promptTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
        completionTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
        cachedTokens:
          usage.input_tokens_details?.cached_tokens ??
          usage.prompt_tokens_details?.cached_tokens ??
          0
      }
    }
    if (Array.isArray(response.citations)) {
      for (const c of response.citations) {
        const u = typeof c === 'string' ? c : c?.url
        if (typeof u === 'string' && !state.citations.includes(u)) state.citations.push(u)
      }
    }
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item?.type === 'function_call') upsertFunctionCall(state, item)
        if (item?.type === 'message' && !state.content) {
          for (const part of item.content ?? []) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
              state.content += part.text
              if (Array.isArray(part.annotations)) {
                for (const a of part.annotations) {
                  const u = a?.url
                  if (typeof u === 'string' && !state.citations.includes(u)) state.citations.push(u)
                }
              }
            }
          }
        }
      }
    }
    return
  }

  if (type === 'response.failed' || type === 'error') {
    const message =
      ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? 'response failed'
    throw new ProviderError(`xAI API stream error: ${message}`, undefined, true)
  }
}

function upsertFunctionCall(state: StreamState, item: Record<string, any>): void {
  const callId = String(item.call_id ?? item.id ?? '')
  if (!callId || state.toolCalls.some((tc) => tc.id === callId)) return
  state.toolCalls.push({
    id: callId,
    type: 'function',
    function: {
      name: String(item.name ?? ''),
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
    }
  })
}

function serverToolDetail(item: Record<string, any>): string {
  const action = item.action ?? {}
  const candidate = action.query ?? action.url ?? item.query ?? item.url
  if (typeof candidate === 'string' && candidate) return candidate
  return 'searching…'
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
