// Auto-update via electron-updater against GitHub Releases. Checks on launch
// and hourly; the renderer is notified so it can prompt the user to install.
//
// macOS note: CI builds are currently ad-hoc / unsigned (no CSC_LINK). Gatekeeper
// stamps com.apple.quarantine on every download/update, so we strip it on launch
// and use a custom install path that clears quarantine before relaunch. The real
// fix is Developer ID signing + notarization (see build/README.md).
import { BrowserWindow, app, ipcMain } from 'electron'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronUpdater from 'electron-updater'
import { logger } from './logger'

const { autoUpdater } = electronUpdater
const log = logger('updater')

/** True while quitAndInstall is in progress — lets index.ts force-quit on macOS. */
export let isInstallingUpdate = false

/** Strip Gatekeeper quarantine so unsigned/ad-hoc builds can launch after update. */
function clearQuarantine(targetPath: string): void {
  if (process.platform !== 'darwin') return
  try {
    execFileSync('xattr', ['-cr', targetPath], { stdio: 'ignore' })
    log.info('cleared quarantine on', targetPath)
  } catch (err) {
    log.warn('xattr clear failed', err instanceof Error ? err.message : err)
  }
}

/**
 * electron-updater's Mac path feeds the zip to Squirrel.Mac, which re-applies
 * quarantine on unsigned apps. For ad-hoc builds, unzip ourselves, strip
 * quarantine, swap into place, and relaunch.
 */
function installMacUpdateManually(zipPath: string): boolean {
  const appPath = app.getPath('exe')
  // .../Grok Harness.app/Contents/MacOS/Grok Harness → .../Grok Harness.app
  const appBundle = path.resolve(appPath, '..', '..', '..')
  if (!appBundle.endsWith('.app') || !fs.existsSync(zipPath)) {
    log.warn('manual mac install: bad paths', { appBundle, zipPath })
    return false
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-update-'))
  try {
    log.info('manual mac install from', zipPath, '→', appBundle)
    execFileSync('ditto', ['-x', '-k', zipPath, staging], { stdio: 'pipe' })

    const extracted = fs
      .readdirSync(staging)
      .map((n) => path.join(staging, n))
      .find((p) => p.endsWith('.app') && fs.statSync(p).isDirectory())
    if (!extracted) {
      log.error('manual mac install: no .app in zip')
      return false
    }

    clearQuarantine(extracted)

    // Replace the running bundle. ditto merges; remove first for a clean swap.
    const backup = `${appBundle}.updating`
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true })
    fs.renameSync(appBundle, backup)
    try {
      execFileSync('ditto', [extracted, appBundle], { stdio: 'pipe' })
      clearQuarantine(appBundle)
      fs.rmSync(backup, { recursive: true, force: true })
    } catch (err) {
      // Roll back if the swap failed mid-way.
      log.error('manual mac install swap failed', err instanceof Error ? err.message : err)
      if (!fs.existsSync(appBundle) && fs.existsSync(backup)) {
        fs.renameSync(backup, appBundle)
      }
      return false
    }

    // Relaunch the new binary, then exit this process.
    const bin = path.join(appBundle, 'Contents', 'MacOS', path.basename(appPath))
    const child = spawn(bin, [], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return true
  } catch (err) {
    log.error('manual mac install failed', err instanceof Error ? err.message : err)
    return false
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

function getDownloadedZipPath(): string | null {
  // electron-updater keeps the file on DownloadedUpdateHelper; not in public types.
  const helper = (autoUpdater as unknown as { downloadedUpdateHelper?: { file?: string | null } })
    .downloadedUpdateHelper
  const file = helper?.file
  return file && fs.existsSync(file) ? file : null
}

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  // Unsigned Mac builds always pick up quarantine after download/update.
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const appBundle = path.resolve(app.getPath('exe'), '..', '..', '..')
      if (appBundle.endsWith('.app')) clearQuarantine(appBundle)
    } catch {
      // ignore
    }
  }

  // Download in the background; only install when the user clicks Restart.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = log as unknown as typeof autoUpdater.logger
  // Channel: 'latest' (stable) or 'beta' — matches electron-builder publish.
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { updateChannel?: string; autoUpdate?: boolean }
      if (s.updateChannel === 'beta' || s.updateChannel === 'latest') {
        autoUpdater.channel = s.updateChannel
        autoUpdater.allowPrerelease = s.updateChannel === 'beta'
      }
      if (s.autoUpdate === false) {
        // Still allow manual check; just skip the interval below via flag.
      }
    }
  } catch {
    /* ignore */
  }

  let downloadedVersion: string | null = null
  let autoCheck = true
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { autoUpdate?: boolean }
      if (s.autoUpdate === false) autoCheck = false
    }
  } catch {
    /* ignore */
  }

  const senderOk = (e: Electron.IpcMainInvokeEvent): boolean => {
    const win = getWindow()
    return !!win && e.sender === win.webContents
  }
  const handle = (
    channel: string,
    fn: (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!senderOk(e)) throw new Error('IPC rejected: untrusted sender')
      return fn(e, ...args)
    })
  }

  const send = (channel: string, payload?: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) => {
    log.info('update available', info.version)
    send('update:available', { version: info.version, ready: false })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('update downloaded', info.version)
    downloadedVersion = info.version
    // Clear quarantine on the cached zip so Squirrel/manual install is cleaner.
    const zip = getDownloadedZipPath()
    if (zip) clearQuarantine(zip)
    send('update:downloaded', {
      version: info.version,
      notes: info.releaseNotes,
      ready: true
    })
  })
  autoUpdater.on('error', (err) => {
    log.warn('update error', err?.message ?? err)
  })

  handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo?.version }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('update:install', () => {
    if (!downloadedVersion) {
      log.warn('install requested but no update downloaded yet')
      return { ok: false, error: 'Update is still downloading' }
    }
    log.info('user requested quitAndInstall', downloadedVersion)
    isInstallingUpdate = true

    setImmediate(() => {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          win.removeAllListeners('close')
          win.destroy()
        }

        // Prefer manual install on mac so we can strip quarantine before relaunch.
        if (process.platform === 'darwin') {
          const zip = getDownloadedZipPath()
          if (zip && installMacUpdateManually(zip)) {
            app.exit(0)
            return
          }
          log.warn('manual mac install unavailable — falling back to quitAndInstall')
        }

        autoUpdater.quitAndInstall(false, true)
        setTimeout(() => {
          log.warn('quitAndInstall did not exit — forcing app.exit')
          app.exit(0)
        }, 3000)
      } catch (err) {
        log.error('quitAndInstall failed', err instanceof Error ? err.message : err)
        app.exit(0)
      }
    })
    return { ok: true }
  })

  handle('update:getChannel', () => autoUpdater.channel || 'latest')
  handle('update:setChannel', (_e, channel: unknown) => {
    const ch = channel === 'beta' ? 'beta' : 'latest'
    autoUpdater.channel = ch
    autoUpdater.allowPrerelease = ch === 'beta'
    log.info('update channel set to', ch)
    return ch
  })

  if (!app.isPackaged) {
    log.info('dev build — skipping update checks')
    return
  }

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('check failed', err?.message ?? err))
  }
  if (autoCheck) {
    setTimeout(check, 8000)
    setInterval(check, 60 * 60 * 1000)
  }
}
