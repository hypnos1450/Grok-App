import { BrowserWindow, app, session as electronSession, shell } from 'electron'
import path from 'node:path'
import { initLogging, logger } from './logger'
import { buildMenu } from './menu'
import { initUpdater } from './updater'
import { registerIpc } from './ipc'
import { termManager } from './panels'
import { sessionStore } from './sessions'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Grok Harness',
    backgroundColor: '#111113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer runs sandboxed; all privileged work goes through the
      // context-isolated preload bridge and validated IPC handlers.
      sandbox: true
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the system browser, never in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Safety net: block in-place navigation away from the app (e.g. a plain
  // <a href> click) and send it to the system browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isOwnUrl =
      url === mainWindow?.webContents.getURL() ||
      url.startsWith('file:') ||
      (process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL']))
    if (!isOwnUrl) {
      event.preventDefault()
      if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance lock: focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    initLogging()

    // Deny all renderer permission requests (camera, geolocation, etc.) — the
    // app needs none of them.
    electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    sessionStore.init()
    registerIpc(() => mainWindow)
    termManager.init(() => mainWindow)
    buildMenu(() => mainWindow)
    createWindow()
    initUpdater(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    logger('app').info('ready')
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leave terminal-panel processes running after the app exits.
app.on('before-quit', () => termManager.killAll())
