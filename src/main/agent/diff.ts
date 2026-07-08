// Minimal unified line diff (LCS-based) for edit previews. No dependency;
// bounded so pathological inputs can't hang the loop.

const MAX_LINES = 1500
const CONTEXT = 3

export function unifiedDiff(oldText: string, newText: string): string {
  if (oldText === newText) return '(no changes)'
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return `(diff too large to preview: ${a.length} → ${b.length} lines)`
  }

  // LCS table
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = []
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  // Backtrack into op list: ' ' keep, '-' delete, '+' insert
  const ops: { tag: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: '-', line: a[i] })
      i++
    } else {
      ops.push({ tag: '+', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ tag: '-', line: a[i++] })
  while (j < m) ops.push({ tag: '+', line: b[j++] })

  // Collapse unchanged runs down to CONTEXT lines around changes.
  const out: string[] = []
  let run: string[] = []
  let emittedChange = false
  const flushRun = (isEnd: boolean): void => {
    if (run.length === 0) return
    const head = emittedChange ? run.slice(0, CONTEXT) : []
    const tail = isEnd ? [] : run.slice(-CONTEXT)
    const hidden = run.length - head.length - tail.length
    for (const l of head) out.push(` ${l}`)
    if (hidden > 0) out.push(`⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'} ⋯`)
    else if (head.length + tail.length > run.length) {
      // Runs shorter than 2*CONTEXT: avoid double-printing overlap.
      out.length -= head.length + tail.length - run.length
    }
    for (const l of tail) out.push(` ${l}`)
    run = []
  }
  for (const op of ops) {
    if (op.tag === ' ') {
      run.push(op.line)
    } else {
      flushRun(false)
      emittedChange = true
      out.push(`${op.tag}${op.line}`)
    }
  }
  flushRun(true)

  const text = out.join('\n')
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n⋯ (preview truncated)` : text
}

/** Preview for a brand-new file. */
export function newFilePreview(content: string): string {
  const lines = content.split('\n')
  const shown = lines.slice(0, 80)
  const body = shown.map((l) => `+${l}`).join('\n')
  const more = lines.length > shown.length ? `\n⋯ ${lines.length - shown.length} more lines ⋯` : ''
  return `(new file, ${lines.length} lines)\n${body}${more}`
}
