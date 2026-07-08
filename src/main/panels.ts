// Backend for the right-dock panels: workspace file browsing (Files/Preview)
// and a lightweight per-session terminal runner (spawn a shell command in the
// session cwd, stream output, keep a tail buffer so reopening the panel shows
// history). Not a full PTY — no interactive TUI apps — but plenty for dev
// servers, builds, and log tails.
import { BrowserWindow } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { FileEntry, FilePreview, TermData, TermSnapshot } from '@shared/types'
import { logger } from './logger'

const log = logger('panels')

// ------------------------------------------------------------ file browsing

/** Resolve a workspace-relative path, refusing escapes from the cwd. */
function safeResolve(cwd: string, rel: string): string | null {
  const abs = path.resolve(cwd, rel)
  return abs === cwd || abs.startsWith(cwd + path.sep) ? abs : null
}

export function listDir(cwd: string, rel: string): FileEntry[] {
  const abs = safeResolve(cwd, rel)
  if (!abs) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return []
  }
  const out: FileEntry[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue // skip sockets, symlinks, etc.
    out.push({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, isDir: e.isDirectory() })
  }
  // Directories first, dotfiles last within each group, then alphabetical.
  return out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const aDot = a.name.startsWith('.') ? 1 : 0
    const bDot = b.name.startsWith('.') ? 1 : 0
    if (aDot !== bDot) return aDot - bDot
    return a.name.localeCompare(b.name)
  })
}

const MAX_TEXT_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp'
}

export function readFilePreview(cwd: string, rel: string): FilePreview {
  const abs = safeResolve(cwd, rel)
  if (!abs) return { kind: 'error', message: 'Path is outside the workspace.' }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { kind: 'error', message: 'File not found.' }
  }
  if (!stat.isFile()) return { kind: 'error', message: 'Not a file.' }

  const ext = path.extname(abs).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (mime) {
    if (stat.size > MAX_IMAGE_BYTES) return { kind: 'too-large', size: stat.size }
    const dataUrl = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
    return { kind: 'image', dataUrl, size: stat.size }
  }
  if (stat.size > MAX_TEXT_BYTES * 4) return { kind: 'too-large', size: stat.size }

  const buf = fs.readFileSync(abs)
  // Crude binary sniff: NUL byte in the first 8K.
  const head = buf.subarray(0, 8192)
  if (head.includes(0)) return { kind: 'binary', size: stat.size }
  const truncated = buf.length > MAX_TEXT_BYTES
  return {
    kind: 'text',
    content: buf.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
    truncated,
    size: stat.size
  }
}

// ------------------------------------------------------------ terminal

const TERM_BUFFER_CAP = 200 * 1024

interface TermProc {
  child: ChildProcess
  buffer: string
  command: string
  exitCode?: number | null
}

class TermManager {
  private procs = new Map<string, TermProc>()
  private getWindow: () => BrowserWindow | null = () => null

  init(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  private emit(data: TermData): void {
    this.getWindow()?.webContents.send('term:data', data)
  }

  private append(sessionId: string, proc: TermProc, chunk: string): void {
    proc.buffer = (proc.buffer + chunk).slice(-TERM_BUFFER_CAP)
    this.emit({ sessionId, chunk })
  }

  run(sessionId: string, cwd: string, command: string): { ok: boolean; error?: string } {
    const existing = this.procs.get(sessionId)
    if (existing && existing.exitCode === undefined) {
      return { ok: false, error: 'A command is already running — stop it first.' }
    }
    const shell = process.platform === 'win32' ? process.env['COMSPEC'] ?? 'cmd.exe' : '/bin/zsh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
    let child: ChildProcess
    try {
      child = spawn(shell, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' } })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const proc: TermProc = { child, buffer: '', command }
    const prior = existing ? `${existing.buffer}\n` : ''
    proc.buffer = prior.slice(-TERM_BUFFER_CAP)
    this.procs.set(sessionId, proc)
    this.append(sessionId, proc, `$ ${command}\n`)

    child.stdout?.on('data', (d: Buffer) => this.append(sessionId, proc, d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => this.append(sessionId, proc, d.toString('utf8')))
    child.on('error', (err) => {
      proc.exitCode = null
      this.append(sessionId, proc, `\n[failed to start: ${err.message}]\n`)
      this.emit({ sessionId, chunk: '', done: true, exitCode: null })
    })
    child.on('exit', (code) => {
      proc.exitCode = code
      this.append(sessionId, proc, `\n[exited with code ${code ?? 'null'}]\n`)
      this.emit({ sessionId, chunk: '', done: true, exitCode: code })
    })
    log.info(`term run [${sessionId.slice(0, 8)}]: ${command}`)
    return { ok: true }
  }

  kill(sessionId: string): void {
    const proc = this.procs.get(sessionId)
    if (!proc || proc.exitCode !== undefined) return
    proc.child.kill('SIGTERM')
    const pid = proc.child.pid
    setTimeout(() => {
      if (proc.exitCode === undefined && pid) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }, 3000)
  }

  snapshot(sessionId: string): TermSnapshot {
    const proc = this.procs.get(sessionId)
    if (!proc) return { buffer: '', running: false }
    return {
      buffer: proc.buffer,
      running: proc.exitCode === undefined,
      command: proc.command,
      exitCode: proc.exitCode
    }
  }

  killAll(): void {
    for (const [id] of this.procs) this.kill(id)
  }
}

export const termManager = new TermManager()
