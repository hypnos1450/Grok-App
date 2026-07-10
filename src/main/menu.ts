// Native application menu with standard accelerators. Menu actions that map
// to in-app behavior are forwarded to the renderer over the `menu:action`
// channel; the renderer decides what they do in the current view.
import { BrowserWindow, Menu, MenuItemConstructorOptions, app, shell } from 'electron'
import { logsDirectory } from './logger'

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'
  const send = (action: string): void => getWindow()?.webContents.send('menu:action', action)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => send('new-session') },
        {
          label: 'Switch Session…',
          accelerator: 'CmdOrCtrl+K',
          click: () => send('switch-session')
        },
        { type: 'separator' },
        {
          label: 'Export Session…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send('export-session')
        },
        ...(isMac
          ? [{ role: 'close' as const }]
          : [
              { label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings') },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => send('stop-agent') },
        { label: 'Focus Message Input', accelerator: 'CmdOrCtrl+L', click: () => send('focus-input') },
        { type: 'separator' },
        {
          label: 'Toggle Plan-Only Mode',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('toggle-plan-only')
        },
        { label: 'Create GitHub Pull Request…', click: () => send('create-pr') }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => send('command-palette')
        },
        {
          label: 'Search Sessions…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => send('search-sessions')
        },
        { type: 'separator' },
        { label: 'Open Terminal Panel', click: () => send('open-terminal') },
        { label: 'Open Review Panel', click: () => send('open-review') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [])]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Reveal Logs', click: () => void shell.openPath(logsDirectory()) },
        { label: 'Copy Diagnostics…', click: () => send('copy-diagnostics') },
        { label: 'Check for Updates…', click: () => send('check-update') },
        {
          label: 'xAI Status',
          click: () => void shell.openExternal('https://status.x.ai')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
