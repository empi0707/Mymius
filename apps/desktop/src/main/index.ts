import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { Channels, type AppInfo, type OS } from '../shared/ipc'

const isMac = process.platform === 'darwin'

function createWindow(): void {
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

  // The renderer only ever shows our own UI. Anything else opens in the user's browser or not at all.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.handle(Channels.appInfo, (): AppInfo => ({
  name: app.getName(),
  version: app.getVersion(),
  os: process.platform as OS,
  arch: process.arch,
  secureStorage: safeStorage.isEncryptionAvailable()
}))

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// macOS apps stay alive without windows; everywhere else closing the last window quits.
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
