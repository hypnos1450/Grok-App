// Minimal fake LSP server for tests: real Content-Length framing over stdio,
// canned responses for the requests LspClient makes. Run with: node fake-lsp.cjs
let buffer = Buffer.alloc(0)
let pendingHoverId = null

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const m = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
    const len = Number(m[1])
    if (buffer.length < headerEnd + 4 + len) return
    const msg = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8'))
    buffer = buffer.subarray(headerEnd + 4 + len)
    handle(msg)
  }
})

const range = (line) => ({ start: { line, character: 4 }, end: { line, character: 10 } })

function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: { capabilities: { renameProvider: true, codeActionProvider: true } }
    })
  } else if (method === 'textDocument/rename') {
    // Rename the 6-char span on line 0 (matches range()) in the same file.
    const uri = params.textDocument.uri
    send({
      jsonrpc: '2.0',
      id,
      result: { changes: { [uri]: [{ range: range(0), newText: params.newName }] } }
    })
  } else if (method === 'textDocument/codeAction') {
    const uri = params.textDocument.uri
    send({
      jsonrpc: '2.0',
      id,
      result: [
        {
          title: 'Fix it',
          kind: 'quickfix',
          edit: { changes: { [uri]: [{ range: range(0), newText: 'fixed' }] } }
        },
        { title: 'Run command', kind: 'source', command: { command: 'noop', title: 'noop' } }
      ]
    })
  } else if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
    const { uri, version } = params.textDocument
    // Publish asynchronously, like a real server computing diagnostics.
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            { range: range(0), severity: 1, source: 'fake', code: 'E1', message: `problem v${version}` }
          ]
        }
      })
    }, 30)
  } else if (method === 'textDocument/hover') {
    // Exercise the client's server->request handling: it must answer this
    // configuration request or the hover reply never arrives.
    pendingHoverId = id
    send({ jsonrpc: '2.0', id: 999, method: 'workspace/configuration', params: { items: [{}] } })
  } else if (method === undefined && id === 999) {
    send({
      jsonrpc: '2.0',
      id: pendingHoverId,
      result: { contents: { kind: 'markdown', value: 'fake hover text' } }
    })
  } else if (method === 'textDocument/definition') {
    // LocationLink form, to exercise normalization.
    send({
      jsonrpc: '2.0',
      id,
      result: [{ targetUri: params.textDocument.uri, targetRange: range(2), targetSelectionRange: range(2) }]
    })
  } else if (method === 'textDocument/references') {
    const uri = params.textDocument.uri
    send({ jsonrpc: '2.0', id, result: [{ uri, range: range(0) }, { uri, range: range(2) }] })
  } else if (method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id,
      result: [
        {
          name: 'Foo', kind: 5, range: range(0), selectionRange: range(0),
          children: [{ name: 'bar', kind: 6, range: range(1), selectionRange: range(1) }]
        }
      ]
    })
  } else if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null })
  } else if (method === 'exit') {
    process.exit(0)
  }
}
