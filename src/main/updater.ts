// Auto-update via electron-updater against GitHub Releases. Checks on launch
// and hourly; the renderer is notified so it can prompt the user to install.
import { BrowserWindow, app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { logger } from './logger'

const { autoUpdater } = electronUpdater
const log = logger('updater')

/** True while quitAndInstall is in progress — lets index.ts force-quit on macOS. */
export let isInstallingUpdate = false

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  // Download in the background; only install when the user clicks Restart.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = log as unknown as typeof autoUpdater.logger

  let downloadedVersion: string | null = null

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
    send('update:downloaded', {
      version: info.version,
      notes: info.releaseNotes,
      ready: true
    })
  })
  autoUpdater.on('error', (err) => {
    log.warn('update error', err?.message ?? err)
  })

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      return { ok: true, version: result?.updateInfo?.version }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('update:install', () => {
    if (!downloadedVersion) {
      log.warn('install requested but no update downloaded yet')
      return { ok: false, error: 'Update is still downloading' }
    }
    log.info('user requested quitAndInstall', downloadedVersion)
    isInstallingUpdate = true
    // Defer so the IPC reply can flush. On macOS, quitAndInstall often no-ops
    // unless windows are closed first and isForceRunAfter is true.
    setImmediate(() => {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          win.removeAllListeners('close')
          // destroy() skips the close event path that can keep the app alive on darwin.
          win.destroy()
        }
        // isSilent=false, isForceRunAfter=true → relaunch after install (needed on macOS).
        autoUpdater.quitAndInstall(false, true)
        // If Squirrel/mac updater fails to exit (common on unsigned builds),
        // force the process out so autoInstallOnAppQuit / next launch can recover.
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

  // Updates only work in a packaged (and, on mac, signed) build.
  if (!app.isPackaged) {
    log.info('dev build — skipping update checks')
    return
  }

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('check failed', err?.message ?? err))
  }
  // Delay the first check so it doesn't compete with startup work.
  setTimeout(check, 8000)
  setInterval(check, 60 * 60 * 1000)
}
