// Auto-update via electron-updater against GitHub Releases. Checks on launch
// and hourly; the renderer is notified so it can prompt the user to install.
import { BrowserWindow, app, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { logger } from './logger'

const { autoUpdater } = electronUpdater
const log = logger('updater')

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  // Never auto-install behind the user's back; we download, then let them choose.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = log as unknown as typeof autoUpdater.logger

  const send = (channel: string, payload?: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) => {
    log.info('update available', info.version)
    send('update:available', { version: info.version })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('update downloaded', info.version)
    send('update:downloaded', { version: info.version, notes: info.releaseNotes })
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
    // quitAndInstall replaces the app; the downloaded update is applied on relaunch.
    autoUpdater.quitAndInstall()
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
