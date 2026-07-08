import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/common'
import { ChatItem } from '@shared/types'

/** Fenced code block with highlight.js. Falls back to plain text on failure. */
function CodeBlock({ className, children }: { className?: string; children?: unknown }): JSX.Element {
  const code = String(children ?? '').replace(/\n$/, '')
  const lang = /language-(\w+)/.exec(className ?? '')?.[1]
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      return null
    }
  }, [code, lang])
  if (html === null) return <code className={className}>{code}</code>
  return <code className={`hljs ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}

function ItemView({ item }: { item: ChatItem }): JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return <UserView item={item} />
    case 'assistant':
      return <AssistantView item={item} />
    case 'tool':
      return <ToolCard item={item} />
    case 'compaction':
      return <div className="msg-compaction">Context compacted to stay within the model window</div>
    case 'error':
      return <div className="msg-error">{item.message}</div>
    case 'note':
      return <div className="msg-note">{item.text}</div>
    default:
      return null
  }
}

function UserView({ item }: { item: Extract<ChatItem, { kind: 'user' }> }): JSX.Element {
  return (
    <div className="msg-user">
      {item.images && item.images.length > 0 && (
        <div className="msg-images">
          {item.images.map((src, i) => (
            <img key={i} src={src} alt={`attachment ${i + 1}`} />
          ))}
        </div>
      )}
      {item.files && item.files.length > 0 && (
        <div className="msg-files">
          {item.files.map((f) => (
            <span key={f} className="file-chip" title={f}>
              📄 {f.split('/').pop()}
            </span>
          ))}
        </div>
      )}
      {item.text}
    </div>
  )
}

/** Renders a unified diff / preview with per-line +/- coloring. */
export function DiffView({ text }: { text: string }): JSX.Element {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('⋯') || line.startsWith('(')
              ? 'diff-meta'
              : undefined
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function AssistantView({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }): JSX.Element {
  const [showReasoning, setShowReasoning] = useState(false)
  return (
    <div className="msg-assistant">
      {item.reasoning && (
        <>
          <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
            {showReasoning ? '▾' : '▸'} thought for a moment
          </button>
          {showReasoning && <div className="reasoning-body">{item.reasoning}</div>}
        </>
      )}
      {item.text && (
        <div className="md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Open every link in the system browser — never navigate the app.
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    if (href) void window.harness.openExternal(href)
                  }}
                >
                  {children}
                </a>
              ),
              // Highlight fenced blocks; leave inline code (no language, no
              // newline) to the default renderer.
              code: ({ className, children, ...props }) => {
                const isBlock = /language-/.test(className ?? '') || String(children).includes('\n')
                return isBlock ? (
                  <CodeBlock className={className}>{children}</CodeBlock>
                ) : (
                  <code className={className} {...props}>
                    {children}
                  </code>
                )
              }
            }}
          >
            {item.text}
          </ReactMarkdown>
        </div>
      )}
      {item.citations && item.citations.length > 0 && (
        <div className="citations">
          {item.citations.map((url) => (
            <button
              key={url}
              className="citation-chip"
              title={url}
              onClick={() => void window.harness.openExternal(url)}
            >
              {hostOf(url)}
            </button>
          ))}
        </div>
      )}
      {item.model && (
        <div className="assistant-model" title="Model that generated this response (as reported by the xAI API)">
          {item.model}
        </div>
      )}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = summarize(item)
  return (
    <div className="tool-card">
      <button className="tool-card-header" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-status ${item.status}`} />
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{summary}</span>
        {typeof item.durationMs === 'number' && (
          <span className="tool-duration">{formatDuration(item.durationMs)}</span>
        )}
      </button>
      {open && (
        <div className="tool-card-body">
          {item.preview ? (
            <>
              <div className="tool-io-label">Changes</div>
              <DiffView text={item.preview} />
            </>
          ) : (
            <>
              <div className="tool-io-label">Input</div>
              <pre>{JSON.stringify(item.input, null, 2)}</pre>
            </>
          )}
          {item.output !== undefined && (
            <>
              <div className="tool-io-label">Output</div>
              <pre>{item.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function summarize(item: Extract<ChatItem, { kind: 'tool' }>): string {
  const input = item.input
  switch (item.name) {
    case 'bash':
      return String(input.command ?? '')
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(input.path ?? '')
    case 'glob':
    case 'grep':
      return String(input.pattern ?? '')
    case 'list_dir':
      return String(input.path ?? '.')
    default:
      return JSON.stringify(input).slice(0, 120)
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default memo(ItemView)
