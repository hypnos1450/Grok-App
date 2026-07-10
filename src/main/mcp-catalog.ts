// Curated MCP server catalog for one-click install (still requires user confirm).
import { McpCatalogEntry } from '@shared/types'

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files in allowed directories (official reference server).',
    install: '@modelcontextprotocol/server-filesystem',
    risk: 'high',
    envNeeds: []
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, PRs, and issues via the GitHub API.',
    install: '@modelcontextprotocol/server-github',
    risk: 'high',
    envNeeds: ['GITHUB_PERSONAL_ACCESS_TOKEN']
  },
  {
    id: 'memory',
    name: 'Memory (knowledge graph)',
    description: 'Persistent knowledge graph memory server.',
    install: '@modelcontextprotocol/server-memory',
    risk: 'medium'
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation for screenshots and page interaction.',
    install: '@modelcontextprotocol/server-puppeteer',
    risk: 'high'
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query local SQLite databases.',
    install: '@modelcontextprotocol/server-sqlite',
    risk: 'medium'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured multi-step reasoning helper.',
    install: '@modelcontextprotocol/server-sequential-thinking',
    risk: 'low'
  }
]
