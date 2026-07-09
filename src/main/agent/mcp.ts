// MCP (Model Context Protocol) client manager. Connects configured stdio MCP
// servers, discovers their tools, and adapts each into the harness Tool
// interface so Grok can call them through the normal agent loop. Tool names are
// namespaced `mcp__<server>__<tool>` to avoid collisions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServerConfig, McpServerStatus } from '@shared/types'
import { logger } from '../logger'
import type { Tool } from './tools'

const log = logger('mcp')

interface Connection {
  config: McpServerConfig
  client?: Client
  tools: Tool[]
  error?: string
}

function truncate(text: string, n = 20_000): string {
  return text.length > n ? `${text.slice(0, n)}\n… (truncated)` : text
}

class McpManager {
  private connections = new Map<string, Connection>()

  /** (Re)connect to the given server set, disconnecting any that were removed. */
  async sync(servers: McpServerConfig[]): Promise<void> {
    const wanted = new Set(servers.filter((s) => s.enabled).map((s) => s.name))
    // Disconnect servers no longer wanted.
    for (const [name, conn] of this.connections) {
      if (!wanted.has(name)) {
        await conn.client?.close().catch(() => undefined)
        this.connections.delete(name)
      }
    }
    // Connect/refresh wanted servers.
    await Promise.all(
      servers.filter((s) => s.enabled).map((s) => this.connect(s))
    )
  }

  private async connect(config: McpServerConfig): Promise<void> {
    // Skip if already connected with identical config.
    const existing = this.connections.get(config.name)
    if (existing?.client && JSON.stringify(existing.config) === JSON.stringify(config)) return
    await existing?.client?.close().catch(() => undefined)

    const conn: Connection = { config, tools: [] }
    this.connections.set(config.name, conn)
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) }
      })
      const client = new Client(
        { name: 'grok-harness', version: '0.1.0' },
        { capabilities: {} }
      )
      await client.connect(transport)
      conn.client = client

      const { tools } = await client.listTools()
      conn.tools = tools.map((t) => this.adapt(config.name, client, t))
      log.info(`connected ${config.name}: ${conn.tools.length} tools`)
    } catch (err) {
      conn.error = err instanceof Error ? err.message : String(err)
      log.warn(`failed to connect ${config.name}: ${conn.error}`)
    }
  }

  private adapt(
    server: string,
    client: Client,
    def: { name: string; description?: string; inputSchema?: unknown }
  ): Tool {
    const toolName = `mcp__${server}__${def.name}`
    return {
      name: toolName,
      // MCP tools can have side effects, so gate them like shell commands.
      kind: 'command',
      def: {
        type: 'function',
        function: {
          name: toolName,
          description: `[MCP: ${server}] ${def.description ?? def.name}`,
          parameters: (def.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {}
          }
        }
      },
      summarize: (input) => `${server}/${def.name} ${JSON.stringify(input).slice(0, 80)}`,
      run: async (input) => {
        try {
          const result = await client.callTool({ name: def.name, arguments: input })
          const parts = Array.isArray(result.content) ? result.content : []
          const text = parts
            .map((p: { type?: string; text?: string }) =>
              p.type === 'text' ? p.text ?? '' : `[${p.type ?? 'content'}]`
            )
            .join('\n')
          return { ok: !result.isError, output: truncate(text) || '(no output)' }
        } catch (err) {
          return { ok: false, output: err instanceof Error ? err.message : String(err) }
        }
      }
    }
  }

  tools(): Tool[] {
    return [...this.connections.values()].flatMap((c) => c.tools)
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.config.name,
      connected: !!c.client && !c.error,
      toolCount: c.tools.length,
      // Un-namespaced tool names for the Settings UI
      tools: c.tools.map((t) => t.name.replace(`mcp__${c.config.name}__`, '')),
      error: c.error
    }))
  }

  async shutdown(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client?.close().catch(() => undefined)
    }
    this.connections.clear()
  }
}

export const mcpManager = new McpManager()
