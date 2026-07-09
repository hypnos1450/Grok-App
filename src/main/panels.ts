// Backend for the right-dock panels: workspace file browsing (Files/Preview)
// and a per-session terminal (PTY when node-pty is available, otherwise an
// enhanced multi-job spawn runner with sticky cwd, process-tree kill, and
// persistent scrollback).
import { BrowserWindow, app } from 'electron'
import { ChildProcess, execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  FileEntry,
  FilePreview,
  TermData,
  TermJobInfo,
  TermRunOpts,
  TermSnapshot
} from '@shared/types'
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
const HISTORY_CAP = 200
const MAX_JOBS = 4

type PtyModule = typeof import('node-pty')
type IPty = import('node-pty').IPty

let ptyMod: PtyModule | null | undefined

function loadPty(): PtyModule | null {
  if (ptyMod !== undefined) return ptyMod
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyMod = require('node-pty') as PtyModule
    log.info('node-pty loaded — interactive PTY terminal enabled')
  } catch (err) {
    ptyMod = null
    log.warn(`node-pty unavailable, using spawn fallback: ${err instanceof Error ? err.message : err}`)
  }
  return ptyMod
}

function id(): string {
  return crypto.randomBytes(4).toString('hex')
}

function resolveShell(): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const comspec = process.env['COMSPEC'] || 'cmd.exe'
    // Prefer PowerShell when available — better for modern Windows workflows.
    const ps =
      process.env['POWERSHELL_DISTRIBUTION_CHANNEL'] ||
      process.env['PSModulePath']
        ? 'powershell.exe'
        : null
    // Use COMSPEC by default for broadest compatibility; PowerShell if user shell hints at it.
    const preferPs =
      /powershell|pwsh/i.test(process.env['SHELL'] ?? '') ||
      /powershell|pwsh/i.test(process.env['ComSpec'] ?? '')
    if (preferPs && ps) {
      return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], label: 'powershell' }
    }
    // Try pwsh (PowerShell 7+) then powershell, else cmd.
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      // Don't probe PATH heavily; spawn will fail clearly if missing.
      if (preferPs) return { file: candidate, args: ['-NoLogo'], label: candidate.replace(/\.exe$/i, '') }
    }
    return { file: comspec, args: [], label: path.basename(comspec) }
  }
  const shell = process.env['SHELL'] || '/bin/bash'
  // Login shell so user profile (nvm, path, aliases) is available.
  const base = path.basename(shell)
  if (base === 'zsh' || base === 'bash') {
    return { file: shell, args: ['-l'], label: base }
  }
  return { file: shell, args: [], label: base }
}

function historyFile(sessionId: string): string {
  return path.join(app.getPath('userData'), 'term-history', `${sessionId}.json`)
}

function bufferFile(sessionId: string, jobId: string): string {
  return path.join(app.getPath('userData'), 'term-buffers', sessionId, `${jobId}.log`)
}

function loadHistory(sessionId: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(sessionId), 'utf8'))
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(-HISTORY_CAP) : []
  } catch {
    return []
  }
}

function saveHistory(sessionId: string, history: string[]): void {
  try {
    const dir = path.dirname(historyFile(sessionId))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(historyFile(sessionId), JSON.stringify(history.slice(-HISTORY_CAP)), 'utf8')
  } catch (err) {
    log.warn(`history save failed: ${err instanceof Error ? err.message : err}`)
  }
}

function loadBufferDisk(sessionId: string, jobId: string): string {
  try {
    return fs.readFileSync(bufferFile(sessionId, jobId), 'utf8').slice(-TERM_BUFFER_CAP)
  } catch {
    return ''
  }
}

function saveBufferDisk(sessionId: string, jobId: string, buffer: string): void {
  try {
    const f = bufferFile(sessionId, jobId)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, buffer.slice(-TERM_BUFFER_CAP), 'utf8')
  } catch {
    // best-effort
  }
}

/** Kill a process tree. Windows needs taskkill /T; Unix uses process group. */
function killTree(pid: number | undefined, child?: ChildProcess | null): void {
  if (!pid && !child) return
  if (process.platform === 'win32') {
    const target = pid ?? child?.pid
    if (!target) return
    try {
      execFile('taskkill', ['/pid', String(target), '/T', '/F'], { windowsHide: true }, () => undefined)
    } catch {
      try {
        child?.kill()
      } catch {
        // gone
      }
    }
    return
  }
  try {
    if (pid) process.kill(-pid, 'SIGTERM')
    else child?.kill('SIGTERM')
  } catch {
    try {
      child?.kill('SIGTERM')
    } catch {
      // gone
    }
  }
  setTimeout(() => {
    try {
      if (pid) process.kill(-pid, 'SIGKILL')
      else if (child?.pid) process.kill(child.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, 2500)
}

interface Job {
  id: string
  name: string
  cwd: string
  buffer: string
  command?: string
  exitCode?: number | null
  /** Spawn child (non-PTY one-shot or long-lived) */
  child?: ChildProcess | null
  /** PTY handle when mode is pty */
  pty?: IPty | null
  /** True while a process is live */
  running: boolean
  /** Persist timer */
  persistTimer?: ReturnType<typeof setTimeout>
}

interface SessionTerm {
  sessionId: string
  workspaceCwd: string
  mode: 'pty' | 'spawn'
  shell: ReturnType<typeof resolveShell>
  jobs: Map<string, Job>
  activeJobId: string
  history: string[]
  cols: number
  rows: number
}

class TermManager {
  private sessions = new Map<string, SessionTerm>()
  private getWindow: () => BrowserWindow | null = () => null
  private notifyExit:
    | ((sessionId: string, jobName: string, command: string, exitCode: number | null) => void)
    | null = null

  init(
    getWindow: () => BrowserWindow | null,
    notifyExit?: (sessionId: string, jobName: string, command: string, exitCode: number | null) => void
  ): void {
    this.getWindow = getWindow
    this.notifyExit = notifyExit ?? null
    // Probe PTY once at startup so the first open is fast.
    loadPty()
  }

  private emit(data: TermData): void {
    this.getWindow()?.webContents.send('term:data', data)
  }

  private ensureSession(sessionId: string, workspaceCwd: string): SessionTerm {
    let s = this.sessions.get(sessionId)
    if (s) {
      if (s.workspaceCwd !== workspaceCwd) s.workspaceCwd = workspaceCwd
      return s
    }
    const pty = loadPty()
    const shell = resolveShell()
    const jobId = id()
    const job: Job = {
      id: jobId,
      name: 'main',
      cwd: workspaceCwd,
      buffer: loadBufferDisk(sessionId, jobId),
      running: false
    }
    s = {
      sessionId,
      workspaceCwd,
      mode: pty ? 'pty' : 'spawn',
      shell,
      jobs: new Map([[jobId, job]]),
      activeJobId: jobId,
      history: loadHistory(sessionId),
      cols: 80,
      rows: 24
    }
    this.sessions.set(sessionId, s)
    return s
  }

  private jobInfo(j: Job): TermJobInfo {
    return {
      id: j.id,
      name: j.name,
      running: j.running,
      command: j.command,
      exitCode: j.exitCode,
      cwd: j.cwd
    }
  }

  private jobsList(s: SessionTerm): TermJobInfo[] {
    return [...s.jobs.values()].map((j) => this.jobInfo(j))
  }

  private snapshotOf(s: SessionTerm): TermSnapshot {
    const buffers: Record<string, string> = {}
    for (const j of s.jobs.values()) buffers[j.id] = j.buffer
    return {
      sessionId: s.sessionId,
      mode: s.mode,
      jobs: this.jobsList(s),
      activeJobId: s.activeJobId,
      buffers,
      history: s.history.slice(),
      shell: s.shell.label,
      workspaceCwd: s.workspaceCwd
    }
  }

  private append(s: SessionTerm, job: Job, chunk: string, done?: boolean, exitCode?: number | null): void {
    if (chunk) {
      job.buffer = (job.buffer + chunk).slice(-TERM_BUFFER_CAP)
      if (job.persistTimer) clearTimeout(job.persistTimer)
      job.persistTimer = setTimeout(() => saveBufferDisk(s.sessionId, job.id, job.buffer), 400)
    }
    this.emit({
      sessionId: s.sessionId,
      jobId: job.id,
      chunk,
      done,
      exitCode,
      jobs: done ? this.jobsList(s) : undefined
    })
  }

  private pushHistory(s: SessionTerm, command: string): void {
    const t = command.trim()
    if (!t) return
    if (s.history[s.history.length - 1] === t) return
    s.history.push(t)
    if (s.history.length > HISTORY_CAP) s.history = s.history.slice(-HISTORY_CAP)
    saveHistory(s.sessionId, s.history)
  }

  private getJob(s: SessionTerm, jobId?: string): Job | null {
    const id = jobId || s.activeJobId
    return s.jobs.get(id) ?? null
  }

  /** Start (or resume) the interactive PTY shell for a job. */
  private ensurePty(s: SessionTerm, job: Job): { ok: boolean; error?: string } {
    if (job.pty) return { ok: true }
    const pty = loadPty()
    if (!pty) return { ok: false, error: 'PTY not available' }
    try {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v
      }
      env['TERM'] = env['TERM'] || 'xterm-256color'
      env['COLORTERM'] = env['COLORTERM'] || 'truecolor'
      // Keep colors — xterm.js renders ANSI.
      delete env['FORCE_COLOR']
      env['FORCE_COLOR'] = '3'

      const p = pty.spawn(s.shell.file, s.shell.args, {
        name: 'xterm-256color',
        cols: s.cols,
        rows: s.rows,
        cwd: job.cwd,
        env,
        useConpty: process.platform === 'win32' ? true : undefined
      })
      job.pty = p
      job.running = true
      job.exitCode = undefined
      p.onData((data: string) => this.append(s, job, data))
      p.onExit(({ exitCode }) => {
        job.running = false
        job.exitCode = exitCode
        job.pty = null
        const cmd = job.command ?? s.shell.label
        this.append(s, job, `\r\n[shell exited with code ${exitCode}]\r\n`, true, exitCode)
        this.notifyExit?.(s.sessionId, job.name, cmd, exitCode)
      })
      if (!job.buffer) {
        this.append(s, job, `\x1b[90m${s.shell.label} · ${job.cwd}\x1b[0m\r\n`)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  open(sessionId: string, workspaceCwd: string): TermSnapshot {
    const s = this.ensureSession(sessionId, workspaceCwd)
    if (s.mode === 'pty') {
      const job = this.getJob(s)
      if (job) this.ensurePty(s, job)
    }
    return this.snapshotOf(s)
  }

  run(
    sessionId: string,
    workspaceCwd: string,
    command: string,
    opts?: TermRunOpts
  ): { ok: boolean; error?: string; jobId?: string } {
    const s = this.ensureSession(sessionId, workspaceCwd)
    const cmd = command.trim()
    if (!cmd) return { ok: false, error: 'Empty command' }

    // New background job?
    let job: Job | null = null
    if (opts?.newJob || opts?.name) {
      if (s.jobs.size >= MAX_JOBS) {
        return { ok: false, error: `At most ${MAX_JOBS} terminal jobs per session.` }
      }
      const jid = id()
      job = {
        id: jid,
        name: (opts.name || `job-${s.jobs.size + 1}`).slice(0, 24),
        cwd: workspaceCwd,
        buffer: '',
        running: false
      }
      s.jobs.set(jid, job)
      s.activeJobId = jid
    } else {
      job = this.getJob(s, opts?.jobId)
      if (!job) return { ok: false, error: 'No terminal job' }
    }

    this.pushHistory(s, cmd)
    job.command = cmd

    if (s.mode === 'pty') {
      // Interactive shell: write the line. If shell died, respawn first.
      if (!job.running || !job.pty) {
        const r = this.ensurePty(s, job)
        if (!r.ok) return r
      }
      try {
        // Track virtual cwd from `cd` for the header (best-effort).
        this.trackCd(job, cmd, workspaceCwd)
        job.pty!.write(cmd + '\r')
        this.emit({
          sessionId: s.sessionId,
          jobId: job.id,
          chunk: '',
          jobs: this.jobsList(s)
        })
        return { ok: true, jobId: job.id }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    // Spawn mode: one process per run, sticky virtual cwd, process-group kill.
    if (job.running) {
      return { ok: false, error: 'A command is already running in this job — stop it first, or open a new job.' }
    }

    // Handle pure `cd` locally so the next command inherits cwd.
    const cdOnly = cmd.match(/^cd\s+(?:\/d\s+)?(.+)$/i) || cmd.match(/^Set-Location\s+(.+)$/i)
    if (cdOnly) {
      const target = cdOnly[1].trim().replace(/^["']|["']$/g, '')
      const next = path.isAbsolute(target) ? target : path.resolve(job.cwd, target)
      try {
        if (fs.statSync(next).isDirectory()) {
          job.cwd = next
          this.append(s, job, `$ ${cmd}\n`)
          this.append(s, job, `[cwd] ${job.cwd}\n`, true, 0)
          job.exitCode = 0
          return { ok: true, jobId: job.id }
        }
      } catch {
        this.append(s, job, `$ ${cmd}\ncd: no such directory: ${target}\n`, true, 1)
        job.exitCode = 1
        return { ok: true, jobId: job.id }
      }
    }

    this.trackCd(job, cmd, workspaceCwd)

    const isWin = process.platform === 'win32'
    const shellFile = s.shell.file
    const shellArgs = isWin
      ? /powershell|pwsh/i.test(shellFile)
        ? ['-NoLogo', '-Command', cmd]
        : ['/d', '/s', '/c', cmd]
      : ['-lc', cmd]

    let child: ChildProcess
    try {
      child = spawn(shellFile, shellArgs, {
        cwd: job.cwd,
        env: {
          ...process.env,
          FORCE_COLOR: '1',
          TERM: process.env['TERM'] || 'xterm-256color'
        },
        // New process group on Unix so killTree can signal the whole tree.
        detached: !isWin,
        windowsHide: true,
        shell: false
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    job.child = child
    job.running = true
    job.exitCode = undefined
    this.append(s, job, `$ ${cmd}\n`)
    this.emit({
      sessionId: s.sessionId,
      jobId: job.id,
      chunk: '',
      jobs: this.jobsList(s)
    })

    child.stdout?.on('data', (d: Buffer) => this.append(s, job!, d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => this.append(s, job!, d.toString('utf8')))
    child.on('error', (err) => {
      job!.running = false
      job!.exitCode = null
      job!.child = null
      this.append(s, job!, `\n[failed to start: ${err.message}]\n`, true, null)
      this.notifyExit?.(s.sessionId, job!.name, cmd, null)
    })
    child.on('exit', (code) => {
      job!.running = false
      job!.exitCode = code
      job!.child = null
      this.append(s, job!, `\n[exited with code ${code ?? 'null'}]\n`, true, code)
      this.notifyExit?.(s.sessionId, job!.name, cmd, code)
    })
    log.info(`term run [${sessionId.slice(0, 8)}/${job.name}]: ${cmd}`)
    return { ok: true, jobId: job.id }
  }

  /** Best-effort virtual cwd tracking for `cd` prefixes. */
  private trackCd(job: Job, cmd: string, workspaceCwd: string): void {
    // Match leading `cd foo &&` / `cd foo;` patterns.
    const m = cmd.match(/^\s*cd\s+(?:\/d\s+)?([^\s;&|]+)(?:\s*[;&|])?/i)
    if (!m) return
    const target = m[1].replace(/^["']|["']$/g, '')
    if (target === '-' ) return
    const next = path.isAbsolute(target) ? target : path.resolve(job.cwd || workspaceCwd, target)
    try {
      if (fs.statSync(next).isDirectory()) job.cwd = next
    } catch {
      // ignore
    }
  }

  write(sessionId: string, data: string, jobId?: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const job = this.getJob(s, jobId)
    if (!job) return
    if (s.mode === 'pty' && job.pty) {
      try {
        job.pty.write(data)
      } catch {
        // closed
      }
      return
    }
    // Spawn mode: only forward if a process is running and has stdin.
    if (job.child?.stdin?.writable) {
      try {
        job.child.stdin.write(data)
      } catch {
        // closed
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number, jobId?: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cols = Math.max(2, Math.min(500, cols | 0))
    s.rows = Math.max(1, Math.min(200, rows | 0))
    const job = this.getJob(s, jobId)
    if (job?.pty) {
      try {
        job.pty.resize(s.cols, s.rows)
      } catch {
        // ignore
      }
    }
    // Resize all live PTYs in the session so background jobs stay consistent.
    for (const j of s.jobs.values()) {
      if (j !== job && j.pty) {
        try {
          j.pty.resize(s.cols, s.rows)
        } catch {
          // ignore
        }
      }
    }
  }

  kill(sessionId: string, jobId?: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const job = this.getJob(s, jobId)
    if (!job || !job.running) return
    if (job.pty) {
      try {
        // Send Ctrl+C first for a graceful interrupt, then kill.
        job.pty.write('\x03')
        setTimeout(() => {
          if (job.pty) {
            try {
              job.pty.kill()
            } catch {
              // gone
            }
          }
        }, 800)
      } catch {
        try {
          job.pty.kill()
        } catch {
          // gone
        }
      }
      return
    }
    if (job.child) {
      const pid = job.child.pid
      killTree(pid, job.child)
    }
  }

  /** Create an empty job tab (no command). Used by the "+" control. */
  createJob(
    sessionId: string,
    workspaceCwd: string,
    name?: string
  ): { ok: boolean; error?: string; jobId?: string; snapshot?: TermSnapshot } {
    const s = this.ensureSession(sessionId, workspaceCwd)
    if (s.jobs.size >= MAX_JOBS) {
      return { ok: false, error: `At most ${MAX_JOBS} terminal jobs per session.` }
    }
    const jid = id()
    const job: Job = {
      id: jid,
      name: (name || `job-${s.jobs.size + 1}`).slice(0, 24),
      cwd: workspaceCwd,
      buffer: '',
      running: false
    }
    s.jobs.set(jid, job)
    s.activeJobId = jid
    if (s.mode === 'pty') {
      const r = this.ensurePty(s, job)
      if (!r.ok) {
        s.jobs.delete(jid)
        const first = s.jobs.keys().next().value as string
        s.activeJobId = first
        return { ok: false, error: r.error }
      }
    } else {
      this.append(s, job, `$ # ${job.name} ready in ${job.cwd}\n`)
    }
    this.emit({
      sessionId: s.sessionId,
      jobId: jid,
      chunk: '',
      jobs: this.jobsList(s)
    })
    return { ok: true, jobId: jid, snapshot: this.snapshotOf(s) }
  }

  closeJob(sessionId: string, jobId: string): TermSnapshot | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    // Always keep at least one job tab.
    if (s.jobs.size <= 1) return this.snapshotOf(s)
    const job = s.jobs.get(jobId)
    if (!job) return this.snapshotOf(s)

    // Force-stop anything running — closing a tab should not leave orphans.
    if (job.pty) {
      try {
        job.pty.kill()
      } catch {
        // ignore
      }
      job.pty = null
      job.running = false
    }
    if (job.child) {
      killTree(job.child.pid, job.child)
      job.child = null
      job.running = false
    }

    saveBufferDisk(sessionId, jobId, job.buffer)
    s.jobs.delete(jobId)
    try {
      fs.unlinkSync(bufferFile(sessionId, jobId))
    } catch {
      // ignore
    }
    if (s.activeJobId === jobId) {
      s.activeJobId = s.jobs.keys().next().value as string
    }
    this.emit({
      sessionId,
      jobId,
      chunk: '',
      jobs: this.jobsList(s)
    })
    return this.snapshotOf(s)
  }

  setActiveJob(sessionId: string, jobId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || !s.jobs.has(jobId)) return
    s.activeJobId = jobId
  }

  clear(sessionId: string, jobId?: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    const job = this.getJob(s, jobId)
    if (!job) return
    job.buffer = ''
    saveBufferDisk(sessionId, job.id, '')
    // Soft clear for PTY display (doesn't kill the shell).
    if (job.pty) {
      try {
        job.pty.write('\x0c') // form feed / clear for many shells
      } catch {
        // ignore
      }
    }
    this.emit({ sessionId, jobId: job.id, chunk: '\x1b[2J\x1b[H' })
  }

  restart(
    sessionId: string,
    workspaceCwd: string,
    jobId?: string
  ): { ok: boolean; error?: string; jobId?: string } {
    const s = this.ensureSession(sessionId, workspaceCwd)
    const job = this.getJob(s, jobId)
    if (!job?.command) return { ok: false, error: 'No previous command to restart.' }
    if (job.running) this.kill(sessionId, job.id)
    // Brief delay so the kill settles before re-run.
    // Synchronous path: if still running after kill signal, refuse.
    if (job.running && s.mode === 'spawn') {
      return { ok: false, error: 'Still stopping previous process — try again in a moment.' }
    }
    return this.run(sessionId, workspaceCwd, job.command, { jobId: job.id })
  }

  snapshot(sessionId: string, workspaceCwd?: string): TermSnapshot {
    if (workspaceCwd) return this.snapshotOf(this.ensureSession(sessionId, workspaceCwd))
    const s = this.sessions.get(sessionId)
    if (!s) {
      return {
        sessionId,
        mode: loadPty() ? 'pty' : 'spawn',
        jobs: [],
        activeJobId: '',
        buffers: {},
        history: loadHistory(sessionId),
        shell: resolveShell().label,
        workspaceCwd: workspaceCwd || ''
      }
    }
    return this.snapshotOf(s)
  }

  history(sessionId: string): string[] {
    const s = this.sessions.get(sessionId)
    return s ? s.history.slice() : loadHistory(sessionId)
  }

  openExternal(workspaceCwd: string): void {
    // Open the OS file manager is wrong; open a system terminal at cwd.
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', workspaceCwd], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    if (process.platform === 'win32') {
      const shell = resolveShell()
      spawn(shell.file, shell.args, {
        cwd: workspaceCwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      }).unref()
      // Also try Windows Terminal if present.
      try {
        spawn('wt.exe', ['-d', workspaceCwd], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch {
        // ignore
      }
      return
    }
    // Linux: try common terminals.
    for (const [bin, args] of [
      ['x-terminal-emulator', [] as string[]],
      ['gnome-terminal', [`--working-directory=${workspaceCwd}`]],
      ['konsole', [`--workdir`, workspaceCwd]],
      ['xterm', [] as string[]]
    ] as [string, string[]][]) {
      try {
        const child = spawn(bin, args, {
          cwd: workspaceCwd,
          detached: true,
          stdio: 'ignore'
        })
        child.on('error', () => undefined)
        child.unref()
        break
      } catch {
        // try next
      }
    }
  }

  /** Pin an agent bash command into a named terminal job (user can watch it). */
  pinAgentCommand(
    sessionId: string,
    workspaceCwd: string,
    command: string,
    name = 'agent'
  ): { ok: boolean; jobId?: string; error?: string } {
    return this.run(sessionId, workspaceCwd, command, { newJob: true, name })
  }

  killAll(): void {
    for (const s of this.sessions.values()) {
      for (const job of s.jobs.values()) {
        if (job.running) this.kill(s.sessionId, job.id)
        if (job.pty) {
          try {
            job.pty.kill()
          } catch {
            // ignore
          }
        }
        saveBufferDisk(s.sessionId, job.id, job.buffer)
      }
    }
  }
}

export const termManager = new TermManager()
