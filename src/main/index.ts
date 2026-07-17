import { BrowserWindow, Notification, app, session as electronSession, shell } from 'electron'
import path from 'node:path'
import { initLogging, logger } from './logger'
import { fixPath } from './shell-path'
import { buildMenu } from './menu'
import { initUpdater, isInstallingUpdate } from './updater'
import { registerIpc } from './ipc'
import { termManager } from './panels'
import { sessionStore } from './sessions'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Conduit',
    // Transparent under the vibrancy layer on macOS; solid elsewhere.
    backgroundColor: isMac ? '#00000000' : '#111113',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    // Frosted-glass window behind the translucent sidebar (native Mac feel).
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
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

  // A crashed renderer (e.g. hostile/heavy HTML in the preview iframe) should
  // come back as a reload, not a dead white window. The timestamp guard stops
  // a page that crashes on load from turning into a reload loop.
  let lastRendererReload = 0
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger('app').error(`renderer gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit') return
    if (Date.now() - lastRendererReload < 10_000) return
    lastRendererReload = Date.now()
    mainWindow?.webContents.reload()
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

  app.whenReady().then(async () => {
    initLogging()

    // Must precede registerIpc: that kicks off the MCP sync, which spawns
    // servers directly (no shell) and so needs the user's real PATH.
    await fixPath()

    // Deny all renderer permission requests (camera, geolocation, etc.) — the
    // app needs none of them.
    electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    sessionStore.init()
    registerIpc(() => mainWindow)
    termManager.init(() => mainWindow, (sessionId, jobName, command, exitCode) => {
      try {
        if (!Notification.isSupported()) return
        if (mainWindow?.isFocused()) return
        const title =
          exitCode === 0 || exitCode === null
            ? `Terminal · ${jobName} finished`
            : `Terminal · ${jobName} exited ${exitCode}`
        const n = new Notification({
          title,
          body: (command || '').slice(0, 140),
          silent: false
        })
        n.on('click', () => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('menu:action', `focus-session:${sessionId}`)
          mainWindow.webContents.send('menu:action', 'open-terminal')
        })
        n.show()
      } catch {
        // ignore
      }
    })
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
  // macOS normally keeps the app alive with no windows; during an update
  // install we must quit so electron-updater can replace the app bundle.
  if (process.platform !== 'darwin' || isInstallingUpdate) app.quit()
})

// Don't leave terminal-panel processes running after the app exits.
app.on('before-quit', () => termManager.killAll())

// GPU/utility process crashes restart automatically — but log them so
// "the preview went blank" is diagnosable from main.log.
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') {
    logger('app').warn(`${details.type} process gone: ${details.reason} (exit ${details.exitCode})`)
  }
})
