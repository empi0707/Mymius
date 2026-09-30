import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { Channels, type AppInfo, type OS } from '../shared/ipc'
import { TerminalService } from './terminals'

const isMac = process.platform === 'darwin'

let terminals: TerminalService

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // macOS: traffic lights inset into our own title bar. Windows/Linux keep the native frame for now.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // The renderer only ever shows our own UI. Links clicked in a terminal open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  const id = win.webContents.id
  win.on('closed', () => terminals.closeOwnedBy(id))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function registerIpc(): void {
  ipcMain.handle(Channels.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    os: process.platform as OS,
    arch: process.arch,
    secureStorage: safeStorage.isEncryptionAvailable()
  }))

  ipcMain.handle(Channels.pickPrivateKey, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Choose a private key', properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[] }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  ipcMain.handle(Channels.terminalOpen, (e, req: unknown) => terminals.open(e.sender.id, req))
  ipcMain.on(Channels.terminalWrite, (e, id: unknown, data: unknown) => terminals.write(e.sender.id, id, data))
  ipcMain.on(Channels.terminalResize, (e, id: unknown, c: unknown, r: unknown) => terminals.resize(e.sender.id, id, c, r))
  ipcMain.on(Channels.terminalAck, (e, id: unknown, n: unknown) => terminals.ack(e.sender.id, id, n))
  ipcMain.on(Channels.terminalClose, (e, id: unknown) => terminals.close(e.sender.id, id))
}

void app.whenReady().then(() => {
  terminals = new TerminalService({
    knownHostsFile: join(app.getPath('userData'), 'known_hosts.json'),
    confirmHostKey: async (info) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = {
        type: 'question' as const,
        buttons: ['Cancel', 'Trust and connect'],
        defaultId: 0, // Enter must not accept an unverified host
        cancelId: 0,
        title: 'Unknown host',
        message: `The authenticity of ${info.host}${info.port === 22 ? '' : `:${info.port}`} can't be established.`,
        detail: `Key fingerprint:\n${info.fingerprint}\n\nOnly continue if you recognise this fingerprint.`
      }
      const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return r.response === 1
    },
    sendData: (target, e) => webContentsById(target)?.send(Channels.terminalData, e),
    sendExit: (target, e) => webContentsById(target)?.send(Channels.terminalExit, e)
  })
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function webContentsById(id: number): Electron.WebContents | undefined {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)?.webContents
}

app.on('before-quit', () => terminals?.closeAll())

// macOS apps stay alive without windows; everywhere else closing the last window quits.
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
