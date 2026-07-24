import { afterAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FrameParser } from '../src/main/agent/lsp/rpc'
import { languageIdFor, specForFile, findServerCommand, type ServerSpec } from '../src/main/agent/lsp/servers'
import { LspClient, type LspDocumentSymbol, type LspLocationLink } from '../src/main/agent/lsp/client'

const enc = (msg: object): Buffer => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

describe('FrameParser', () => {
  it('parses a single framed message', () => {
    const p = new FrameParser()
    expect(p.push(enc({ jsonrpc: '2.0', id: 1, result: 'ok' }))).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'ok' }
    ])
  })

  it('reassembles a message split across arbitrary chunk boundaries', () => {
    const p = new FrameParser()
    const whole = enc({ jsonrpc: '2.0', method: 'x', params: { a: 1 } })
    const out: unknown[] = []
    // Feed one byte at a time — worst-case fragmentation.
    for (let i = 0; i < whole.length; i++) out.push(...p.push(whole.subarray(i, i + 1)))
    expect(out).toEqual([{ jsonrpc: '2.0', method: 'x', params: { a: 1 } }])
  })

  it('parses multiple messages arriving in one chunk', () => {
    const p = new FrameParser()
    const chunk = Buffer.concat([enc({ id: 1 }), enc({ id: 2 }), enc({ id: 3 })])
    expect(p.push(chunk).map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('handles multi-byte UTF-8 content lengths correctly', () => {
    const p = new FrameParser()
    expect(p.push(enc({ text: 'héllo — ⌖' }))).toEqual([{ text: 'héllo — ⌖' }])
  })

  it('skips a malformed header block and resyncs on the next message', () => {
    const p = new FrameParser()
    const junk = Buffer.from('X-Whatever: nope\r\n\r\n')
    expect(p.push(Buffer.concat([junk, enc({ id: 7 })]))).toEqual([{ id: 7 }])
  })
})

describe('server registry', () => {
  it('maps extensions to servers', () => {
    expect(specForFile('src/a.ts')?.id).toBe('typescript')
    expect(specForFile('src/a.jsx')?.id).toBe('typescript')
    expect(specForFile('main.py')?.id).toBe('python')
    expect(specForFile('main.go')?.id).toBe('go')
    expect(specForFile('lib.rs')?.id).toBe('rust')
    expect(specForFile('a.cpp')?.id).toBe('clangd')
    expect(specForFile('notes.txt')).toBeNull()
    expect(specForFile('Makefile')).toBeNull()
  })

  it('maps extensions to LSP languageIds', () => {
    expect(languageIdFor('a.tsx')).toBe('typescriptreact')
    expect(languageIdFor('a.mjs')).toBe('javascript')
    expect(languageIdFor('a.py')).toBe('python')
    expect(languageIdFor('a.weird')).toBe('plaintext')
  })

  it('returns null when no server binary exists', () => {
    const spec: ServerSpec = {
      id: 'nope',
      candidates: [{ bin: 'definitely-not-a-real-binary-xyz', args: [] }],
      install: 'n/a'
    }
    expect(findServerCommand(os.tmpdir(), spec)).toBeNull()
  })
})

describe('LspClient against a fake server', () => {
  const fixture = path.join(__dirname, 'fixtures', 'fake-lsp.cjs')
  const spec: ServerSpec = { id: 'fake', candidates: [], install: 'n/a' }
  let root: string
  let file: string
  let client: LspClient

  const startedClients: LspClient[] = []
  afterAll(() => {
    for (const c of startedClients) c.dispose()
  })

  async function setup(): Promise<LspClient> {
    if (client) return client
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'conduit-lsp-'))
    file = path.join(root, 'sample.ts')
    await fsp.writeFile(file, 'const a = 1\nconst b = 2\nfunction target() {}\n', 'utf8')
    client = new LspClient(spec, { command: process.execPath, args: [fixture] }, root)
    startedClients.push(client)
    await client.ready()
    return client
  }

  it('initializes and receives diagnostics after didOpen', async () => {
    const c = await setup()
    const { uri, diagnosticsSettled } = await c.syncFile(file)
    expect(diagnosticsSettled).not.toBeNull()
    await diagnosticsSettled
    const diags = c.diagnosticsFor(uri)
    expect(diags).toHaveLength(1)
    expect(diags[0].message).toBe('problem v1')
  })

  it('skips resync for unchanged files, resyncs on change', async () => {
    const c = await setup()
    const unchanged = await c.syncFile(file)
    expect(unchanged.diagnosticsSettled).toBeNull()

    await fsp.appendFile(file, 'const c = 3\n')
    const changed = await c.syncFile(file)
    expect(changed.diagnosticsSettled).not.toBeNull()
    await changed.diagnosticsSettled
    expect(c.diagnosticsFor(changed.uri)[0].message).toBe('problem v2')
  })

  it('answers server→client requests so hover completes', async () => {
    const c = await setup()
    const { uri } = await c.syncFile(file)
    const res = (await c.hover(uri, { line: 0, character: 6 })) as { contents: { value: string } }
    expect(res.contents.value).toBe('fake hover text')
  })

  it('returns definition, references, and symbols', async () => {
    const c = await setup()
    const { uri } = await c.syncFile(file)
    const defs = (await c.definition(uri, { line: 0, character: 6 })) as LspLocationLink[]
    expect(defs[0].targetRange.start.line).toBe(2)

    const refs = (await c.references(uri, { line: 0, character: 6 })) as unknown[]
    expect(refs).toHaveLength(2)

    const syms = (await c.documentSymbols(uri)) as LspDocumentSymbol[]
    expect(syms[0].name).toBe('Foo')
    expect(syms[0].children?.[0].name).toBe('bar')
  })

  it('detects rename/codeAction capabilities and returns a rename edit', async () => {
    const c = await setup()
    expect(c.canRename).toBe(true)
    expect(c.canCodeAction).toBe(true)
    const { uri } = await c.syncFile(file)
    const edit = await c.rename(uri, { line: 0, character: 6 }, 'renamed')
    expect(edit?.changes?.[uri]?.[0]?.newText).toBe('renamed')
  })

  it('returns code actions, including edit-bearing and command-only ones', async () => {
    const c = await setup()
    const { uri } = await c.syncFile(file)
    const actions = await c.codeActions(uri, { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, [])
    expect(actions.map((a) => a.title)).toEqual(['Fix it', 'Run command'])
    expect(actions[0].edit).toBeTruthy()
    expect(actions[1].edit).toBeUndefined()
    expect(actions[1].command?.command).toBe('noop')
  })

  it('shuts the server down on dispose', async () => {
    const c = await setup()
    c.dispose()
    await new Promise((r) => setTimeout(r, 300))
    expect(c.alive).toBe(false)
  })
})
