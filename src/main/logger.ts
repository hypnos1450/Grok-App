// Central logging: structured, rotated file logs under userData/logs plus
// console mirroring in dev. Wraps electron-log so the whole app has one sink,
// and installs global handlers so nothing dies silently in production.
import { app, crashReporter } from 'electron'
import log from 'electron-log/main'
import path from 'node:path'

type ScopedLogger = ReturnType<typeof log.scope>

let initialized = false

export function initLogging(): void {
  if (initialized) return
  initialized = true

  log.transports.file.level = 'info'
  log.transports.console.level = process.env['ELECTRON_RENDERER_URL'] ? 'debug' : 'warn'
  // Rotate at 5 MB; electron-log keeps one .old file per log.
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs', 'main.log')

  // Route uncaught errors and unhandled rejections through the logger and keep
  // the app alive rather than letting the default handler tear it down.
  log.errorHandler.startCatching({ showDialog: false })
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason)
  })

  // Native crash dumps (renderer/GPU process crashes) collected locally.
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false })
  } catch (err) {
    log.warn('crashReporter unavailable', err)
  }

  log.info(`Grok Harness ${app.getVersion()} starting on ${process.platform}`)
}

export function logsDirectory(): string {
  return path.join(app.getPath('userData'), 'logs')
}

/** Scoped logger so call sites read like `logger('oauth').info(...)`. */
export function logger(scope: string): ScopedLogger {
  return log.scope(scope)
}

export default log
